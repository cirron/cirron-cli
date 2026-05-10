import { dedent } from '../../utils/dedent';

export default function getDataLoaderCode(framework: string, _modelType: string): string {
  if (framework === 'pytorch') {
    return dedent(`
      import torch
      from torch.utils.data import Dataset, DataLoader
      import pandas as pd
      import numpy as np
      from PIL import Image
      import os


      class CustomDataset(Dataset):
          def __init__(self, data_path, transform=None):
              self.data_path = data_path
              self.transform = transform

              if os.path.exists(data_path) and data_path.endswith('.csv'):
                  self.data = pd.read_csv(data_path)
              else:
                  self.data = self._load_data()

          def _load_data(self):
              """Load data from a directory or other source. Override as needed."""
              return []

          def __len__(self):
              return len(self.data)

          def __getitem__(self, idx):
              if hasattr(self.data, 'iloc'):
                  row = self.data.iloc[idx]
                  features = row[:-1].values.astype(np.float32)
                  target = row[-1]

                  if self.transform:
                      features = self.transform(features)

                  return torch.tensor(features), torch.tensor(target)

              return torch.randn(10), torch.tensor(0)


      def get_data_loaders(config):
          """Create train and validation data loaders."""
          batch_size = config.get('batch_size', 32)

          train_csv = os.path.join(config['data_path'], 'train.csv')
          val_csv = os.path.join(config['data_path'], 'val.csv')

          train_dataset = CustomDataset(
              data_path=train_csv if os.path.exists(train_csv) else 'data/sample/sample_data.csv'
          )
          val_dataset = CustomDataset(
              data_path=val_csv if os.path.exists(val_csv) else 'data/sample/sample_data.csv'
          )

          train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True, num_workers=2)
          val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False, num_workers=2)

          return train_loader, val_loader
    `);
  }

  if (framework === 'tensorflow') {
    return dedent(`
      import tensorflow as tf
      import pandas as pd
      import numpy as np
      import os


      def load_data_from_csv(filepath):
          """Load data from a CSV file."""
          if not os.path.exists(filepath):
              filepath = 'data/sample/sample_data.csv'

          data = pd.read_csv(filepath)
          X = data.iloc[:, :-1].values.astype(np.float32)
          y = data.iloc[:, -1].values
          return X, y


      def create_tf_dataset(X, y, batch_size=32, shuffle=True):
          """Create a tf.data.Dataset from numpy arrays."""
          dataset = tf.data.Dataset.from_tensor_slices((X, y))

          if shuffle:
              dataset = dataset.shuffle(buffer_size=1000)

          dataset = dataset.batch(batch_size)
          dataset = dataset.prefetch(tf.data.AUTOTUNE)
          return dataset


      def get_data_loaders(config):
          """Create train and validation datasets."""
          batch_size = config.get('batch_size', 32)
          data_path = config.get('data_path', 'data/')

          train_path = os.path.join(data_path, 'train.csv')
          if not os.path.exists(train_path):
              train_path = 'data/sample/sample_data.csv'

          X_train, y_train = load_data_from_csv(train_path)

          val_path = os.path.join(data_path, 'val.csv')
          if not os.path.exists(val_path):
              split_idx = int(0.8 * len(X_train))
              X_val, y_val = X_train[split_idx:], y_train[split_idx:]
              X_train, y_train = X_train[:split_idx], y_train[:split_idx]
          else:
              X_val, y_val = load_data_from_csv(val_path)

          train_dataset = create_tf_dataset(X_train, y_train, batch_size, shuffle=True)
          val_dataset = create_tf_dataset(X_val, y_val, batch_size, shuffle=False)
          return train_dataset, val_dataset
    `);
  }

  if (framework === 'sklearn') {
    return dedent(`
      import pandas as pd
      import numpy as np
      import os
      from sklearn.model_selection import train_test_split


      def load_data(data_path):
          """Load data for sklearn models."""
          if os.path.isfile(data_path):
              data = pd.read_csv(data_path)
          elif os.path.isdir(data_path):
              train_path = os.path.join(data_path, 'train.csv')
              if os.path.exists(train_path):
                  data = pd.read_csv(train_path)
              else:
                  data = pd.read_csv('data/sample/sample_data.csv')
          else:
              data = pd.read_csv('data/sample/sample_data.csv')

          X = data.iloc[:, :-1]
          y = data.iloc[:, -1]
          return X, y


      def prepare_data(data_path, test_size=0.2, random_state=42):
          """Prepare a train/test split."""
          X, y = load_data(data_path)
          X_train, X_test, y_train, y_test = train_test_split(
              X, y, test_size=test_size, random_state=random_state
          )
          return X_train, X_test, y_train, y_test
    `);
  }

  return dedent(`
    import pandas as pd
    import numpy as np
    import os


    def load_data(data_path):
        """Load data for custom models."""
        if os.path.isfile(data_path) and data_path.endswith('.csv'):
            data = pd.read_csv(data_path)
            X = data.iloc[:, :-1].values
            y = data.iloc[:, -1].values
            return X, y

        if os.path.isdir(data_path):
            return None, None

        data = pd.read_csv('data/sample/sample_data.csv')
        X = data.iloc[:, :-1].values
        y = data.iloc[:, -1].values
        return X, y


    def prepare_data_splits(X, y, train_ratio=0.8):
        """Split data into train/validation sets."""
        split_idx = int(train_ratio * len(X))
        X_train, X_val = X[:split_idx], X[split_idx:]
        y_train, y_val = y[:split_idx], y[split_idx:]
        return X_train, X_val, y_train, y_val
  `);
}
