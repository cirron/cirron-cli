import yaml from 'js-yaml';
import { dedent } from '../../utils/dedent';
import {
  buildSklearnJoblibServeScript,
  buildSyntheticTabularServingConfig,
  writeProjectFiles,
} from './shared';

const SKLEARN_REQUIREMENTS = dedent(`
  scikit-learn>=1.5.0
  pandas>=2.2.0
  numpy>=2.1.0
  joblib>=1.4.0
`);

function buildSklearnTrainScript(modelType: string): string {
  if (modelType === 'regression') {
    return dedent(`
      """Train a sklearn regression model on synthetic tabular data."""
      import os
      import joblib
      import numpy as np
      from sklearn.ensemble import GradientBoostingRegressor
      from sklearn.model_selection import train_test_split
      from sklearn.metrics import mean_squared_error, r2_score

      ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
      FEATURE_NAMES = [f"feature{i + 1}" for i in range(10)]


      def make_synthetic_data(n: int = 1000, seed: int = 42):
          rng = np.random.default_rng(seed)
          X = rng.normal(size=(n, len(FEATURE_NAMES)))
          weights = rng.normal(size=len(FEATURE_NAMES))
          y = X @ weights + rng.normal(scale=0.1, size=n)
          return X, y


      def train():
          print("Generating synthetic data...")
          X, y = make_synthetic_data()
          X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

          print(f"Training samples: {len(X_train)}")
          model = GradientBoostingRegressor(n_estimators=100, max_depth=3, random_state=42)
          model.fit(X_train, y_train)

          y_pred = model.predict(X_test)
          print(f"R2 Score: {r2_score(y_test, y_pred):.4f}")
          print(f"RMSE: {np.sqrt(mean_squared_error(y_test, y_pred)):.4f}")

          os.makedirs(ARTIFACTS_DIR, exist_ok=True)
          model_path = os.path.join(ARTIFACTS_DIR, "model.joblib")
          joblib.dump(model, model_path)
          print(f"Model saved to {model_path}")


      if __name__ == "__main__":
          train()
    `);
  }

  return dedent(`
    """Train a sklearn classification model on synthetic tabular data."""
    import os
    import joblib
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report

    ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
    FEATURE_NAMES = [f"feature{i + 1}" for i in range(10)]


    def make_synthetic_data(n: int = 1000, seed: int = 42):
        rng = np.random.default_rng(seed)
        X = rng.normal(size=(n, len(FEATURE_NAMES)))
        y = (X.sum(axis=1) > 0).astype(int)
        return X, y


    def train():
        print("Generating synthetic data...")
        X, y = make_synthetic_data()
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

        print(f"Training samples: {len(X_train)}")
        model = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
        model.fit(X_train, y_train)

        y_pred = model.predict(X_test)
        print("\\nClassification Report:")
        print(classification_report(y_test, y_pred))

        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        model_path = os.path.join(ARTIFACTS_DIR, "model.joblib")
        joblib.dump(model, model_path)
        print(f"Model saved to {model_path}")


    if __name__ == "__main__":
        train()
  `);
}

