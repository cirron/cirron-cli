import fs from 'fs-extra';
import path from 'path';
import getModelCode from './models';
import getDataLoaderCode from './data';

export async function createSklearnFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
    const requirements = `scikit-learn>=1.3.0
numpy>=1.21.0,<1.26.0
pandas>=1.5.0
matplotlib>=3.5.0
seaborn>=0.11.0
joblib>=1.2.0
scipy>=1.4.1,<1.12.0
`;
  
    await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
    
    // Create model.yaml configuration
    const modelConfig = `# Model Configuration for Scikit-learn
version: 1
name: "${options.modelType || 'sklearn'}_model"
architecture: "${options.modelType === 'classification' ? 'RandomForestClassifier' : options.modelType === 'regression' ? 'RandomForestRegressor' : 'Pipeline'}"
framework: sklearn
modelType: "${options.modelType || 'classification'}"

parameters:
  total: 5000  # Estimated tree parameters
  trainable: 5000
  nonTrainable: 0

inputShape: "(samples, features)"
outputShape: "${options.modelType === 'regression' ? '(samples,)' : '(samples, num_classes)'}"

training:
  n_estimators: 100
  max_depth: 10
  random_state: 42
  test_size: 0.2
  cross_validation: 5

inference:
  device: "cpu"
  precision: "fp64"
  batchSize: 1000

data:
  inputFormat: "dataframe"
  outputFormat: "${options.modelType === 'regression' ? 'predictions' : 'probabilities'}"
  preprocessing:
    - "standardize"
    - "handle_missing"

metadata:
  description: "Scikit-learn ${options.modelType || 'classification'} model"
  created: "${new Date().toISOString()}"
  tags:
    - "sklearn"
    - "${options.modelType || 'classification'}"
    - "ensemble"

dependencies:
  python: ">=3.8"
  packages:
    scikit-learn: ">=1.3.0"
    numpy: ">=1.21.0"
    pandas: ">=1.5.0"
`;

    await fs.writeFile(path.join(projectPath, 'model.yaml'), modelConfig);
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
  
export async function createSklearnPipelineFiles(projectPath: string, projectName: string, options: any): Promise<void> {
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