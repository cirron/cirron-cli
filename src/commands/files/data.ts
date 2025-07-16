export default function getDataLoaderCode(framework: string, _modelType: string): string {
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