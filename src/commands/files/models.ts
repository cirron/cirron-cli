export default function getModelCode(framework: string, modelType: string): string {
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

export function getPyTorchModelCode(modelType: string): string {
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
  
export function getSklearnModelCode(modelType: string): string {
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
  
export function getCustomModelCode(_modelType: string): string {
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

export function getTensorFlowModelCode(modelType: string): string {
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

export function getModelClassName(modelType: string): string {
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