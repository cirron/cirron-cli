import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import type { InitOptions, ProjectConfig, Template } from '../types';

const TEMPLATES: Record<string, Template> = {
  pytorch: {
    name: 'PyTorch',
    description: 'PyTorch model with training and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  tensorflow: {
    name: 'TensorFlow',
    description: 'TensorFlow/Keras model with training and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  sklearn: {
    name: 'Scikit-Learn',
    description: 'Scikit-learn model with preprocessing and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'pytorch-train': {
    name: 'PyTorch Training',
    description: 'PyTorch training pipeline with data loading',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'tensorflow-train': {
    name: 'TensorFlow Training',
    description: 'TensorFlow training pipeline with data loading',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'sklearn-pipeline': {
    name: 'Scikit-Learn Pipeline',
    description: 'Full ML pipeline with preprocessing and training',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  custom: {
    name: 'Custom Framework',
    description: 'Blank Python project for any ML framework',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  }
};

const MODEL_TYPES = {
  classification: 'Classification',
  regression: 'Regression',
  computer_vision: 'Computer Vision',
  nlp: 'Natural Language Processing',
  time_series: 'Time Series',
  custom: 'Custom'
};

export async function initCommand(projectName?: string, options: InitOptions = { template: 'pytorch' }): Promise<void> {
  try {
    // Get project name if not provided
    if (!projectName) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Project name:',
          default: 'my-ml-project',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Project name is required';
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
              return 'Project name can only contain letters, numbers, hyphens, and underscores';
            }
            return true;
          }
        }
      ]);
      projectName = answers.name;
    }

    const projectPath = path.resolve(process.cwd(), projectName!);

    // Check if directory exists and is not empty
    if (fs.existsSync(projectPath)) {
      const files = fs.readdirSync(projectPath);
      if (files.length > 0 && !options.force) {
        const answers = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continue',
            message: `Directory ${projectName} is not empty. Continue anyway?`,
            default: false
          }
        ]);
        
        if (!answers.continue) {
          logger.info('Initialization cancelled');
          return;
        }
      }
    }

    // Template and model type selection
    let template = options.template;
    let modelType = 'classification';
    let includeSampleData = false;
    let includeNotebook = false;

    if (!TEMPLATES[template]) {
      const templateAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'template',
          message: 'Choose a framework:',
          choices: Object.entries(TEMPLATES).map(([key, template]) => ({
            name: `${template.name} - ${template.description}`,
            value: key
          }))
        },
        {
          type: 'list',
          name: 'modelType',
          message: 'Choose model type:',
          choices: Object.entries(MODEL_TYPES).map(([key, name]) => ({
            name,
            value: key
          }))
        },
        {
          type: 'confirm',
          name: 'includeSampleData',
          message: 'Include sample data?',
          default: true
        },
        {
          type: 'confirm',
          name: 'includeNotebook',
          message: 'Include Jupyter notebook?',
          default: true
        }
      ]);
      
      template = templateAnswers.template;
      modelType = templateAnswers.modelType;
      includeSampleData = templateAnswers.includeSampleData;
      includeNotebook = templateAnswers.includeNotebook;
    }

    const selectedTemplate = TEMPLATES[template];
    if (!selectedTemplate) {
      throw new Error(`Unknown template: ${template}`);
    }
    
    const spinner = ora(`Creating ${selectedTemplate.name} project...`).start();

    try {
      // Create project directory
      await fs.ensureDir(projectPath);

      // Create project files based on template
      await createProjectFiles(projectPath, projectName!, template, {
        modelType,
        includeSampleData,
        includeNotebook
      });

      // Initialize git if requested
      if (options.git) {
        spinner.text = 'Initializing git repository...';
        try {
          execSync('git init', { cwd: projectPath, stdio: 'pipe' });
          execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
          execSync('git commit -m "Initial commit"', { cwd: projectPath, stdio: 'pipe' });
          logger.info('Git repository initialized');
        } catch (error) {
          logger.warn('Failed to initialize git repository');
        }
      }

      // Install dependencies if requested
      if (options.install && selectedTemplate.postInstall && selectedTemplate.postInstall.length > 0) {
        spinner.text = 'Installing dependencies...';
        for (const command of selectedTemplate.postInstall) {
          try {
            execSync(command, { cwd: projectPath, stdio: 'pipe' });
          } catch (error) {
            logger.warn(`Failed to run: ${command}`);
          }
        }
      }

      // Register project with Cirron API (if authenticated)
      const config = new ConfigManager();
      const currentConfig = config.load();
      
      if (currentConfig.token) {
        spinner.text = 'Registering project with Cirron...';
        try {
          const api = new CirronApi(currentConfig);
          await api.createProject({
            name: projectName!,
            template,
            path: projectPath
          });
          logger.info('Project registered with Cirron');
        } catch (error) {
          logger.warn('Failed to register project with Cirron (continuing anyway)');
        }
      }

      spinner.succeed(chalk.green(`Project ${projectName} created successfully!`));

      // Show next steps
      console.log();
      logger.info(chalk.bold('Next steps:'));
      logger.info(`  ${chalk.cyan(`cd ${projectName}`)}`);
      
      if (!options.install && selectedTemplate.postInstall && selectedTemplate.postInstall.length > 0) {
        logger.info(`  ${chalk.cyan('pip install -r requirements.txt')}`);
      }
      
      logger.info(`  ${chalk.cyan('cirron test')}`);
      logger.info(`  ${chalk.cyan('cirron build')}`);
      logger.info(`  ${chalk.cyan('cirron deploy')}`);

      if (!currentConfig.token) {
        console.log();
        logger.info(chalk.yellow('💡 Tip: Run ') + chalk.cyan('cirron auth login') + chalk.yellow(' to connect to Cirron'));
      }

    } catch (error) {
      spinner.fail(chalk.red('Project creation failed'));
      throw error;
    }

  } catch (error) {
    logger.error('Failed to initialize project:', error);
    process.exit(1);
  }
}