function buildSklearnPipelineTrainScript(modelType: string): string {
  if (modelType === 'regression') {
    return dedent(`
      """Train a sklearn pipeline (scaler + regressor) on synthetic tabular data."""
      import os
      import joblib
      import numpy as np
      from sklearn.ensemble import GradientBoostingRegressor
      from sklearn.model_selection import train_test_split, cross_val_score
      from sklearn.pipeline import Pipeline
      from sklearn.preprocessing import StandardScaler
      from sklearn.metrics import mean_squared_error, r2_score

      ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
      FEATURE_NAMES = [f"feature{i + 1}" for i in range(10)]


      def make_synthetic_data(n: int = 1000, seed: int = 42):
          rng = np.random.default_rng(seed)
          X = rng.normal(size=(n, len(FEATURE_NAMES)))
          weights = rng.normal(size=len(FEATURE_NAMES))
          y = X @ weights + rng.normal(scale=0.1, size=n)
          return X, y


      def train():
          print("Generating synthetic data...")
          X, y = make_synthetic_data()
          X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

          pipeline = Pipeline([
              ("scaler", StandardScaler()),
              ("regressor", GradientBoostingRegressor(n_estimators=100, max_depth=3, random_state=42)),
          ])

          print("Training pipeline...")
          pipeline.fit(X_train, y_train)

          cv_scores = cross_val_score(pipeline, X_train, y_train, cv=5, scoring="r2")
          print(f"CV R2: {cv_scores.mean():.4f} (+/- {cv_scores.std() * 2:.4f})")

          y_pred = pipeline.predict(X_test)
          print(f"Test R2: {r2_score(y_test, y_pred):.4f}")
          print(f"Test RMSE: {np.sqrt(mean_squared_error(y_test, y_pred)):.4f}")

          os.makedirs(ARTIFACTS_DIR, exist_ok=True)
          model_path = os.path.join(ARTIFACTS_DIR, "model.joblib")
          joblib.dump(pipeline, model_path)
          print(f"Pipeline saved to {model_path}")


      if __name__ == "__main__":
          train()
    `);
  }

  return dedent(`
    """Train a sklearn pipeline (scaler + classifier) on synthetic tabular data."""
    import os
    import joblib
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import train_test_split, cross_val_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import classification_report

    ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
    FEATURE_NAMES = [f"feature{i + 1}" for i in range(10)]


    def make_synthetic_data(n: int = 1000, seed: int = 42):
        rng = np.random.default_rng(seed)
        X = rng.normal(size=(n, len(FEATURE_NAMES)))
        y = (X.sum(axis=1) > 0).astype(int)
        return X, y


    def train():
        print("Generating synthetic data...")
        X, y = make_synthetic_data()
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

        pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("classifier", RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)),
        ])

        print("Training pipeline...")
        pipeline.fit(X_train, y_train)

        cv_scores = cross_val_score(pipeline, X_train, y_train, cv=5)
        print(f"CV accuracy: {cv_scores.mean():.4f} (+/- {cv_scores.std() * 2:.4f})")

        y_pred = pipeline.predict(X_test)
        print("\\nClassification Report:")
        print(classification_report(y_test, y_pred))

        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        model_path = os.path.join(ARTIFACTS_DIR, "model.joblib")
        joblib.dump(pipeline, model_path)
        print(f"Pipeline saved to {model_path}")


    if __name__ == "__main__":
        train()
  `);
}

function buildCirronYaml(projectName: string, modelType: string, description: string): string {
  const cfg = {
    name: projectName,
    framework: 'sklearn',
    type: modelType,
    version: '1.0.0',
    description,
    servingConfig: buildSyntheticTabularServingConfig('sklearn-joblib', modelType),
  };
  return yaml.dump(cfg, { indent: 2, lineWidth: 100, noRefs: true });
}

export async function createSklearnFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string },
): Promise<void> {
  const description = `Sklearn ${options.modelType} model scaffolded by Cirron CLI.`;
  await writeProjectFiles(projectPath, {
    'cirron.yaml': buildCirronYaml(projectName, options.modelType, description),
    'requirements.txt': SKLEARN_REQUIREMENTS,
    'train.py': buildSklearnTrainScript(options.modelType),
    'serve.py': buildSklearnJoblibServeScript(),
  });
}

export async function createSklearnPipelineFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string },
): Promise<void> {
  const description = `Sklearn ${options.modelType} pipeline (scaler + estimator) scaffolded by Cirron CLI.`;
  await writeProjectFiles(projectPath, {
    'cirron.yaml': buildCirronYaml(projectName, options.modelType, description),
    'requirements.txt': SKLEARN_REQUIREMENTS,
    'train.py': buildSklearnPipelineTrainScript(options.modelType),
    'serve.py': buildSklearnJoblibServeScript(),
  });
}

