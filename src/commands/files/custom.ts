import fs from 'fs-extra';
import path from 'path';
import getDataLoaderCode from './data';
import { dedent } from '../../utils/dedent';

export async function createCustomFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  const requirements = dedent(`
    numpy>=2.1.0
    pandas>=2.2.0
    scikit-learn>=1.5.0
    matplotlib>=3.9.0
    requests>=2.32.0
  `);

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);

  const modelType = options.modelType || 'custom';

  const modelConfig = dedent(`
    # Model Configuration for Custom Framework
    version: 1
    name: "custom_model"
    architecture: "CustomModel"
    framework: custom
    modelType: "${modelType}"

    parameters:
      total: 1000  # Update based on your model
      trainable: 1000
      nonTrainable: 0

    inputShape: "(samples, features)"  # Update based on your input
    outputShape: "(samples, outputs)"  # Update based on your output

    training:
      epochs: 10
      batchSize: 32
      learningRate: 0.001

    inference:
      device: "cpu"
      precision: "fp32"
      batchSize: 1

    data:
      inputFormat: "custom"
      outputFormat: "custom"
      preprocessing:
        - "custom_preprocessing"

    metadata:
      description: "Custom model implementation - modify as needed"
      created: "${new Date().toISOString()}"
      tags:
        - "custom"
        - "${modelType}"

    dependencies:
      python: ">=3.11"
      packages:
        numpy: ">=2.1.0"
        pandas: ">=2.2.0"
  `);

  await fs.writeFile(path.join(projectPath, 'model.yaml'), modelConfig);
  await fs.ensureDir(path.join(projectPath, 'src'));

  const modelCode = dedent(`
    """Custom model implementation. Modify this file to fit your architecture."""


    class CustomModel:
        def __init__(self):
            # Initialize your model here.
            pass

        def train(self, X, y):
            """Train the model."""
            raise NotImplementedError

        def predict(self, X):
            """Make predictions."""
            raise NotImplementedError

        def save(self, filepath):
            """Save the model."""
            raise NotImplementedError

        def load(self, filepath):
            """Load a saved model."""
            raise NotImplementedError


    def create_model():
        """Factory for model instances."""
        return CustomModel()
  `);

  await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);

  const inferenceCode = dedent(`
    from model import create_model


    class ModelInference:
        def __init__(self, model_path: str = None):
            self.model = create_model()

            if model_path:
                self.load_model(model_path)

        def load_model(self, model_path: str):
            """Load a trained model."""
            self.model.load(model_path)
            print(f"Model loaded from {model_path}")

        def predict(self, input_data):
            """Make a prediction."""
            return self.model.predict(input_data)


    if __name__ == "__main__":
        inference = ModelInference()
        sample_input = [1, 2, 3, 4, 5]
        result = inference.predict(sample_input)
        print(f"Prediction: {result}")
  `);

  await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);
  await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('custom', options.modelType));
}