async function createProjectFiles(
  projectPath: string, 
  projectName: string, 
  template: string,
  options: {
    modelType: string;
    includeSampleData: boolean;
    includeNotebook: boolean;
  }
): Promise<void> {
  // Create cirron.json
  const projectConfig: ProjectConfig = {
    name: projectName,
    version: '1.0.0',
    template,
    framework: template.includes('pytorch') ? 'pytorch' : 
               template.includes('tensorflow') ? 'tensorflow' :
               template.includes('sklearn') ? 'sklearn' : 'custom',
    modelType: options.modelType,
    pythonVersion: '3.9',
    gpuRequired: false,
    environments: {
      development: {
        name: 'development',
        url: 'http://localhost:8000'
      },
      staging: {
        name: 'staging'
      },
      production: {
        name: 'production'
      }
    },
    build: {
      outputDir: 'dist',
      command: 'docker build -t ${PROJECT_NAME} .',
      include: ['src/**', 'requirements.txt', 'Dockerfile'],
      exclude: ['*.pyc', '__pycache__', '.pytest_cache', 'data/raw/**']
    },
    deploy: {
      provider: 'custom',
      settings: {
        containerRegistry: 'harbor',
        imageTag: '${VERSION}'
      }
    },
    artifacts: {
      modelPath: 'models/',
      checkpointPath: 'checkpoints/',
      logsPath: 'logs/'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'cirron.json'), projectConfig, { spaces: 2 });

  // Create template-specific files
  switch (template) {
    case 'pytorch':
      await createPyTorchFiles(projectPath, projectName, options);
      break;
    case 'pytorch-train':
      await createPyTorchTrainingFiles(projectPath, projectName, options);
      break;
    case 'tensorflow':
      await createTensorFlowFiles(projectPath, projectName, options);
      break;
    case 'tensorflow-train':
      await createTensorFlowTrainingFiles(projectPath, projectName, options);
      break;
    case 'sklearn':
      await createSklearnFiles(projectPath, projectName, options);
      break;
    case 'sklearn-pipeline':
      await createSklearnPipelineFiles(projectPath, projectName, options);
      break;
    case 'custom':
      await createCustomFiles(projectPath, projectName, options);
      break;
  }

  // Create common ML files
  await createCommonMLFiles(projectPath, projectName, options);
}

async function createPyTorchFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  // Requirements
  const requirements = `torch>=2.0.0
torchvision>=0.15.0
numpy>=1.21.0
scikit-learn>=1.3.0
matplotlib>=3.5.0
tqdm>=4.64.0
Pillow>=9.0.0
requests>=2.28.0
`;

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);

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

async function createPyTorchTrainingFiles(projectPath: string, projectName: string, options: any): Promise<void> {
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

async function createTensorFlowFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  const requirements = `tensorflow>=2.12.0
numpy>=1.21.0
scikit-learn>=1.3.0
matplotlib>=3.5.0
Pillow>=9.0.0
requests>=2.28.0
`;

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
  await fs.ensureDir(path.join(projectPath, 'src'));

  const modelCode = getModelCode('tensorflow', options.modelType);
  await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);

  const inferenceCode = `import tensorflow as tf
import numpy as np
from PIL import Image
from model import create_model

class ModelInference:
    def __init__(self, model_path: str = None):
        self.model = create_model()
        
        if model_path:
            self.load_model(model_path)
    
    def load_model(self, model_path: str):
        """Load trained model weights"""
        self.model.load_weights(model_path)
        print(f"Model loaded from {model_path}")
    
    def preprocess(self, input_data):
        """Preprocess input data"""
        if isinstance(input_data, Image.Image):
            input_data = input_data.resize((224, 224))
            input_array = np.array(input_data) / 255.0
            input_array = np.expand_dims(input_array, axis=0)
        else:
            input_array = np.array(input_data)
            if len(input_array.shape) == 1:
                input_array = np.expand_dims(input_array, axis=0)
        
        return input_array.astype(np.float32)
    
    def predict(self, input_data):
        """Make prediction"""
        input_tensor = self.preprocess(input_data)
        predictions = self.model.predict(input_tensor)
        return predictions

if __name__ == "__main__":
    inference = ModelInference()
    
    # Example usage
    sample_input = np.random.randn(224, 224, 3)
    result = inference.predict(sample_input)
    print(f"Prediction: {result}")
`;

  await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);
  await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('tensorflow', options.modelType));
}

