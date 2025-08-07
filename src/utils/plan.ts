import fs from 'fs-extra';
import path from 'path';
import type { ProjectConfig } from '../types';

export interface ArtifactPlan {
  path: string;
  type: 'model' | 'metadata' | 'config' | 'checkpoint';
  estimatedSize: number; // in bytes
  description: string;
}

export interface DependencyInfo {
  name: string;
  version: string;
  category: 'ml-framework' | 'data-processing' | 'utility' | 'development';
  estimatedSize: number; // in bytes
  conflicts?: string[];
}

export interface ModelShapeInfo {
  architecture: string;
  totalParameters: number;
  trainableParameters: number;
  nonTrainableParameters: number;
  estimatedMemory: number; // in bytes
  modelSize: number; // in bytes
  inputShape?: string;
  outputShape?: string;
  layers: ModelLayerInfo[];
  complexity: 'low' | 'medium' | 'high';
  framework: string;
  warnings: string[];
}

export interface ModelLayerInfo {
  name: string;
  type: string;
  parameters?: number;
  outputShape?: string;
}

export interface ResourceEstimate {
  diskSpace: number; // in bytes
  memory: number; // in bytes
  estimatedTime: number; // in seconds
  gpuMemory?: number; // in bytes if GPU required
}

export interface PlanFile {
  timestamp: string;
  command: 'compile' | 'build';
  projectName: string;
  framework: string;
  architecture: string;
  pythonVersion: string;
  artifacts: ArtifactPlan[];
  dependencies: DependencyInfo[];
  modelShape?: ModelShapeInfo;
  resources: ResourceEstimate;
  buildSteps: string[];
  warnings?: string[];
}

export class PlanGenerator {
  constructor(
    private projectConfig: ProjectConfig,
    private projectPath: string = process.cwd()
  ) {}

  async generatePlan(
    command: 'compile' | 'build',
    architecture: string,
    indexConfig?: any
  ): Promise<PlanFile> {
    const plan: PlanFile = {
      timestamp: new Date().toISOString(),
      command,
      projectName: this.projectConfig.name,
      framework: this.projectConfig.framework || 'custom',
      architecture,
      pythonVersion: this.projectConfig.pythonVersion || '3.9',
      artifacts: await this.generateArtifactPlan(architecture, indexConfig),
      dependencies: await this.parseDependencies(),
      resources: await this.estimateResources(architecture),
      buildSteps: this.generateBuildSteps(command, architecture),
      warnings: []
    };

    // Add model shape analysis if possible
    try {
      const modelShape = await this.analyzeModelShape();
      if (modelShape) {
        plan.modelShape = modelShape;
      }
    } catch (error) {
      plan.warnings?.push('Could not analyze model shape: model files may not exist yet');
    }

    return plan;
  }

  private async generateArtifactPlan(architecture: string, indexConfig?: any): Promise<ArtifactPlan[]> {
    const artifacts: ArtifactPlan[] = [];
    const framework = this.projectConfig.framework || 'custom';

    // Ensure output directories exist for size estimation
    await fs.ensureDir(path.join(this.projectPath, 'models'));
    await fs.ensureDir(path.join(this.projectPath, 'artifacts'));

    // Framework-specific artifact predictions
    if (framework === 'pytorch') {
      artifacts.push({
        path: `models/model_${architecture}.pth`,
        type: 'model',
        estimatedSize: this.estimateModelFileSize('pytorch'),
        description: 'PyTorch model state dict'
      });
    } else if (framework === 'tensorflow') {
      artifacts.push({
        path: `models/model_${architecture}/`,
        type: 'model', 
        estimatedSize: this.estimateModelFileSize('tensorflow'),
        description: 'TensorFlow SavedModel directory'
      });
    } else if (framework === 'sklearn') {
      artifacts.push({
        path: `models/model_${architecture}.joblib`,
        type: 'model',
        estimatedSize: this.estimateModelFileSize('sklearn'),
        description: 'Scikit-learn model pickle file'
      });
    } else {
      artifacts.push({
        path: `models/model_${architecture}`,
        type: 'model',
        estimatedSize: 1024 * 1024, // 1MB default
        description: 'Custom model file'
      });
    }

    // Common artifacts
    artifacts.push({
      path: 'artifacts/model_info.json',
      type: 'metadata',
      estimatedSize: 2048, // 2KB
      description: 'Model metadata and build information'
    });

    // Index configuration if provided
    if (indexConfig) {
      artifacts.push({
        path: 'artifacts/index_config.json',
        type: 'config',
        estimatedSize: JSON.stringify(indexConfig).length,
        description: 'Index/manifest configuration'
      });
    }

    // Compilation logs
    artifacts.push({
      path: 'artifacts/build.log',
      type: 'metadata',
      estimatedSize: 10240, // 10KB estimated
      description: 'Build process logs'
    });

    return artifacts;
  }

