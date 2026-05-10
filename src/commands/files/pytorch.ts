import fs from 'fs-extra';
import path from 'path';
import getModelCode, { getModelClassName } from './models';
import getDataLoaderCode from './data';
import { dedent } from '../../utils/dedent';

export async function createPyTorchFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  const requirements = dedent(`
    torch>=2.5.0
    torchvision>=0.20.0
    numpy>=2.1.0
    scikit-learn>=1.5.0
    matplotlib>=3.9.0
    tqdm>=4.66.0
    Pillow>=10.4.0
    requests>=2.32.0
  `);

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);

  const modelClassName = getModelClassName(options.modelType);
  const modelType = options.modelType || 'classification';
  const modelName = options.modelType || 'pytorch';
  const lossName = options.modelType === 'regression' ? 'mse' : 'cross_entropy';
  const outputShape = options.modelType === 'regression' ? '(batch, 1)' : '(batch, num_classes)';

  const modelConfig = dedent(`
    # Model Configuration for PyTorch
    version: 1
    name: "${modelName}_model"
    architecture: "${modelClassName}"
    framework: pytorch
    modelType: "${modelType}"

    parameters:
      total: 50000  # Estimated, will be updated after training
      trainable: 50000
      nonTrainable: 0

    inputShape: "(batch, channels, height, width)"
    outputShape: "${outputShape}"

    training:
      epochs: 10
      batchSize: 32
      learningRate: 0.001
      optimizer: "adam"
      loss: "${lossName}"
      metrics:
        - "accuracy"
        - "loss"

    inference:
      device: "cpu"
      precision: "fp32"
      batchSize: 1

    data:
      inputFormat: "tensor"
      outputFormat: "probabilities"
      preprocessing:
        - "resize"
        - "normalize"
        - "to_tensor"

    metadata:
      description: "PyTorch ${modelType} model"
      created: "${new Date().toISOString()}"
      tags:
        - "pytorch"
        - "${modelType}"

    dependencies:
      python: ">=3.11"
      packages:
        torch: ">=2.5.0"
        torchvision: ">=0.20.0"
        numpy: ">=2.1.0"
  `);

  await fs.writeFile(path.join(projectPath, 'model.yaml'), modelConfig);

  await fs.ensureDir(path.join(projectPath, 'src'));

  const modelCode = getModelCode('pytorch', options.modelType);
  await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);

  const inferenceCode = dedent(`
    import torch
    import torch.nn.functional as F
    from PIL import Image
    import numpy as np
    from model import ${modelClassName}


    class ModelInference:
        def __init__(self, model_path: str = None):
            self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
            self.model = ${modelClassName}()

            if model_path:
                self.load_model(model_path)

            self.model.to(self.device)
            self.model.eval()

        def load_model(self, model_path: str):
            """Load trained model weights."""
            checkpoint = torch.load(model_path, map_location=self.device)
            self.model.load_state_dict(checkpoint['model_state_dict'])
            print(f"Model loaded from {model_path}")

        def preprocess(self, input_data):
            """Preprocess input data."""
            if isinstance(input_data, Image.Image):
                input_data = input_data.resize((224, 224))
                input_tensor = torch.tensor(np.array(input_data)).float()
                input_tensor = input_tensor.permute(2, 0, 1).unsqueeze(0)
            else:
                input_tensor = torch.tensor(input_data).float()
                if len(input_tensor.shape) == 1:
                    input_tensor = input_tensor.unsqueeze(0)

            return input_tensor.to(self.device)

        def predict(self, input_data):
            """Make a prediction."""
            with torch.no_grad():
                input_tensor = self.preprocess(input_data)
                output = self.model(input_tensor)

                if hasattr(self.model, 'num_classes') and self.model.num_classes > 1:
                    predictions = F.softmax(output, dim=1)
                else:
                    predictions = output

                return predictions.cpu().numpy()


    if __name__ == "__main__":
        inference = ModelInference()
        # Default ClassificationModel expects a flat feature vector (input_dim=10).
        # Swap in your real input shape once you customize the architecture.
        sample_input = torch.randn(1, 10)
        result = inference.predict(sample_input)
        print(f"Prediction: {result}")
  `);

  await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);

  await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('pytorch', options.modelType));
}