async function createTensorFlowTrainingFiles(projectPath: string, projectName: string, options: any): Promise<void> {
  await createTensorFlowFiles(projectPath, projectName, options);
  
  const trainingCode = `import tensorflow as tf
import numpy as np
import os
from model import create_model
from data_loader import get_data_loaders

class Trainer:
    def __init__(self, config):
        self.config = config
        self.model = create_model()
        
        # Compile model
        self.compile_model()
        
        # Data loaders
        self.train_dataset, self.val_dataset = get_data_loaders(config)
        
        # Callbacks
        self.callbacks = self.get_callbacks()
    
    def compile_model(self):
        """Compile the model with appropriate loss and metrics"""
        if self.config['model_type'] == 'classification':
            loss = 'sparse_categorical_crossentropy'
            metrics = ['accuracy']
        elif self.config['model_type'] == 'regression':
            loss = 'mse'
            metrics = ['mae']
        else:
            loss = 'mse'
            metrics = ['mae']
        
        self.model.compile(
            optimizer=tf.keras.optimizers.Adam(learning_rate=self.config['learning_rate']),
            loss=loss,
            metrics=metrics
        )
    
    def get_callbacks(self):
        """Setup training callbacks"""
        callbacks = []
        
        # Model checkpoint
        os.makedirs('checkpoints', exist_ok=True)
        checkpoint_callback = tf.keras.callbacks.ModelCheckpoint(
            filepath='checkpoints/best_model.h5',
            save_best_only=True,
            monitor='val_loss',
            mode='min'
        )
        callbacks.append(checkpoint_callback)
        
        # Early stopping
        early_stop_callback = tf.keras.callbacks.EarlyStopping(
            monitor='val_loss',
            patience=5,
            restore_best_weights=True
        )
        callbacks.append(early_stop_callback)
        
        return callbacks
    
    def train(self):
        """Train the model"""
        history = self.model.fit(
            self.train_dataset,
            validation_data=self.val_dataset,
            epochs=self.config['num_epochs'],
            callbacks=self.callbacks,
            verbose=1
        )
        
        return history

if __name__ == "__main__":
    config = {
        'batch_size': 32,
        'learning_rate': 0.001,
        'num_epochs': 10,
        'model_type': '${options.modelType}',
        'data_path': 'data/',
    }
    
    trainer = Trainer(config)
    history = trainer.train()
    
    # Save final model
    trainer.model.save('models/final_model.h5')
    print("Training completed!")
`;

  await fs.writeFile(path.join(projectPath, 'src', 'train.py'), trainingCode);
}

async function createSklearnFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  const requirements = `scikit-learn>=1.3.0
numpy>=1.21.0
pandas>=1.5.0
matplotlib>=3.5.0
seaborn>=0.11.0
joblib>=1.2.0
`;

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
  await fs.ensureDir(path.join(projectPath, 'src'));

  const modelCode = getModelCode('sklearn', options.modelType);
  await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);

  const inferenceCode = `import joblib
import numpy as np
import pandas as pd
from model import create_model, preprocess_data

class ModelInference:
    def __init__(self, model_path: str = None):
        self.model = create_model()
        self.preprocessor = None
        
        if model_path:
            self.load_model(model_path)
    
    def load_model(self, model_path: str):
        """Load trained model"""
        saved_objects = joblib.load(model_path)
        self.model = saved_objects['model']
        self.preprocessor = saved_objects.get('preprocessor', None)
        print(f"Model loaded from {model_path}")
    
    def preprocess(self, input_data):
        """Preprocess input data"""
        if isinstance(input_data, dict):
            input_data = pd.DataFrame([input_data])
        elif isinstance(input_data, list):
            input_data = pd.DataFrame(input_data)
        
        if self.preprocessor:
            input_data = self.preprocessor.transform(input_data)
        
        return input_data
    
    def predict(self, input_data):
        """Make prediction"""
        processed_data = self.preprocess(input_data)
        predictions = self.model.predict(processed_data)
        return predictions
    
    def predict_proba(self, input_data):
        """Get prediction probabilities (for classification)"""
        if hasattr(self.model, 'predict_proba'):
            processed_data = self.preprocess(input_data)
            probabilities = self.model.predict_proba(processed_data)
            return probabilities
        else:
            raise ValueError("Model does not support probability predictions")

if __name__ == "__main__":
    inference = ModelInference()
    
    # Example usage
    sample_input = {'feature1': 1.0, 'feature2': 2.0}  # Replace with actual features
    result = inference.predict(sample_input)
    print(f"Prediction: {result}")
`;

  await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);
  await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('sklearn', options.modelType));
}

async function createSklearnPipelineFiles(projectPath: string, projectName: string, options: any): Promise<void> {
  await createSklearnFiles(projectPath, projectName, options);
  
  const trainingCode = `import pandas as pd
import numpy as np
import joblib
import os
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, mean_squared_error, r2_score
from model import create_model, preprocess_data
from data_loader import load_data

class Trainer:
    def __init__(self, config):
        self.config = config
        self.model = create_model()
        self.preprocessor = None
        
        # Load data
        self.X, self.y = load_data(config['data_path'])
        
        # Split data
        self.X_train, self.X_test, self.y_train, self.y_test = train_test_split(
            self.X, self.y, test_size=0.2, random_state=42
        )
    
    def preprocess_data(self):
        """Preprocess the data"""
        self.X_train_processed, self.preprocessor = preprocess_data(self.X_train, fit=True)
        self.X_test_processed, _ = preprocess_data(self.X_test, self.preprocessor, fit=False)
    
    def train(self):
        """Train the model"""
        print("Preprocessing data...")
        self.preprocess_data()
        
        print("Training model...")
        self.model.fit(self.X_train_processed, self.y_train)
        
        # Cross-validation
        cv_scores = cross_val_score(self.model, self.X_train_processed, self.y_train, cv=5)
        print(f"Cross-validation scores: {cv_scores}")
        print(f"Mean CV score: {cv_scores.mean():.4f} (+/- {cv_scores.std() * 2:.4f})")
        
        # Test set evaluation
        y_pred = self.model.predict(self.X_test_processed)
        
        if self.config['model_type'] == 'classification':
            print("\\nClassification Report:")
            print(classification_report(self.y_test, y_pred))
        else:
            mse = mean_squared_error(self.y_test, y_pred)
            r2 = r2_score(self.y_test, y_pred)
            print(f"\\nTest MSE: {mse:.4f}")
            print(f"Test R²: {r2:.4f}")
    
    def save_model(self, filepath='models/model.joblib'):
        """Save the trained model and preprocessor"""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        
        model_data = {
            'model': self.model,
            'preprocessor': self.preprocessor,
            'config': self.config
        }
        
        joblib.dump(model_data, filepath)
        print(f"Model saved to {filepath}")

if __name__ == "__main__":
    config = {
        'model_type': '${options.modelType}',
        'data_path': 'data/sample_data.csv',
    }
    
    trainer = Trainer(config)
    trainer.train()
    trainer.save_model()
    print("Training completed!")
`;

  await fs.writeFile(path.join(projectPath, 'src', 'train.py'), trainingCode);
}

