import fs from 'fs-extra';
import path from 'path';
import { executePythonScript } from './execution';
import { ModelConfigManager } from './model-config';

export interface ModelAnalysis {
  architecture: string;
  totalParameters: number;
  trainableParameters: number;
  nonTrainableParameters: number;
  estimatedMemory: number; // bytes
  modelSize: number; // bytes on disk
  inputShape?: string;
  outputShape?: string;
  layers: LayerInfo[];
  complexity: 'low' | 'medium' | 'high';
  framework: string;
  warnings: string[];
}

export interface LayerInfo {
  name: string;
  type: string;
  parameters: number;
  outputShape?: string;
  description?: string;
}

export class ModelAnalyzer {
  private projectPath: string;
  private framework: string;

  constructor(projectPath: string, framework: string) {
    this.projectPath = projectPath;
    this.framework = framework;
  }

  async analyzeModel(): Promise<ModelAnalysis> {
    const modelPath = path.join(this.projectPath, 'src', 'model.py');
    
    if (!fs.existsSync(modelPath)) {
      throw new Error('Model file not found: src/model.py');
    }

    const analysis: ModelAnalysis = {
      architecture: 'Unknown',
      totalParameters: 0,
      trainableParameters: 0,
      nonTrainableParameters: 0,
      estimatedMemory: 0,
      modelSize: 0,
      layers: [],
      complexity: 'low',
      framework: this.framework,
      warnings: []
    };

    // Try to load model configuration to enhance analysis
    try {
      const modelConfigManager = new ModelConfigManager(this.projectPath);
      const modelConfig = await modelConfigManager.loadModelConfig();
      
      if (modelConfig) {
        // Use model config to override/enhance analysis
        if (modelConfig.architecture) {
          analysis.architecture = modelConfig.architecture;
        }
        if (modelConfig.parameters?.total) {
          analysis.totalParameters = modelConfig.parameters.total;
        }
        if (modelConfig.parameters?.trainable) {
          analysis.trainableParameters = modelConfig.parameters.trainable;
        }
        if (modelConfig.parameters?.nonTrainable) {
          analysis.nonTrainableParameters = modelConfig.parameters.nonTrainable;
        }
        if (modelConfig.inputShape) {
          analysis.inputShape = typeof modelConfig.inputShape === 'string' 
            ? modelConfig.inputShape 
            : JSON.stringify(modelConfig.inputShape);
        }
        if (modelConfig.outputShape) {
          analysis.outputShape = typeof modelConfig.outputShape === 'string' 
            ? modelConfig.outputShape 
            : JSON.stringify(modelConfig.outputShape);
        }
      }
    } catch (error) {
      // Model config loading is optional, continue with code analysis
      analysis.warnings.push('Could not load model configuration file');
    }

    try {
      // Analyze model code statically
      const modelContent = await fs.readFile(modelPath, 'utf8');
      await this.analyzeModelCode(modelContent, analysis);

      // Try dynamic analysis if possible
      if (await this.canRunDynamicAnalysis()) {
        await this.analyzeDynamically(analysis);
      } else {
        analysis.warnings.push('Could not perform dynamic analysis - model may have missing dependencies');
      }

      // Calculate complexity
      analysis.complexity = this.calculateComplexity(analysis);

    } catch (error) {
      analysis.warnings.push(`Analysis error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return analysis;
  }

  private async analyzeModelCode(content: string, analysis: ModelAnalysis): Promise<void> {
    // Detect architecture from code patterns
    analysis.architecture = this.detectArchitectureFromCode(content);
    
    // Extract layer information
    analysis.layers = this.extractLayers(content);
    
    // Estimate parameters from layer definitions
    this.estimateParametersFromCode(content, analysis);
    
    // Detect input/output shapes
    const inputShape = this.detectInputShape(content, this.framework);
    const outputShape = this.detectOutputShape(content, this.framework);
    
    if (inputShape) analysis.inputShape = inputShape;
    if (outputShape) analysis.outputShape = outputShape;
  }

  private detectArchitectureFromCode(content: string): string {
    const patterns = {
      'Convolutional Neural Network': [
        'Conv2d', 'conv2d', 'Conv1d', 'conv1d', 'Conv3d', 'conv3d',
        'MaxPool2d', 'AvgPool2d', 'maxpool', 'avgpool'
      ],
      'Recurrent Neural Network': [
        'LSTM', 'lstm', 'GRU', 'gru', 'RNN', 'rnn', 'SimpleRNN'
      ],
      'Transformer': [
        'MultiHeadAttention', 'attention', 'transformer', 'Transformer',
        'self_attention', 'cross_attention', 'TransformerBlock'
      ],
      'ResNet': [
        'ResNet', 'resnet', 'residual', 'BasicBlock', 'Bottleneck',
        'skip_connection', 'shortcut'
      ],
      'VGG': [
        'VGG', 'vgg', 'make_layers'
      ],
      'U-Net': [
        'UNet', 'unet', 'encoder', 'decoder', 'upsampl', 'downsampl'
      ],
      'GAN': [
        'Generator', 'Discriminator', 'generator', 'discriminator',
        'adversarial', 'GAN'
      ],
      'Autoencoder': [
        'Encoder', 'Decoder', 'encoder', 'decoder', 'autoencoder',
        'reconstruction', 'latent'
      ],
      'Linear/Feedforward': [
        'Linear', 'Dense', 'linear', 'dense', 'fc', 'fully_connected'
      ]
    };

    const scores: Record<string, number> = {};
    
    for (const [architecture, keywords] of Object.entries(patterns)) {
      scores[architecture] = keywords.filter(keyword => 
        content.toLowerCase().includes(keyword.toLowerCase())
      ).length;
    }

    // Return architecture with highest score
    const bestMatch = Object.entries(scores).reduce((best, [arch, score]) => 
      score > best[1] ? [arch, score] : best, ['Unknown', 0]
    );

    return bestMatch[1] > 0 ? bestMatch[0] : 'Custom';
  }

  private extractLayers(content: string): LayerInfo[] {
    const layers: LayerInfo[] = [];
    
    if (this.framework === 'pytorch') {
      this.extractPyTorchLayers(content, layers);
    } else if (this.framework === 'tensorflow') {
      this.extractTensorFlowLayers(content, layers);
    } else if (this.framework === 'sklearn') {
      this.extractSklearnLayers(content, layers);
    }

    return layers;
  }

  private extractPyTorchLayers(content: string, layers: LayerInfo[]): void {
    // Match PyTorch layer definitions like nn.Linear(784, 256)
    const layerPatterns = [
      {
        pattern: /nn\.Linear\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g,
        type: 'Linear',
        parameterCalc: (matches: RegExpMatchArray) => {
          const inputSize = parseInt(matches[1] || '0');
          const outputSize = parseInt(matches[2] || '0');
          return inputSize * outputSize + outputSize; // weights + bias
        }
      },
      {
        pattern: /nn\.Conv2d\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g,
        type: 'Conv2d',
        parameterCalc: (matches: RegExpMatchArray) => {
          const inChannels = parseInt(matches[1] || '0');
          const outChannels = parseInt(matches[2] || '0');
          const kernelSize = parseInt(matches[3] || '0');
          return inChannels * outChannels * kernelSize * kernelSize + outChannels;
        }
      },
      {
        pattern: /nn\.LSTM\s*\(\s*(\d+)\s*,\s*(\d+)/g,
        type: 'LSTM',
        parameterCalc: (matches: RegExpMatchArray) => {
          const inputSize = parseInt(matches[1] || '0');
          const hiddenSize = parseInt(matches[2] || '0');
          return 4 * (inputSize + hiddenSize) * hiddenSize + 4 * hiddenSize;
        }
      }
    ];

    for (const { pattern, type, parameterCalc } of layerPatterns) {
      const matches = Array.from(content.matchAll(pattern));
      for (const match of matches) {
        if (match && match[1] && match[2]) {
          const parameters = parameterCalc(match);
          layers.push({
            name: `${type}_${layers.length}`,
            type,
            parameters,
            description: match[0]
          });
        }
      }
    }
  }

  private extractTensorFlowLayers(content: string, layers: LayerInfo[]): void {
    // Match TensorFlow/Keras layer definitions
    const layerPatterns = [
      {
        pattern: /Dense\s*\(\s*(\d+)/g,
        type: 'Dense',
        parameterCalc: (matches: RegExpMatchArray) => {
          const units = parseInt(matches[1] || '0');
          return units * 100 + units; // Rough estimate
        }
      },
      {
        pattern: /Conv2D\s*\(\s*(\d+)\s*,\s*\((\d+),\s*(\d+)\)/g,
        type: 'Conv2D',
        parameterCalc: (matches: RegExpMatchArray) => {
          const filters = parseInt(matches[1] || '0');
          const kernelH = parseInt(matches[2] || '0');
          const kernelW = parseInt(matches[3] || '0');
          return filters * kernelH * kernelW * 3 + filters; // Assuming 3 input channels
        }
      }
    ];

    for (const { pattern, type, parameterCalc } of layerPatterns) {
      const matches = Array.from(content.matchAll(pattern));
      for (const match of matches) {
        if (match && match[1] && match[2]) {
          const parameters = parameterCalc(match);
          layers.push({
            name: `${type}_${layers.length}`,
            type,
            parameters,
            description: match[0]
          });
        }
      }
    }
  }

  private extractSklearnLayers(content: string, layers: LayerInfo[]): void {
    // Scikit-learn models are typically single "layers"
    const modelPatterns = [
      'RandomForestClassifier', 'RandomForestRegressor',
      'SVM', 'SVC', 'SVR',
      'LogisticRegression', 'LinearRegression',
      'GradientBoostingClassifier', 'GradientBoostingRegressor'
    ];

    for (const modelType of modelPatterns) {
      if (content.includes(modelType)) {
        layers.push({
          name: modelType,
          type: modelType,
          parameters: this.estimateSklearnParameters(modelType),
          description: `Scikit-learn ${modelType}`
        });
      }
    }
  }

  private estimateSklearnParameters(modelType: string): number {
    // Rough parameter estimates for sklearn models
    const estimates: Record<string, number> = {
      'RandomForestClassifier': 50000,
      'RandomForestRegressor': 50000,
      'SVM': 10000,
      'SVC': 10000,
      'SVR': 10000,
      'LogisticRegression': 1000,
      'LinearRegression': 1000,
      'GradientBoostingClassifier': 30000,
      'GradientBoostingRegressor': 30000
    };

    return estimates[modelType] || 5000;
  }

  private estimateParametersFromCode(content: string, analysis: ModelAnalysis): void {
    // Sum up parameters from all layers
    analysis.totalParameters = analysis.layers.reduce((sum, layer) => sum + layer.parameters, 0);
    
    // For most models, all parameters are trainable by default
    analysis.trainableParameters = analysis.totalParameters;
    analysis.nonTrainableParameters = 0;

    // Estimate memory usage (parameters * 4 bytes for float32)
    analysis.estimatedMemory = analysis.totalParameters * 4;
    
    // Estimate model file size (usually 2-3x parameter memory for metadata)
    analysis.modelSize = analysis.estimatedMemory * 2.5;

    // Override estimates if we find specific patterns
    if (content.includes('BatchNorm') || content.includes('batch_norm')) {
      // BatchNorm adds non-trainable parameters
      analysis.nonTrainableParameters = Math.floor(analysis.totalParameters * 0.1);
    }

    if (content.includes('Dropout') || content.includes('dropout')) {
      // Dropout doesn't add parameters but affects memory during training
      analysis.estimatedMemory *= 1.2;
    }
  }

  private detectInputShape(content: string, _framework?: string): string | undefined {
    const patterns = [
      /input.*shape.*=.*\(([^)]+)\)/i,
      /input_shape.*=.*\(([^)]+)\)/i,
      /torch\.randn\s*\(\s*([^)]+)\)/i,
      /torch\.zeros\s*\(\s*([^)]+)\)/i,
      /Input\s*\(\s*shape\s*=\s*\(([^)]+)\)/i
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return `(${match[1]})`;
      }
    }

    // Default assumptions based on architecture
    if (content.includes('Conv2d') || content.includes('Conv2D')) {
      return '(batch, channels, height, width)';
    } else if (content.includes('Linear') || content.includes('Dense')) {
      return '(batch, features)';
    }

    return undefined;
  }

  private detectOutputShape(content: string, _framework?: string): string | undefined {
    const patterns = [
      /num_classes.*=.*(\d+)/i,
      /output.*=.*(\d+)/i,
      /nn\.Linear\([^,]+,\s*(\d+)\)/g,
      /Dense\s*\(\s*(\d+)/g
    ];

    for (const pattern of patterns) {
      const matches = Array.from(content.matchAll(pattern));
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        if (lastMatch && lastMatch[1]) {
          return `(batch, ${lastMatch[1]})`;
        }
      }
    }

    return undefined;
  }

  private async canRunDynamicAnalysis(): Promise<boolean> {
    try {
      // Try to import basic ML libraries
      const testScript = `
import sys
sys.path.append('src')

try:
    if "${this.framework}" == "pytorch":
        import torch
        print("PyTorch available")
    elif "${this.framework}" == "tensorflow":
        import tensorflow as tf
        print("TensorFlow available")
    elif "${this.framework}" == "sklearn":
        import sklearn
        print("Scikit-learn available")
    
    # Try importing the model
    from model import create_model
    print("Model import successful")
    
except ImportError as e:
    print(f"Import error: {e}")
    exit(1)
except Exception as e:
    print(f"Error: {e}")
    exit(1)
`;

      const result = await executePythonScript(testScript, { 
        cwd: this.projectPath, 
        timeout: 10000 
      });
      
      return result.success;
    } catch {
      return false;
    }
  }

  private async analyzeDynamically(analysis: ModelAnalysis): Promise<void> {
    if (this.framework === 'pytorch') {
      await this.analyzePyTorchDynamically(analysis);
    } else if (this.framework === 'tensorflow') {
      await this.analyzeTensorFlowDynamically(analysis);
    } else if (this.framework === 'sklearn') {
      await this.analyzeSklearnDynamically(analysis);
    }
  }

  private async analyzePyTorchDynamically(analysis: ModelAnalysis): Promise<void> {
    const script = `
import sys
sys.path.append('src')
import torch
from model import create_model
import json

try:
    model = create_model()
    
    # Count parameters
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    
    # Try to get model summary
    model_info = {
        'total_parameters': total_params,
        'trainable_parameters': trainable_params,
        'non_trainable_parameters': total_params - trainable_params
    }
    
    # Try to infer input shape from first layer
    try:
        first_layer = next(model.children())
        if hasattr(first_layer, 'in_features'):
            model_info['input_shape'] = f"(batch, {first_layer.in_features})"
        elif hasattr(first_layer, 'in_channels'):
            model_info['input_shape'] = f"(batch, {first_layer.in_channels}, H, W)"
    except:
        pass
    
    print(json.dumps(model_info))

except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const result = await executePythonScript(script, { 
        cwd: this.projectPath,
        timeout: 15000
      });
      
      if (result.success && result.stdout) {
        const modelInfo = JSON.parse(result.stdout);
        if (!modelInfo.error) {
          analysis.totalParameters = modelInfo.total_parameters || analysis.totalParameters;
          analysis.trainableParameters = modelInfo.trainable_parameters || analysis.trainableParameters;
          analysis.nonTrainableParameters = modelInfo.non_trainable_parameters || analysis.nonTrainableParameters;
          analysis.inputShape = modelInfo.input_shape || analysis.inputShape;
          analysis.estimatedMemory = analysis.totalParameters * 4;
          analysis.modelSize = analysis.estimatedMemory * 2.5;
        }
      }
    } catch (error) {
      analysis.warnings.push(`Dynamic PyTorch analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async analyzeTensorFlowDynamically(analysis: ModelAnalysis): Promise<void> {
    const script = `
import sys
sys.path.append('src')
import tensorflow as tf
from model import create_model
import json

try:
    model = create_model()
    
    model_info = {
        'total_parameters': model.count_params(),
        'trainable_parameters': sum([tf.keras.backend.count_params(w) for w in model.trainable_weights]),
        'input_shape': str(model.input_shape) if hasattr(model, 'input_shape') else None,
        'output_shape': str(model.output_shape) if hasattr(model, 'output_shape') else None
    }
    
    print(json.dumps(model_info))

except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const result = await executePythonScript(script, { 
        cwd: this.projectPath,
        timeout: 15000
      });
      
      if (result.success && result.stdout) {
        const modelInfo = JSON.parse(result.stdout);
        if (!modelInfo.error) {
          analysis.totalParameters = modelInfo.total_parameters || analysis.totalParameters;
          analysis.trainableParameters = modelInfo.trainable_parameters || analysis.trainableParameters;
          analysis.nonTrainableParameters = analysis.totalParameters - analysis.trainableParameters;
          analysis.inputShape = modelInfo.input_shape || analysis.inputShape;
          analysis.outputShape = modelInfo.output_shape || analysis.outputShape;
          analysis.estimatedMemory = analysis.totalParameters * 4;
          analysis.modelSize = analysis.estimatedMemory * 2.5;
        }
      }
    } catch (error) {
      analysis.warnings.push(`Dynamic TensorFlow analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async analyzeSklearnDynamically(analysis: ModelAnalysis): Promise<void> {
    // Scikit-learn models don't have parameters in the traditional sense
    // We can analyze the model type and configuration
    const script = `
import sys
sys.path.append('src')
from model import create_model
import json

try:
    model = create_model()
    
    model_info = {
        'model_type': type(model).__name__,
        'model_class': str(type(model))
    }
    
    # Get model parameters if available
    if hasattr(model, 'get_params'):
        params = model.get_params()
        model_info['model_params'] = {k: str(v) for k, v in params.items()}
    
    print(json.dumps(model_info))

except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const result = await executePythonScript(script, { 
        cwd: this.projectPath,
        timeout: 10000
      });
      
      if (result.success && result.stdout) {
        const modelInfo = JSON.parse(result.stdout);
        if (!modelInfo.error) {
          analysis.architecture = modelInfo.model_type || analysis.architecture;
          // Scikit-learn models typically have low parameter counts
          analysis.totalParameters = this.estimateSklearnParameters(modelInfo.model_type);
          analysis.trainableParameters = analysis.totalParameters;
          analysis.estimatedMemory = analysis.totalParameters * 4;
          analysis.modelSize = analysis.estimatedMemory;
        }
      }
    } catch (error) {
      analysis.warnings.push(`Dynamic scikit-learn analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private calculateComplexity(analysis: ModelAnalysis): 'low' | 'medium' | 'high' {
    const paramThresholds = {
      low: 100000,      // < 100K parameters
      medium: 10000000, // < 10M parameters
      high: Infinity    // >= 10M parameters
    };

    if (analysis.totalParameters < paramThresholds.low) {
      return 'low';
    } else if (analysis.totalParameters < paramThresholds.medium) {
      return 'medium';
    } else {
      return 'high';
    }
  }
}