  private estimateModelFileSize(framework: string): number {
    // Rough estimates based on common model sizes
    const estimates = {
      'pytorch': 50 * 1024 * 1024, // 50MB typical CNN
      'tensorflow': 75 * 1024 * 1024, // 75MB typical TF model
      'sklearn': 5 * 1024 * 1024, // 5MB typical sklearn model
      'custom': 10 * 1024 * 1024 // 10MB default
    };

    return estimates[framework as keyof typeof estimates] || estimates.custom;
  }

  private async parseDependencies(): Promise<DependencyInfo[]> {
    const requirementsPath = path.join(this.projectPath, 'requirements.txt');
    
    if (!fs.existsSync(requirementsPath)) {
      return [];
    }

    const content = await fs.readFile(requirementsPath, 'utf8');
    const dependencies: DependencyInfo[] = [];

    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    for (const line of lines) {
      const dep = this.parseDependencyLine(line);
      if (dep) {
        dependencies.push(dep);
      }
    }

    return dependencies;
  }

  private parseDependencyLine(line: string): DependencyInfo | null {
    // Parse dependency line like "torch>=2.0.0" or "numpy>=1.21.0,<1.26.0"
    const match = line.match(/^([a-zA-Z0-9\-_]+)(.*)$/);
    if (!match) return null;

    const [, name, versionSpec] = match;
    
    if (!name) return null;
    
    return {
      name,
      version: versionSpec || '*',
      category: this.categorizeDependency(name),
      estimatedSize: this.estimateDependencySize(name),
      conflicts: this.detectConflicts(name, versionSpec || '')
    };
  }

  private categorizeDependency(name: string): DependencyInfo['category'] {
    const categories = {
      'ml-framework': ['torch', 'tensorflow', 'keras', 'pytorch', 'transformers', 'xgboost'],
      'data-processing': ['numpy', 'pandas', 'scipy', 'scikit-learn', 'matplotlib', 'seaborn', 'pillow'],
      'utility': ['requests', 'tqdm', 'click', 'pyyaml', 'python-dateutil'],
      'development': ['pytest', 'black', 'flake8', 'mypy', 'jupyter']
    };

    const lowerName = name.toLowerCase();
    for (const [category, packages] of Object.entries(categories)) {
      if (packages.some(pkg => lowerName.includes(pkg))) {
        return category as DependencyInfo['category'];
      }
    }

    return 'utility';
  }

  private estimateDependencySize(name: string): number {
    // Rough size estimates for common packages (in bytes)
    const sizes: Record<string, number> = {
      'torch': 800 * 1024 * 1024, // 800MB
      'tensorflow': 500 * 1024 * 1024, // 500MB
      'numpy': 15 * 1024 * 1024, // 15MB
      'pandas': 40 * 1024 * 1024, // 40MB
      'scikit-learn': 25 * 1024 * 1024, // 25MB
      'matplotlib': 30 * 1024 * 1024, // 30MB
      'pillow': 3 * 1024 * 1024, // 3MB
      'requests': 500 * 1024, // 500KB
      'tqdm': 100 * 1024, // 100KB
    };

    const lowerName = name.toLowerCase();
    for (const [pkg, size] of Object.entries(sizes)) {
      if (lowerName.includes(pkg)) {
        return size;
      }
    }

    return 1024 * 1024; // 1MB default
  }

  private detectConflicts(name: string, versionSpec: string): string[] {
    const conflicts: string[] = [];
    
    // Check for known common conflicts
    if (name === 'numpy' && versionSpec.includes('<1.26.0')) {
      conflicts.push('May conflict with newer TensorFlow versions');
    }

    return conflicts;
  }

  private async analyzeModelShape(): Promise<ModelShapeInfo | undefined> {
    const modelPath = path.join(this.projectPath, 'src', 'model.py');
    
    if (!fs.existsSync(modelPath)) {
      return undefined;
    }

    const framework = this.projectConfig.framework || 'custom';
    
    // Basic model analysis - this is a simplified version
    // In a real implementation, we might use AST parsing or dynamic analysis
    const modelContent = await fs.readFile(modelPath, 'utf8');
    
    const inputShape = this.detectInputShape(modelContent, framework);
    const outputShape = this.detectOutputShape(modelContent, framework);
    
    const result: ModelShapeInfo = {
      architecture: this.detectArchitecture(modelContent, framework),
      totalParameters: this.estimateParameters(modelContent, framework),
      trainableParameters: this.estimateParameters(modelContent, framework), // Simplified
      nonTrainableParameters: 0,
      estimatedMemory: this.estimateModelMemory(framework),
      modelSize: this.estimateModelMemory(framework) * 2.5,
      layers: [],
      complexity: 'medium' as const,
      framework,
      warnings: []
    };
    
    if (inputShape) result.inputShape = inputShape;
    if (outputShape) result.outputShape = outputShape;
    
    return result;
  }

