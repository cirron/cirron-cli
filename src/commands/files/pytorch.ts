import fs from 'fs-extra';
import path from 'path';
import getModelCode, { getModelClassName } from './models';
import getDataLoaderCode from './data';

export async function createPyTorchFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
    // Requirements with M1/M2 Mac compatibility
    const requirements = `torch>=2.0.0
torchvision>=0.15.0
numpy>=1.21.0,<1.26.0
scikit-learn>=1.3.0
matplotlib>=3.5.0
tqdm>=4.64.0
Pillow>=9.0.0
requests>=2.28.0
  `;
  
    await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
    
    // Create model.yaml configuration
    const modelConfig = `# Model Configuration for PyTorch
version: 1
name: "${options.modelType || 'pytorch'}_model"
architecture: "${getModelClassName(options.modelType)}"
framework: pytorch
modelType: "${options.modelType || 'classification'}"

parameters:
  total: 50000  # Estimated, will be updated after training
  trainable: 50000
  nonTrainable: 0

inputShape: "(batch, channels, height, width)"
outputShape: "${options.modelType === 'regression' ? '(batch, 1)' : '(batch, num_classes)'}"

training:
  epochs: 10
  batchSize: 32
  learningRate: 0.001
  optimizer: "adam"
  loss: "${options.modelType === 'regression' ? 'mse' : 'cross_entropy'}"
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
  description: "PyTorch ${options.modelType || 'classification'} model"
  created: "${new Date().toISOString()}"
  tags:
    - "pytorch"
    - "${options.modelType || 'classification'}"

dependencies:
  python: ">=3.8"
  packages:
    torch: ">=2.0.0"
    torchvision: ">=0.15.0"
    numpy: ">=1.21.0"
`;

    await fs.writeFile(path.join(projectPath, 'model.yaml'), modelConfig);
  
    // Create src structure
    await fs.ensureDir(path.join(projectPath, 'src'));
  
    // Model definition
    const modelCode = getModelCode('pytorch', options.modelType);
    await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);
  
    // Inference script
    const inferenceCode = `import torch
  import torch.nn.functional as F
  from PIL import Image
  import numpy as np
  from model import ${getModelClassName(options.modelType)}
  
  class ModelInference:
      def __init__(self, model_path: str = None):
          self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
          self.model = ${getModelClassName(options.modelType)}()
          
          if model_path:
              self.load_model(model_path)
          
          self.model.to(self.device)
          self.model.eval()
      
      def load_model(self, model_path: str):
          """Load trained model weights"""
          checkpoint = torch.load(model_path, map_location=self.device)
          self.model.load_state_dict(checkpoint['model_state_dict'])
          print(f"Model loaded from {model_path}")
      
      def preprocess(self, input_data):
          """Preprocess input data"""
          # TODO: Implement preprocessing based on your model type
          if isinstance(input_data, Image.Image):
              # For image inputs
              input_data = input_data.resize((224, 224))
              input_tensor = torch.tensor(np.array(input_data)).float()
              input_tensor = input_tensor.permute(2, 0, 1).unsqueeze(0)
          else:
              # For other data types
              input_tensor = torch.tensor(input_data).float()
              if len(input_tensor.shape) == 1:
                  input_tensor = input_tensor.unsqueeze(0)
          
          return input_tensor.to(self.device)
      
      def predict(self, input_data):
          """Make prediction"""
          with torch.no_grad():
              input_tensor = self.preprocess(input_data)
              output = self.model(input_tensor)
              
              # Apply appropriate activation based on model type
              if hasattr(self.model, 'num_classes') and self.model.num_classes > 1:
                  predictions = F.softmax(output, dim=1)
              else:
                  predictions = output
              
              return predictions.cpu().numpy()
  
  if __name__ == "__main__":
      # Example usage
      inference = ModelInference()
      
      # TODO: Replace with actual input
      sample_input = torch.randn(1, 3, 224, 224)  # Example for image input
      result = inference.predict(sample_input)
      print(f"Prediction: {result}")
  `;
  
    await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);
  
    // Data loader
    await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('pytorch', options.modelType));
}
  
