import fs from "fs-extra";
import path from "path";
import { dedent } from "../../utils/dedent";

/**
 * Write a flat map of relative file paths -> contents into projectPath. Used
 * by every template file generator so each template stays declarative.
 */
export async function writeProjectFiles(
  projectPath: string,
  files: Record<string, string>
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(projectPath, relPath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
  }
}

/**
 * Build a JSON-Schema-shaped servingConfig for templates that operate on a
 * synthetic 10-feature tabular dataset (the default for sklearn / pytorch /
 * tensorflow / custom scaffolds). Modeled on housing-regressor in
 * cirron-sample-models.
 */
export function buildSyntheticTabularServingConfig(
  runtime: string,
  modelType: string
): Record<string, unknown> {
  const featureNames = Array.from({ length: 10 }, (_, i) => `feature${i + 1}`);
  const featureProperties: Record<string, unknown> = {};
  for (const name of featureNames) {
    featureProperties[name] = {
      type: "number",
      title: name,
      description: `Numeric input ${name}`,
    };
  }

  const isClassification = modelType === "classification";
  const outputProperties: Record<string, unknown> = isClassification
    ? {
        prediction: { type: "number", title: "Predicted Class" },
        probabilities: { type: "array", title: "Class Probabilities" },
      }
    : {
        prediction: { type: "number", title: "Predicted Value" },
      };

  return {
    runtime,
    feature_order: featureNames,
    input_schema: {
      type: "object",
      properties: featureProperties,
      required: featureNames,
    },
    output_schema: {
      type: "object",
      properties: outputProperties,
    },
  };
}

/**
 * Build a serve.py for sklearn-joblib runtime. Adapted from the
 * cirron-sample-models reference repo (shared/serve.py). Loads any .joblib
 * file in artifacts/ and exposes POST /inference, GET /health, GET /metadata.
 */
export function buildSklearnJoblibServeScript(): string {
  return dedent(`
    """Local serving server for sklearn-joblib artifacts.

    Same contract as the Cirron platform's sklearn-joblib runtime: drop a
    joblib-serialized model into artifacts/ and POST {"data": [...]} to
    /inference.
    """
    import glob
    import json
    import os
    import signal
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse

    import joblib
    import numpy as np
    import pandas as pd

    PORT = int(os.getenv("PORT", "8080"))
    MODEL_STORE = os.getenv("MODEL_STORE", os.path.join(os.path.dirname(__file__), "artifacts"))
    MODEL_NAME = os.getenv("MODEL_NAME", "server")
    TAG = f"[{MODEL_NAME}:{PORT}]"

    _model = None
    _model_type = None


    def load_model():
        global _model, _model_type
        if _model is not None:
            return _model

        print(f"{TAG} Loading model from: {MODEL_STORE}")
        candidates = []
        for ext in ("*.joblib", "*.pkl", "*.pickle"):
            candidates.extend(glob.glob(os.path.join(MODEL_STORE, "**", ext), recursive=True))
        if not candidates:
            raise FileNotFoundError(f"No model files found in {MODEL_STORE}")

        loaded = joblib.load(candidates[0])
        if isinstance(loaded, dict):
            for key in ("model", "estimator", "classifier", "regressor", "best_model"):
                if key in loaded:
                    loaded = loaded[key]
                    break
        _model = loaded
        _model_type = type(loaded).__name__
        print(f"{TAG} Loaded {_model_type} from {candidates[0]}")
        return _model


    def coerce_input(input_data):
        if isinstance(input_data, list):
            if not input_data:
                return np.array([])
            first = input_data[0]
            if isinstance(first, dict):
                return pd.DataFrame(input_data)
            if isinstance(first, str):
                return input_data
            return np.array(input_data)
        if isinstance(input_data, dict):
            return pd.DataFrame([input_data])
        return input_data


    def handle_inference(model, body):
        try:
            payload = json.loads(body) if isinstance(body, str) else body
            if "data" not in payload:
                return (400, {"error": "Missing required field: data"})

            X = coerce_input(payload["data"])
            predictions = model.predict(X)
            result = {
                "predictions": predictions.tolist() if hasattr(predictions, "tolist") else list(predictions),
                "model_type": _model_type,
                "num_predictions": len(predictions),
            }
            if hasattr(model, "predict_proba"):
                try:
                    probs = model.predict_proba(X)
                    result["probabilities"] = probs.tolist() if hasattr(probs, "tolist") else list(probs)
                except Exception:
                    pass
            return (200, result)
        except Exception as exc:
            return (500, {"error": "Inference failed", "message": str(exc)})


    def handle_health(model):
        return (200, {
            "status": "healthy" if model is not None else "unhealthy",
            "model_type": _model_type,
            "model_loaded": model is not None,
        })


    def handle_metadata(model):
        info = {"model_type": _model_type, "runtime": "sklearn-joblib-local"}
        if hasattr(model, "n_features_in_"):
            info["n_features"] = int(model.n_features_in_)
        if hasattr(model, "feature_names_in_"):
            info["feature_names"] = list(model.feature_names_in_)
        if hasattr(model, "classes_"):
            classes = model.classes_
            info["classes"] = classes.tolist() if hasattr(classes, "tolist") else list(classes)
        return (200, info)


    class ServingRequestHandler(BaseHTTPRequestHandler):
        def _path(self):
            return urlparse(self.path).path.rstrip("/")

        def do_GET(self):
            p = self._path()
            if p in ("/health", "/ping"):
                self._send(handle_health(self.server.model))
            elif p in ("/metadata", "/info"):
                self._send(handle_metadata(self.server.model))
            else:
                self._send((404, {"error": "Not found"}))

        def do_POST(self):
            p = self._path()
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            if p.startswith("/inference") or p.startswith("/predict"):
                self._send(handle_inference(self.server.model, body))
            else:
                self._send((404, {"error": "Not found"}))

        def _send(self, result):
            status, data = result
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            print(f"{TAG} {fmt % args}")


    def main():
        model = load_model()
        server = ThreadingHTTPServer(("0.0.0.0", PORT), ServingRequestHandler)
        server.model = model

        def shutdown(*_):
            print(f"\\n{TAG} Shutting down...")
            os._exit(0)

        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        print(f"{TAG} Serving on http://0.0.0.0:{PORT}")
        print(f"{TAG} Endpoints: POST /inference, GET /health, GET /metadata")
        server.serve_forever()


    if __name__ == "__main__":
        main()
  `);
}