async function createCustomFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
  const requirements = `numpy>=1.21.0
pandas>=1.5.0
scikit-learn>=1.3.0
matplotlib>=3.5.0
requests>=2.28.0
`;

  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
  await fs.ensureDir(path.join(projectPath, 'src'));

  const modelCode = `"""
Custom model implementation
Modify this file to implement your specific model architecture
"""

class CustomModel:
    def __init__(self):
        # Initialize your model here
        pass
    
    def train(self, X, y):
        """Train the model"""
        # Implement training logic
        pass
    
    def predict(self, X):
        """Make predictions"""
        # Implement prediction logic
        pass
    
    def save(self, filepath):
        """Save the model"""
        # Implement model saving
        pass
    
    def load(self, filepath):
        """Load a saved model"""
        # Implement model loading
        pass

def create_model():
    """Factory function to create model instance"""
    return CustomModel()
`;

  await fs.writeFile(path.join(projectPath, 'src', 'model.py'), modelCode);

  const inferenceCode = `from model import create_model

class ModelInference:
    def __init__(self, model_path: str = None):
        self.model = create_model()
        
        if model_path:
            self.load_model(model_path)
    
    def load_model(self, model_path: str):
        """Load trained model"""
        self.model.load(model_path)
        print(f"Model loaded from {model_path}")
    
    def predict(self, input_data):
        """Make prediction"""
        predictions = self.model.predict(input_data)
        return predictions

if __name__ == "__main__":
    inference = ModelInference()
    
    # Example usage - modify based on your model
    sample_input = [1, 2, 3, 4, 5]  # Replace with actual input format
    result = inference.predict(sample_input)
    print(f"Prediction: {result}")
`;

  await fs.writeFile(path.join(projectPath, 'src', 'inference.py'), inferenceCode);
  await fs.writeFile(path.join(projectPath, 'src', 'data_loader.py'), getDataLoaderCode('custom', options.modelType));
}

async function createCommonMLFiles(projectPath: string, projectName: string, options: any): Promise<void> {
  // Create directory structure
  await fs.ensureDir(path.join(projectPath, 'tests'));
  await fs.ensureDir(path.join(projectPath, 'models'));
  await fs.ensureDir(path.join(projectPath, 'checkpoints'));
  await fs.ensureDir(path.join(projectPath, 'logs'));
  
  if (options.includeSampleData) {
    await fs.ensureDir(path.join(projectPath, 'data', 'sample'));
    await createSampleData(projectPath, options.modelType);
  }
  
  if (options.includeNotebook) {
    await fs.ensureDir(path.join(projectPath, 'notebooks'));
    await createNotebook(projectPath, projectName, options);
  }

  // Dockerfile
  const dockerfile = `FROM python:3.9-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \\
    build-essential \\
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ ./src/
COPY models/ ./models/

# Expose port for inference server
EXPOSE 8000

# Default command
CMD ["python", "src/inference.py"]
`;

  await fs.writeFile(path.join(projectPath, 'Dockerfile'), dockerfile);

  // .gitignore
  await fs.writeFile(
    path.join(projectPath, '.gitignore'),
    `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg

# Virtual environments
venv/
env/
ENV/

# ML specific
*.pkl
*.joblib
*.h5
*.pth
*.onnx
models/*.bin
checkpoints/
logs/
data/raw/
data/processed/
.wandb/
mlruns/

# Jupyter
.ipynb_checkpoints/
*.ipynb

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Environment variables
.env
.env.local
`
  );

  // README.md
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    `# ${projectName}

A ${options.modelType} model built with Cirron CLI.

## Quick Start

### Setup Environment
\`\`\`bash
pip install -r requirements.txt
\`\`\`

### Run Tests
\`\`\`bash
cirron test
\`\`\`

### Train Model (if training template)
\`\`\`bash
python src/train.py
\`\`\`

### Run Inference
\`\`\`bash
python src/inference.py
\`\`\`

### Build Container
\`\`\`bash
cirron build
\`\`\`

### Deploy
\`\`\`bash
cirron deploy
\`\`\`

## Project Structure

\`\`\`
${projectName}/
├── src/
│   ├── model.py          # Model definition
│   ├── inference.py      # Inference script
│   ├── train.py          # Training script (if applicable)
│   └── data_loader.py    # Data loading utilities
├── tests/
│   ├── test_model.py     # Model tests
│   ├── test_inference.py # Inference tests
│   └── test_data.py      # Data validation tests
├── models/               # Saved models
├── checkpoints/          # Training checkpoints
├── logs/                 # Training logs
${options.includeSampleData ? '├── data/sample/         # Sample data\n' : ''}${options.includeNotebook ? '├── notebooks/           # Jupyter notebooks\n' : ''}├── requirements.txt      # Python dependencies
├── Dockerfile           # Container definition
└── cirron.json         # Cirron configuration
\`\`\`

## Cirron Commands

- \`cirron test\` - Run all tests
- \`cirron test --model\` - Test model loading
- \`cirron test --build\` - Test container build
- \`cirron build\` - Build the project
- \`cirron deploy\` - Deploy to your environment
- \`cirron status\` - Check project status
- \`cirron logs\` - View deployment logs

## Environment Variables

Use \`cirron env\` commands to manage environment variables:

\`\`\`bash
cirron env list
cirron env set MODEL_PATH /path/to/model
cirron env delete OLD_VAR
\`\`\`

## Model Information

- **Framework**: ${options.template}
- **Model Type**: ${options.modelType}
- **Python Version**: 3.9+

## Development

1. Make changes to your model in \`src/model.py\`
2. Test locally: \`cirron test\`
3. Build container: \`cirron build\`
4. Deploy: \`cirron deploy --env staging\`
`
  );

  // Create tests
  await createTestFiles(projectPath, options);

  // .env.example
  await fs.writeFile(
    path.join(projectPath, '.env.example'),
    `# Model configuration
MODEL_PATH=models/best_model.pth
BATCH_SIZE=32
DEVICE=cuda

# Data paths
DATA_PATH=data/
TRAINING_DATA_PATH=data/train/
VALIDATION_DATA_PATH=data/val/

# API configuration
API_HOST=0.0.0.0
API_PORT=8000

# Logging
LOG_LEVEL=INFO
LOG_PATH=logs/

# Training configuration
LEARNING_RATE=0.001
NUM_EPOCHS=10
CHECKPOINT_DIR=checkpoints/
`
  );
}