export async function createPyTorchTrainingFiles(projectPath: string, projectName: string, options: any): Promise<void> {
  await createPyTorchFiles(projectPath, projectName, options);

  const modelClassName = getModelClassName(options.modelType);
  const modelType = options.modelType || 'classification';

  const trainingCode = dedent(`
    import torch
    import torch.nn as nn
    import torch.optim as optim
    import os
    from tqdm import tqdm

    from model import ${modelClassName}
    from data_loader import get_data_loaders


    class Trainer:
        def __init__(self, config):
            self.config = config
            self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

            self.model = ${modelClassName}()
            self.model.to(self.device)

            self.criterion = self.get_criterion()
            self.optimizer = optim.Adam(self.model.parameters(), lr=config['learning_rate'])

            self.train_loader, self.val_loader = get_data_loaders(config)

            self.train_losses = []
            self.val_losses = []

        def get_criterion(self):
            """Pick a loss function for the configured model type."""
            if self.config['model_type'] == 'classification':
                return nn.CrossEntropyLoss()
            return nn.MSELoss()

        def train_epoch(self):
            """Train for one epoch."""
            self.model.train()
            total_loss = 0

            for _, (data, target) in enumerate(tqdm(self.train_loader, desc="Training")):
                data, target = data.to(self.device), target.to(self.device)

                self.optimizer.zero_grad()
                output = self.model(data)
                loss = self.criterion(output, target)
                loss.backward()
                self.optimizer.step()

                total_loss += loss.item()

            return total_loss / len(self.train_loader)

        def validate(self):
            """Run a validation pass."""
            self.model.eval()
            total_loss = 0
            correct = 0

            with torch.no_grad():
                for data, target in tqdm(self.val_loader, desc="Validation"):
                    data, target = data.to(self.device), target.to(self.device)
                    output = self.model(data)
                    loss = self.criterion(output, target)
                    total_loss += loss.item()

                    if self.config['model_type'] == 'classification':
                        pred = output.argmax(dim=1, keepdim=True)
                        correct += pred.eq(target.view_as(pred)).sum().item()

            avg_loss = total_loss / len(self.val_loader)
            accuracy = correct / len(self.val_loader.dataset) if self.config['model_type'] == 'classification' else None

            return avg_loss, accuracy

        def save_checkpoint(self, epoch, val_loss, is_best=False):
            """Persist a checkpoint to disk."""
            os.makedirs('checkpoints', exist_ok=True)

            checkpoint = {
                'epoch': epoch,
                'model_state_dict': self.model.state_dict(),
                'optimizer_state_dict': self.optimizer.state_dict(),
                'val_loss': val_loss,
                'config': self.config,
            }

            checkpoint_path = f'checkpoints/checkpoint_epoch_{epoch}.pth'
            torch.save(checkpoint, checkpoint_path)

            if is_best:
                torch.save(checkpoint, 'checkpoints/best_model.pth')

        def train(self):
            """Main training loop."""
            best_val_loss = float('inf')

            for epoch in range(self.config['num_epochs']):
                print(f"\\nEpoch {epoch + 1}/{self.config['num_epochs']}")

                train_loss = self.train_epoch()
                self.train_losses.append(train_loss)

                val_loss, accuracy = self.validate()
                self.val_losses.append(val_loss)

                print(f"Train Loss: {train_loss:.4f}, Val Loss: {val_loss:.4f}")
                if accuracy is not None:
                    print(f"Val Accuracy: {accuracy:.4f}")

                is_best = val_loss < best_val_loss
                if is_best:
                    best_val_loss = val_loss

                self.save_checkpoint(epoch, val_loss, is_best)


    if __name__ == "__main__":
        config = {
            'batch_size': 32,
            'learning_rate': 0.001,
            'num_epochs': 10,
            'model_type': '${modelType}',
            'data_path': 'data/',
        }

        trainer = Trainer(config)
        trainer.train()
  `);

  await fs.writeFile(path.join(projectPath, 'src', 'train.py'), trainingCode);
}