export async function createPyTorchTrainingFiles(projectPath: string, projectName: string, options: any): Promise<void> {
    await createPyTorchFiles(projectPath, projectName, options);
    
    // Training script
    const trainingCode = `import torch
  import torch.nn as nn
  import torch.optim as optim
  from torch.utils.data import DataLoader
  import os
  from tqdm import tqdm
  
  from model import ${getModelClassName(options.modelType)}
  from data_loader import get_data_loaders
  
  class Trainer:
      def __init__(self, config):
          self.config = config
          self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
          
          # Initialize model
          self.model = ${getModelClassName(options.modelType)}()
          self.model.to(self.device)
          
          # Loss and optimizer
          self.criterion = self.get_criterion()
          self.optimizer = optim.Adam(self.model.parameters(), lr=config['learning_rate'])
          
          # Data loaders
          self.train_loader, self.val_loader = get_data_loaders(config)
          
          # Metrics
          self.train_losses = []
          self.val_losses = []
      
      def get_criterion(self):
          """Get appropriate loss function"""
          if self.config['model_type'] == 'classification':
              return nn.CrossEntropyLoss()
          elif self.config['model_type'] == 'regression':
              return nn.MSELoss()
          else:
              return nn.MSELoss()  # Default
      
      def train_epoch(self):
          """Train for one epoch"""
          self.model.train()
          total_loss = 0
          
          for batch_idx, (data, target) in enumerate(tqdm(self.train_loader, desc="Training")):
              data, target = data.to(self.device), target.to(self.device)
              
              self.optimizer.zero_grad()
              output = self.model(data)
              loss = self.criterion(output, target)
              loss.backward()
              self.optimizer.step()
              
              total_loss += loss.item()
          
          return total_loss / len(self.train_loader)
      
      def validate(self):
          """Validate the model"""
          self.model.eval()
          total_loss = 0
          correct = 0
          
          with torch.no_grad():
              for data, target in tqdm(self.val_loader, desc="Validation"):
                  data, target = data.to(self.device), target.to(self.device)
                  output = self.model(data)
                  loss = self.criterion(output, target)
                  total_loss += loss.item()
                  
                  # Calculate accuracy for classification
                  if self.config['model_type'] == 'classification':
                      pred = output.argmax(dim=1, keepdim=True)
                      correct += pred.eq(target.view_as(pred)).sum().item()
          
          avg_loss = total_loss / len(self.val_loader)
          accuracy = correct / len(self.val_loader.dataset) if self.config['model_type'] == 'classification' else None
          
          return avg_loss, accuracy
      
      def save_checkpoint(self, epoch, val_loss, is_best=False):
          """Save model checkpoint"""
          os.makedirs('checkpoints', exist_ok=True)
          
          checkpoint = {
              'epoch': epoch,
              'model_state_dict': self.model.state_dict(),
              'optimizer_state_dict': self.optimizer.state_dict(),
              'val_loss': val_loss,
              'config': self.config
          }
          
          checkpoint_path = f'checkpoints/checkpoint_epoch_{epoch}.pth'
          torch.save(checkpoint, checkpoint_path)
          
          if is_best:
              torch.save(checkpoint, 'checkpoints/best_model.pth')
      
      def train(self):
          """Main training loop"""
          best_val_loss = float('inf')
          
          for epoch in range(self.config['num_epochs']):
              print(f"\\nEpoch {epoch+1}/{self.config['num_epochs']}")
              
              # Train
              train_loss = self.train_epoch()
              self.train_losses.append(train_loss)
              
              # Validate
              val_loss, accuracy = self.validate()
              self.val_losses.append(val_loss)
              
              # Print metrics
              print(f"Train Loss: {train_loss:.4f}, Val Loss: {val_loss:.4f}")
              if accuracy is not None:
                  print(f"Val Accuracy: {accuracy:.4f}")
              
              # Save checkpoint
              is_best = val_loss < best_val_loss
              if is_best:
                  best_val_loss = val_loss
              
              self.save_checkpoint(epoch, val_loss, is_best)
  
  if __name__ == "__main__":
      config = {
          'batch_size': 32,
          'learning_rate': 0.001,
          'num_epochs': 10,
          'model_type': '${options.modelType}',
          'data_path': 'data/',
      }
      
      trainer = Trainer(config)
      trainer.train()
  `;
  
    await fs.writeFile(path.join(projectPath, 'src', 'train.py'), trainingCode);
}