async function createTestFiles(projectPath: string, _options: any): Promise<void> {
  // Model tests
  const modelTest = `import unittest
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))

from model import create_model

class TestModel(unittest.TestCase):
    def setUp(self):
        self.model = create_model()
    
    def test_model_creation(self):
        """Test that model can be created"""
        self.assertIsNotNone(self.model)
    
    def test_model_attributes(self):
        """Test model has required attributes/methods"""
        # Add framework-specific tests based on template
        if hasattr(self.model, 'forward'):  # PyTorch
            self.assertTrue(callable(self.model.forward))
        elif hasattr(self.model, 'predict'):  # sklearn or custom
            self.assertTrue(callable(self.model.predict))

if __name__ == '__main__':
    unittest.main()
`;

  await fs.writeFile(path.join(projectPath, 'tests', 'test_model.py'), modelTest);

  // Inference tests
  const inferenceTest = `import unittest
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))

from inference import ModelInference

class TestInference(unittest.TestCase):
    def setUp(self):
        self.inference = ModelInference()
    
    def test_inference_creation(self):
        """Test that inference object can be created"""
        self.assertIsNotNone(self.inference)
        self.assertIsNotNone(self.inference.model)
    
    def test_preprocess_method(self):
        """Test preprocessing method exists and works"""
        self.assertTrue(hasattr(self.inference, 'preprocess'))
        self.assertTrue(callable(self.inference.preprocess))
    
    def test_predict_method(self):
        """Test prediction method exists"""
        self.assertTrue(hasattr(self.inference, 'predict'))
        self.assertTrue(callable(self.inference.predict))

if __name__ == '__main__':
    unittest.main()
`;

  await fs.writeFile(path.join(projectPath, 'tests', 'test_inference.py'), inferenceTest);

  // Data tests
  const dataTest = `import unittest
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))

class TestData(unittest.TestCase):
    def test_data_directory_exists(self):
        """Test that data directory structure exists"""
        if os.path.exists('data'):
            self.assertTrue(os.path.isdir('data'))
    
    def test_sample_data_format(self):
        """Test sample data format if it exists"""
        # Add specific data validation tests based on your requirements
        pass

if __name__ == '__main__':
    unittest.main()
`;

  await fs.writeFile(path.join(projectPath, 'tests', 'test_data.py'), dataTest);
}

async function createSampleData(projectPath: string, modelType: string): Promise<void> {
  if (modelType === 'classification') {
    const sampleData = `feature1,feature2,feature3,label
1.2,2.3,3.4,0
2.1,3.2,4.3,1
3.0,4.1,5.2,0
4.3,5.4,6.5,1
5.1,6.2,7.3,0
`;
    await fs.writeFile(path.join(projectPath, 'data', 'sample', 'sample_data.csv'), sampleData);
  } else if (modelType === 'regression') {
    const sampleData = `feature1,feature2,feature3,target
1.2,2.3,3.4,10.5
2.1,3.2,4.3,15.2
3.0,4.1,5.2,18.7
4.3,5.4,6.5,22.1
5.1,6.2,7.3,25.8
`;
    await fs.writeFile(path.join(projectPath, 'data', 'sample', 'sample_data.csv'), sampleData);
  }
  
  // Create data README
  const dataReadme = `# Sample Data

This directory contains sample data for testing and development.

## Files

- \`sample_data.csv\` - Sample dataset for ${modelType}

## Usage

This sample data is automatically used by the default data loaders for testing purposes. Replace with your actual dataset for training.

## Data Format

${modelType === 'classification' ? 
  'The dataset contains features and categorical labels (0, 1, etc.).' :
  'The dataset contains features and continuous target values.'
}
`;

  await fs.writeFile(path.join(projectPath, 'data', 'sample', 'README.md'), dataReadme);
}

