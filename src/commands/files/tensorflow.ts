import fs from 'fs-extra';
import path from 'path';
import getModelCode from './models';
import getDataLoaderCode from './data';

export async function createTensorFlowFiles(projectPath: string, _projectName: string, options: any): Promise<void> {
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

export async function createTensorFlowTrainingFiles(projectPath: string, projectName: string, options: any): Promise<void> {
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