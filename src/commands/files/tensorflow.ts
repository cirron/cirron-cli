import { dump as dumpYaml } from "js-yaml";
import { dedent } from "../../utils/dedent";
import {
  buildOnnxServeScript,
  buildSyntheticTabularServingConfig,
  writeProjectFiles,
} from "./shared";

const TF_REQUIREMENTS = dedent(`
  tensorflow>=2.18.0
  tf2onnx>=1.16.1
  numpy>=2.1.0
  onnxruntime>=1.20.0
`);

function buildTensorflowTrainScript(
  modelType: string,
  withTrainingLoop: boolean
): string {
  const isRegression = modelType === "regression";
  const finalUnits = isRegression ? "1" : "2";
  const lossName = isRegression ? '"mse"' : '"sparse_categorical_crossentropy"';
  const finalActivation = isRegression ? "None" : '"softmax"';
  const yDtype = isRegression ? "np.float32" : "np.int64";
  const epochs = withTrainingLoop ? "10" : "3";
  const yExpr = isRegression
    ? "(X @ rng.normal(size=NUM_FEATURES).astype(np.float32) + rng.normal(scale=0.1, size=n).astype(np.float32))"
    : "(X.sum(axis=1) > 0).astype(np.int64)";

  return dedent(`
    """Train a small Keras model and export to ONNX for serving."""
    import os
    import numpy as np
    import tensorflow as tf
    import tf2onnx

    ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
    NUM_FEATURES = 10


    def make_synthetic_data(n: int = 1000, seed: int = 42):
        rng = np.random.default_rng(seed)
        X = rng.normal(size=(n, NUM_FEATURES)).astype(np.float32)
        y = ${yExpr}
        return X, y.astype(${yDtype})


    def build_model():
        inputs = tf.keras.Input(shape=(NUM_FEATURES,), name="input")
        x = tf.keras.layers.Dense(64, activation="relu")(inputs)
        x = tf.keras.layers.Dropout(0.2)(x)
        outputs = tf.keras.layers.Dense(${finalUnits}, activation=${finalActivation})(x)
        return tf.keras.Model(inputs, outputs)


    def train():
        X, y = make_synthetic_data()
        model = build_model()
        model.compile(optimizer="adam", loss=${lossName}, metrics=["accuracy"] if "categorical" in ${lossName} else None)
        print("Training...")
        model.fit(X, y, epochs=${epochs}, batch_size=32, verbose=2)

        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        onnx_path = os.path.join(ARTIFACTS_DIR, "model.onnx")
        spec = (tf.TensorSpec((None, NUM_FEATURES), tf.float32, name="input"),)
        tf2onnx.convert.from_keras(model, input_signature=spec, output_path=onnx_path)
        print(f"ONNX model exported to {onnx_path}")


    if __name__ == "__main__":
        train()
  `);
}

function buildCirronYaml(
  projectName: string,
  modelType: string,
  description: string
): string {
  const cfg = {
    name: projectName,
    framework: "tensorflow",
    type: modelType,
    version: "1.0.0",
    description,
    servingConfig: buildSyntheticTabularServingConfig("onnx", modelType),
  };
  return dumpYaml(cfg, { indent: 2, lineWidth: 100, noRefs: true });
}

export async function createTensorFlowFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string }
): Promise<void> {
  const description = `TensorFlow ${options.modelType} scaffold from Cirron CLI. Trains a small Keras model and exports to ONNX.`;
  await writeProjectFiles(projectPath, {
    "cirron.yaml": buildCirronYaml(projectName, options.modelType, description),
    "requirements.txt": TF_REQUIREMENTS,
    "train.py": buildTensorflowTrainScript(options.modelType, false),
    "serve.py": buildOnnxServeScript(),
  });
}

export async function createTensorFlowTrainingFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string }
): Promise<void> {
  const description = `TensorFlow ${options.modelType} training scaffold from Cirron CLI. 10-epoch training loop, exports to ONNX.`;
  await writeProjectFiles(projectPath, {
    "cirron.yaml": buildCirronYaml(projectName, options.modelType, description),
    "requirements.txt": TF_REQUIREMENTS,
    "train.py": buildTensorflowTrainScript(options.modelType, true),
    "serve.py": buildOnnxServeScript(),
  });
}