async function createNotebook(projectPath: string, projectName: string, options: any): Promise<void> {
  const notebook = {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          `# ${projectName} - Exploration Notebook\n`,
          '\n',
          `This notebook provides a starting point for exploring your ${options.modelType} model.\n`
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          'import sys\n',
          'import os\n',
          'sys.path.append(\'../src\')\n',
          '\n',
          'import numpy as np\n',
          'import matplotlib.pyplot as plt\n',
          'import pandas as pd\n',
          '\n',
          '# Import your model\n',
          'from model import create_model\n',
          'from inference import ModelInference\n'
        ]
      },
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '## Load and Explore Data\n'
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          '# Load sample data\n',
          'if os.path.exists(\'../data/sample/sample_data.csv\'):\n',
          '    data = pd.read_csv(\'../data/sample/sample_data.csv\')\n',
          '    print("Data shape:", data.shape)\n',
          '    print("\\nFirst few rows:")\n',
          '    display(data.head())\n',
          'else:\n',
          '    print("No sample data found. Add your dataset to ../data/")\n'
        ]
      },
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '## Model Testing\n'
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          '# Test model creation\n',
          'model = create_model()\n',
          'print("Model created successfully!")\n',
          'print("Model type:", type(model))\n'
        ]
      },
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '## Inference Testing\n'
        ]
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          '# Test inference\n',
          'inference = ModelInference()\n',
          '\n',
          '# Create sample input (modify based on your model)\n',
          'sample_input = np.random.randn(1, 10)  # Adjust dimensions as needed\n',
          '\n',
          'try:\n',
          '    result = inference.predict(sample_input)\n',
          '    print("Prediction successful!")\n',
          '    print("Result:", result)\n',
          'except Exception as e:\n',
          '    print("Prediction failed:", str(e))\n',
          '    print("Adjust sample_input format for your model")\n'
        ]
      },
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '## Next Steps\n',
          '\n',
          '1. Replace sample data with your actual dataset\n',
          '2. Modify model architecture as needed\n',
          '3. Implement training pipeline\n',
          '4. Test with `cirron test`\n',
          '5. Build and deploy with `cirron build` and `cirron deploy`\n'
        ]
      }
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        codemirror_mode: {
          name: 'ipython',
          version: 3
        },
        file_extension: '.py',
        mimetype: 'text/x-python',
        name: 'python',
        nbconvert_exporter: 'python',
        pygments_lexer: 'ipython3',
        version: '3.9.0'
      }
    },
    nbformat: 4,
    nbformat_minor: 4
  };

  await fs.writeJSON(path.join(projectPath, 'notebooks', 'explore.ipynb'), notebook, { spaces: 2 });
}

function getModelCode(framework: string, modelType: string): string {
  if (framework === 'pytorch') {
    return getPyTorchModelCode(modelType);
  } else if (framework === 'tensorflow') {
    return getTensorFlowModelCode(modelType);
  } else if (framework === 'sklearn') {
    return getSklearnModelCode(modelType);
  } else {
    return getCustomModelCode(modelType);
  }
}

function getPyTorchModelCode(modelType: string): string {
  const baseImports = `import torch
import torch.nn as nn
import torch.nn.functional as F

`;

  if (modelType === 'classification') {
    return baseImports + `class ClassificationModel(nn.Module):
    def __init__(self, input_dim=10, hidden_dim=64, num_classes=2):
        super(ClassificationModel, self).__init__()
        self.input_dim = input_dim
        self.num_classes = num_classes
        
        self.layers = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden_dim // 2, num_classes)
        )
    
    def forward(self, x):
        return self.layers(x)

def create_model():
    return ClassificationModel()
`;
  } else if (modelType === 'regression') {
    return baseImports + `class RegressionModel(nn.Module):
    def __init__(self, input_dim=10, hidden_dim=64):
        super(RegressionModel, self).__init__()
        self.input_dim = input_dim
        
        self.layers = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden_dim // 2, 1)
        )
    
    def forward(self, x):
        return self.layers(x)

def create_model():
    return RegressionModel()
`;
  } else if (modelType === 'computer_vision') {
    return baseImports + `class CNNModel(nn.Module):
    def __init__(self, num_classes=10):
        super(CNNModel, self).__init__()
        self.num_classes = num_classes
        
        self.features = nn.Sequential(
            nn.Conv2d(3, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((7, 7))
        )
        
        self.classifier = nn.Sequential(
            nn.Dropout(0.5),
            nn.Linear(128 * 7 * 7, 512),
            nn.ReLU(),
            nn.Dropout(0.5),
            nn.Linear(512, num_classes)
        )
    
    def forward(self, x):
        x = self.features(x)
        x = x.view(x.size(0), -1)
        x = self.classifier(x)
        return x

def create_model():
    return CNNModel()
`;
  } else {
    return baseImports + `class CustomModel(nn.Module):
    def __init__(self, input_dim=10, output_dim=1):
        super(CustomModel, self).__init__()
        self.input_dim = input_dim
        self.output_dim = output_dim
        
        # Define your architecture here
        self.layers = nn.Sequential(
            nn.Linear(input_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, output_dim)
        )
    
    def forward(self, x):
        return self.layers(x)

def create_model():
    return CustomModel()
`;
  }
}

