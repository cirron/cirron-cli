import yaml from "js-yaml";
import { dedent } from "../../utils/dedent";
import {
  buildSklearnJoblibServeScript,
  buildSyntheticTabularServingConfig,
  writeProjectFiles,
} from "./shared";

const CUSTOM_REQUIREMENTS = dedent(`
  scikit-learn>=1.5.0
  numpy>=2.1.0
  joblib>=1.4.0
`);

const CUSTOM_TRAIN_SCRIPT = dedent(`
  """Custom-framework scaffold.

  Trains a minimal sklearn stub on synthetic data so the artifact is
  loadable end-to-end via serve.py. Replace the model + training logic
  with your own framework while keeping the joblib output contract.
  """
  import os
  import joblib
  import numpy as np
  from sklearn.ensemble import RandomForestClassifier

  ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
  FEATURE_NAMES = [f"feature{i + 1}" for i in range(10)]


  def make_synthetic_data(n: int = 500, seed: int = 42):
      rng = np.random.default_rng(seed)
      X = rng.normal(size=(n, len(FEATURE_NAMES)))
      y = (X.sum(axis=1) > 0).astype(int)
      return X, y


  def train():
      print("Generating synthetic data...")
      X, y = make_synthetic_data()

      model = RandomForestClassifier(n_estimators=50, random_state=42)
      model.fit(X, y)

      os.makedirs(ARTIFACTS_DIR, exist_ok=True)
      model_path = os.path.join(ARTIFACTS_DIR, "model.joblib")
      joblib.dump(model, model_path)
      print(f"Stub model saved to {model_path}")


  if __name__ == "__main__":
      train()
`);

function buildCirronYaml(projectName: string, modelType: string): string {
  const cfg = {
    name: projectName,
    framework: "custom",
    type: modelType,
    version: "1.0.0",
    description: `Custom ${modelType} scaffold from Cirron CLI. Stubbed with a sklearn model so the joblib serving contract works end-to-end.`,
    servingConfig: buildSyntheticTabularServingConfig(
      "sklearn-joblib",
      modelType
    ),
  };
  return yaml.dump(cfg, { indent: 2, lineWidth: 100, noRefs: true });
}

export async function createCustomFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string }
): Promise<void> {
  await writeProjectFiles(projectPath, {
    "cirron.yaml": buildCirronYaml(projectName, options.modelType),
    "requirements.txt": CUSTOM_REQUIREMENTS,
    "train.py": CUSTOM_TRAIN_SCRIPT,
    "serve.py": buildSklearnJoblibServeScript(),
  });
}