/**
 * Build a serve.py that loads a model.onnx artifact via onnxruntime and
 * exposes the same /inference contract.
 */
export function buildOnnxServeScript(): string {
  return dedent(`
    """Local serving server for ONNX artifacts (pytorch / tensorflow templates)."""
    import glob
    import json
    import os
    import signal
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse

    import numpy as np
    import onnxruntime as ort

    PORT = int(os.getenv("PORT", "8080"))
    MODEL_STORE = os.getenv("MODEL_STORE", os.path.join(os.path.dirname(__file__), "artifacts"))
    MODEL_NAME = os.getenv("MODEL_NAME", "server")
    TAG = f"[{MODEL_NAME}:{PORT}]"

    _session = None
    _input_name = None


    def load_session():
        global _session, _input_name
        if _session is not None:
            return _session
        candidates = glob.glob(os.path.join(MODEL_STORE, "**", "*.onnx"), recursive=True)
        if not candidates:
            raise FileNotFoundError(f"No .onnx files found in {MODEL_STORE}")
        print(f"{TAG} Loading {candidates[0]}")
        _session = ort.InferenceSession(candidates[0], providers=["CPUExecutionProvider"])
        _input_name = _session.get_inputs()[0].name
        return _session


    def coerce_input(input_data):
        if isinstance(input_data, dict):
            input_data = [input_data]
        if isinstance(input_data, list) and input_data and isinstance(input_data[0], dict):
            keys = sorted(input_data[0].keys())
            return np.array([[row[k] for k in keys] for row in input_data], dtype=np.float32)
        return np.asarray(input_data, dtype=np.float32)


    def handle_inference(session, body):
        try:
            payload = json.loads(body) if isinstance(body, str) else body
            if "data" not in payload:
                return (400, {"error": "Missing required field: data"})

            X = coerce_input(payload["data"])
            outputs = session.run(None, {_input_name: X})
            primary = outputs[0]
            return (200, {
                "predictions": primary.tolist(),
                "num_predictions": len(primary),
                "runtime": "onnx-local",
            })
        except Exception as exc:
            return (500, {"error": "Inference failed", "message": str(exc)})


    def handle_health(session):
        return (200, {
            "status": "healthy" if session is not None else "unhealthy",
            "model_loaded": session is not None,
        })


    def handle_metadata(session):
        info = {"runtime": "onnx-local"}
        if session is not None:
            info["inputs"] = [
                {"name": i.name, "shape": [str(d) for d in i.shape], "type": i.type}
                for i in session.get_inputs()
            ]
            info["outputs"] = [
                {"name": o.name, "shape": [str(d) for d in o.shape], "type": o.type}
                for o in session.get_outputs()
            ]
        return (200, info)


    class ServingRequestHandler(BaseHTTPRequestHandler):
        def _path(self):
            return urlparse(self.path).path.rstrip("/")

        def do_GET(self):
            p = self._path()
            if p in ("/health", "/ping"):
                self._send(handle_health(self.server.session))
            elif p in ("/metadata", "/info"):
                self._send(handle_metadata(self.server.session))
            else:
                self._send((404, {"error": "Not found"}))

        def do_POST(self):
            p = self._path()
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            if p.startswith("/inference") or p.startswith("/predict"):
                self._send(handle_inference(self.server.session, body))
            else:
                self._send((404, {"error": "Not found"}))

        def _send(self, result):
            status, data = result
            body = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            print(f"{TAG} {fmt % args}")


    def main():
        session = load_session()
        server = ThreadingHTTPServer(("0.0.0.0", PORT), ServingRequestHandler)
        server.session = session

        def shutdown(*_):
            print(f"\\n{TAG} Shutting down...")
            os._exit(0)

        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        print(f"{TAG} Serving on http://0.0.0.0:{PORT}")
        print(f"{TAG} Endpoints: POST /inference, GET /health, GET /metadata")
        server.serve_forever()


    if __name__ == "__main__":
        main()
  `);
}