function getTensorFlowModelCode(modelType: string): string {
  const baseImports = `import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

`;

  if (modelType === 'classification') {
    return baseImports + `def create_model(input_dim=10, num_classes=2):
    model = keras.Sequential([
        layers.Dense(64, activation='relu', input_shape=(input_dim,)),
        layers.Dropout(0.2),
        layers.Dense(32, activation='relu'),
        layers.Dropout(0.2),
        layers.Dense(num_classes, activation='softmax')
    ])
    
    return model
`;
  } else if (modelType === 'regression') {
    return baseImports + `def create_model(input_dim=10):
    model = keras.Sequential([
        layers.Dense(64, activation='relu', input_shape=(input_dim,)),
        layers.Dropout(0.2),
        layers.Dense(32, activation='relu'),
        layers.Dropout(0.2),
        layers.Dense(1)
    ])
    
    return model
`;
  } else if (modelType === 'computer_vision') {
    return baseImports + `def create_model(num_classes=10, input_shape=(224, 224, 3)):
    model = keras.Sequential([
        layers.Conv2D(32, (3, 3), activation='relu', input_shape=input_shape),
        layers.MaxPooling2D((2, 2)),
        layers.Conv2D(64, (3, 3), activation='relu'),
        layers.MaxPooling2D((2, 2)),
        layers.Conv2D(128, (3, 3), activation='relu'),
        layers.GlobalAveragePooling2D(),
        layers.Dropout(0.5),
        layers.Dense(512, activation='relu'),
        layers.Dropout(0.5),
        layers.Dense(num_classes, activation='softmax')
    ])
    
    return model
`;
  } else {
    return baseImports + `def create_model(input_dim=10, output_dim=1):
    model = keras.Sequential([
        layers.Dense(64, activation='relu', input_shape=(input_dim,)),
        layers.Dense(32, activation='relu'),
        layers.Dense(output_dim)
    ])
    
    return model
`;
  }
}

function getSklearnModelCode(modelType: string): string {
  const baseImports = `from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.pipeline import Pipeline
import numpy as np

`;

  if (modelType === 'classification') {
    return baseImports + `def create_model():
    """Create a classification model"""
    return RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        random_state=42
    )

def preprocess_data(X, preprocessor=None, fit=True):
    """Preprocess the input data"""
    if preprocessor is None and fit:
        preprocessor = StandardScaler()
        X_processed = preprocessor.fit_transform(X)
    elif preprocessor is not None:
        X_processed = preprocessor.transform(X)
    else:
        X_processed = X
    
    return X_processed, preprocessor
`;
  } else if (modelType === 'regression') {
    return baseImports + `def create_model():
    """Create a regression model"""
    return RandomForestRegressor(
        n_estimators=100,
        max_depth=10,
        random_state=42
    )

def preprocess_data(X, preprocessor=None, fit=True):
    """Preprocess the input data"""
    if preprocessor is None and fit:
        preprocessor = StandardScaler()
        X_processed = preprocessor.fit_transform(X)
    elif preprocessor is not None:
        X_processed = preprocessor.transform(X)
    else:
        X_processed = X
    
    return X_processed, preprocessor
`;
  } else {
    return baseImports + `def create_model():
    """Create a custom model pipeline"""
    return Pipeline([
        ('scaler', StandardScaler()),
        ('model', RandomForestClassifier(random_state=42))
    ])

def preprocess_data(X, preprocessor=None, fit=True):
    """Preprocess the input data"""
    # For pipeline models, preprocessing is handled internally
    return X, None
`;
  }
}

function getCustomModelCode(_modelType: string): string {
  return `"""
Custom model implementation
Modify this file to implement your specific model architecture
"""

class CustomModel:
    def __init__(self):
        # Initialize your model here
        self.is_trained = False
    
    def fit(self, X, y):
        """Train the model"""
        # Implement training logic
        print("Training model...")
        self.is_trained = True
        return self
    
    def predict(self, X):
        """Make predictions"""
        if not self.is_trained:
            raise ValueError("Model must be trained before making predictions")
        
        # Implement prediction logic
        # This is a placeholder - replace with actual implementation
        import numpy as np
        return np.random.randn(len(X))
    
    def save(self, filepath):
        """Save the model"""
        import joblib
        joblib.dump(self, filepath)
    
    def load(self, filepath):
        """Load a saved model"""
        import joblib
        model = joblib.load(filepath)
        self.__dict__.update(model.__dict__)

def create_model():
    """Factory function to create model instance"""
    return CustomModel()
`;
}

