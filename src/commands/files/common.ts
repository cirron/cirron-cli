import fs from 'fs-extra';
import path from 'path';

export async function createCommonMLFiles(projectPath: string, projectName: string, options: any): Promise<void> {
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
      const sampleData = `feature1,feature2,feature3,feature4,feature5,target
0.5,1.2,0.8,2.1,1.5,0
1.1,0.9,1.3,1.7,0.8,1
0.7,1.8,0.6,2.3,1.2,0
1.4,0.6,1.9,1.1,2.1,1
0.9,1.5,1.1,1.9,0.7,0
1.7,0.4,2.2,0.9,1.8,1
0.3,2.1,0.4,2.7,1.3,0
1.9,0.2,2.5,0.6,2.4,1
0.6,1.7,0.9,2.2,1.1,0
2.1,0.1,2.8,0.4,2.7,1
0.8,1.4,1.2,1.8,0.9,0
1.6,0.7,2.1,1.2,2.0,1
0.4,2.0,0.7,2.5,1.4,0
2.0,0.3,2.6,0.7,2.5,1
1.0,1.1,1.5,1.6,1.6,1
0.2,2.3,0.3,2.9,1.0,0
1.8,0.5,2.4,1.0,2.2,1
0.9,1.6,1.0,2.0,1.2,0
1.5,0.8,2.0,1.3,1.9,1
0.7,1.9,0.8,2.4,1.1,0
`;
      await fs.writeFile(path.join(projectPath, 'data', 'sample', 'sample_data.csv'), sampleData);
    } else if (modelType === 'regression') {
      const sampleData = `feature1,feature2,feature3,feature4,feature5,target
0.5,1.2,0.8,2.1,1.5,10.5
1.1,0.9,1.3,1.7,0.8,15.2
0.7,1.8,0.6,2.3,1.2,18.7
1.4,0.6,1.9,1.1,2.1,22.1
0.9,1.5,1.1,1.9,0.7,25.8
1.7,0.4,2.2,0.9,1.8,30.2
0.3,2.1,0.4,2.7,1.3,35.1
1.9,0.2,2.5,0.6,2.4,40.3
0.6,1.7,0.9,2.2,1.1,45.7
2.1,0.1,2.8,0.4,2.7,50.9
0.8,1.4,1.2,1.8,0.9,55.4
1.6,0.7,2.1,1.2,2.0,60.1
0.4,2.0,0.7,2.5,1.4,65.8
2.0,0.3,2.6,0.7,2.5,70.2
1.0,1.1,1.5,1.6,1.6,75.6
0.2,2.3,0.3,2.9,1.0,80.3
1.8,0.5,2.4,1.0,2.2,85.7
0.9,1.6,1.0,2.0,1.2,90.1
1.5,0.8,2.0,1.3,1.9,95.4
0.7,1.9,0.8,2.4,1.1,100.2
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