  private detectArchitecture(content: string, _framework: string): string {
    const architectures = {
      'CNN': ['Conv2d', 'convolutional', 'conv2d'],
      'RNN': ['LSTM', 'GRU', 'RNN', 'lstm', 'gru'],
      'Transformer': ['MultiHeadAttention', 'transformer', 'attention'],
      'Linear': ['Linear', 'Dense', 'linear', 'dense'],
      'ResNet': ['ResNet', 'resnet', 'residual'],
      'Custom': []
    };

    for (const [arch, keywords] of Object.entries(architectures)) {
      if (keywords.some(keyword => content.includes(keyword))) {
        return arch;
      }
    }

    return 'Custom';
  }

  private estimateParameters(content: string, framework: string): number {
    // Very basic estimation - in reality this would require more sophisticated analysis
    const layerCount = (content.match(/nn\.(Linear|Conv2d|LSTM|GRU)/g) || []).length;
    
    if (framework === 'pytorch') {
      return layerCount * 100000; // Rough estimate: 100k params per layer
    } else if (framework === 'tensorflow') {
      return layerCount * 150000; // TF tends to be slightly larger
    }
    
    return 50000; // Default estimate
  }

  private estimateModelMemory(framework: string): number {
    // Memory estimation based on framework
    const baseMemory = {
      'pytorch': 100 * 1024 * 1024, // 100MB
      'tensorflow': 150 * 1024 * 1024, // 150MB
      'sklearn': 10 * 1024 * 1024, // 10MB
      'custom': 50 * 1024 * 1024 // 50MB
    };

    return baseMemory[framework as keyof typeof baseMemory] || baseMemory.custom;
  }

  private detectInputShape(content: string, _framework: string): string | undefined {
    // Look for common input shape patterns
    const shapePatterns = [
      /input.*\(.*?(\d+,\s*\d+,\s*\d+)\)/,
      /shape.*=.*\((\d+,\s*\d+,\s*\d+)\)/,
      /size.*=.*\((\d+,\s*\d+,\s*\d+)\)/
    ];

    for (const pattern of shapePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return `(batch, ${match[1]})`;
      }
    }

    // Default shapes based on framework
    if (_framework === 'pytorch' || _framework === 'tensorflow') {
      return '(batch, 3, 224, 224)'; // Common image input
    }

    return undefined;
  }

  private detectOutputShape(content: string, _framework: string): string | undefined {
    // Look for output layer definitions
    const outputPatterns = [
      /nn\.Linear.*?(\d+)\)/,
      /Dense.*?(\d+)\)/,
      /num_classes.*?=.*?(\d+)/
    ];

    for (const pattern of outputPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return `(batch, ${match[1]})`;
      }
    }

    return undefined;
  }

  private async estimateResources(architecture: string): Promise<ResourceEstimate> {
    const framework = this.projectConfig.framework || 'custom';
    const isGPU = architecture === 'cuda' || architecture === 'gpu';
    
    // Base resource estimates
    let diskSpace = 100 * 1024 * 1024; // 100MB base
    let memory = 500 * 1024 * 1024; // 500MB base
    let estimatedTime = 60; // 1 minute base
    let gpuMemory = undefined;

    // Adjust based on framework
    if (framework === 'pytorch') {
      diskSpace += 50 * 1024 * 1024; // +50MB
      memory += 200 * 1024 * 1024; // +200MB
      if (isGPU) {
        gpuMemory = 1024 * 1024 * 1024; // 1GB GPU memory
        estimatedTime = 30; // Faster with GPU
      }
    } else if (framework === 'tensorflow') {
      diskSpace += 75 * 1024 * 1024; // +75MB
      memory += 300 * 1024 * 1024; // +300MB
      if (isGPU) {
        gpuMemory = 1.5 * 1024 * 1024 * 1024; // 1.5GB GPU memory
        estimatedTime = 45;
      }
    }

    // Add dependency sizes
    const dependencies = await this.parseDependencies();
    diskSpace += dependencies.reduce((sum, dep) => sum + dep.estimatedSize, 0);

    const resources: ResourceEstimate = {
      diskSpace,
      memory,
      estimatedTime
    };
    
    if (gpuMemory !== undefined) {
      resources.gpuMemory = gpuMemory;
    }
    
    return resources;
  }

  private generateBuildSteps(command: 'compile' | 'build', architecture: string): string[] {
    const steps = [
      'Environment validation',
      'Dependency resolution',
      'Model creation and validation'
    ];

    if (command === 'compile') {
      steps.push(
        `${architecture.toUpperCase()} optimization`,
        'Model compilation',
        'Artifact generation',
        'Integrity testing'
      );
    } else {
      steps.push(
        'Model building',
        `${architecture.toUpperCase()} optimization`,
        'Container preparation',
        'Artifact packaging',
        'Final validation'
      );
    }

    return steps;
  }
}