function getDataLoaderCode(framework: string, _modelType: string): string {
  if (framework === 'pytorch') {
    return `import torch
from torch.utils.data import Dataset, DataLoader
import pandas as pd
import numpy as np
from PIL import Image
import os

class CustomDataset(Dataset):
    def __init__(self, data_path, transform=None):
        self.data_path = data_path
        self.transform = transform
        
        # Load data based on model type
        if os.path.exists(data_path) and data_path.endswith('.csv'):
            self.data = pd.read_csv(data_path)
        else:
            # Handle image directories or other data formats
            self.data = self._load_data()
    
    def _load_data(self):
        """Load data from directory or other sources"""
        # Implement based on your data structure
        return []
    
    def __len__(self):
        return len(self.data)
    
    def __getitem__(self, idx):
        # Implement data loading logic
        if hasattr(self.data, 'iloc'):  # DataFrame
            row = self.data.iloc[idx]
            # Adjust based on your data structure
            features = row[:-1].values.astype(np.float32)
            target = row[-1]
            
            if self.transform:
                features = self.transform(features)
            
            return torch.tensor(features), torch.tensor(target)
        else:
            # Handle other data types
            return torch.randn(10), torch.tensor(0)  # Placeholder

def get_data_loaders(config):
    """Create train and validation data loaders"""
    batch_size = config.get('batch_size', 32)
    
    # Create datasets
    train_dataset = CustomDataset(
        data_path=os.path.join(config['data_path'], 'train.csv')
        if os.path.exists(os.path.join(config['data_path'], 'train.csv'))
        else 'data/sample/sample_data.csv'
    )
    
    val_dataset = CustomDataset(
        data_path=os.path.join(config['data_path'], 'val.csv')
        val_dataset = CustomDataset(
          data_path=os.path.join(config['data_path'], 'val.csv')
          if os.path.exists(os.path.join(config['data_path'], 'val.csv'))
          else 'data/sample/sample_data.csv'
      )
    
    # Create data loaders
    train_loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=2
    )
    
    val_loader = DataLoader(
        val_dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=2
    )
    
    return train_loader, val_loader
`;
  } else if (framework === 'tensorflow') {
    return `import tensorflow as tf
import pandas as pd
import numpy as np
import os

def load_data_from_csv(filepath):
    """Load data from CSV file"""
    if not os.path.exists(filepath):
        # Use sample data if file doesn't exist
        filepath = 'data/sample/sample_data.csv'
    
    data = pd.read_csv(filepath)
    
    # Separate features and labels
    X = data.iloc[:, :-1].values.astype(np.float32)
    y = data.iloc[:, -1].values
    
    return X, y

def create_tf_dataset(X, y, batch_size=32, shuffle=True):
    """Create TensorFlow dataset"""
    dataset = tf.data.Dataset.from_tensor_slices((X, y))
    
    if shuffle:
        dataset = dataset.shuffle(buffer_size=1000)
    
    dataset = dataset.batch(batch_size)
    dataset = dataset.prefetch(tf.data.AUTOTUNE)
    
    return dataset

def get_data_loaders(config):
    """Create train and validation datasets"""
    batch_size = config.get('batch_size', 32)
    data_path = config.get('data_path', 'data/')
    
    # Load training data
    train_path = os.path.join(data_path, 'train.csv')
    if not os.path.exists(train_path):
        train_path = 'data/sample/sample_data.csv'
    
    X_train, y_train = load_data_from_csv(train_path)
    
    # Load validation data
    val_path = os.path.join(data_path, 'val.csv')
    if not os.path.exists(val_path):
        # Split training data for validation
        split_idx = int(0.8 * len(X_train))
        X_val, y_val = X_train[split_idx:], y_train[split_idx:]
        X_train, y_train = X_train[:split_idx], y_train[:split_idx]
    else:
        X_val, y_val = load_data_from_csv(val_path)
    
    # Create datasets
    train_dataset = create_tf_dataset(X_train, y_train, batch_size, shuffle=True)
    val_dataset = create_tf_dataset(X_val, y_val, batch_size, shuffle=False)
    
    return train_dataset, val_dataset
`;
  } else if (framework === 'sklearn') {
    return `import pandas as pd
import numpy as np
import os
from sklearn.model_selection import train_test_split

def load_data(data_path):
    """Load data for sklearn models"""
    if os.path.isfile(data_path):
        # Single file
        data = pd.read_csv(data_path)
    elif os.path.isdir(data_path):
        # Directory with train/val files
        train_path = os.path.join(data_path, 'train.csv')
        if os.path.exists(train_path):
            data = pd.read_csv(train_path)
        else:
            # Use sample data
            data = pd.read_csv('data/sample/sample_data.csv')
    else:
        # Use sample data as fallback
        data = pd.read_csv('data/sample/sample_data.csv')
    
    # Separate features and target
    X = data.iloc[:, :-1]
    y = data.iloc[:, -1]
    
    return X, y

def prepare_data(data_path, test_size=0.2, random_state=42):
    """Prepare data with train/test split"""
    X, y = load_data(data_path)
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=random_state
    )
    
    return X_train, X_test, y_train, y_test
`;
  } else {
    // Custom framework
    return `import pandas as pd
import numpy as np
import os

def load_data(data_path):
    """Load data for custom models"""
    if os.path.isfile(data_path) and data_path.endswith('.csv'):
        data = pd.read_csv(data_path)
        X = data.iloc[:, :-1].values
        y = data.iloc[:, -1].values
        return X, y
    elif os.path.isdir(data_path):
        # Handle directory structure
        # Implement based on your specific needs
        pass
    else:
        # Use sample data
        data = pd.read_csv('data/sample/sample_data.csv')
        X = data.iloc[:, :-1].values
        y = data.iloc[:, -1].values
        return X, y

def prepare_data_splits(X, y, train_ratio=0.8):
    """Split data into train/validation sets"""
    split_idx = int(train_ratio * len(X))
    
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]
    
    return X_train, X_val, y_train, y_val
`;
  }
}

function getModelClassName(modelType: string): string {
  switch (modelType) {
    case 'classification':
      return 'ClassificationModel';
    case 'regression':
      return 'RegressionModel';
    case 'computer_vision':
      return 'CNNModel';
    case 'nlp':
      return 'NLPModel';
    case 'time_series':
      return 'TimeSeriesModel';
    default:
      return 'CustomModel';
  }
}