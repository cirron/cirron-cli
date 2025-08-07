export interface CirronConfig {
  apiUrl: string;
  token?: string;
  defaultEnv: string;
  timeout: number;
  retries: number;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ProjectConfig {
  name: string;
  version: string;
  template: string;
  framework?: 'pytorch' | 'tensorflow' | 'sklearn' | 'custom';
  modelType?: string;
  pythonVersion?: string;
  gpuRequired?: boolean;
  environments: Record<string, EnvironmentConfig>;
  build?: BuildConfig;
  deploy?: DeployConfig;
  artifacts?: ArtifactsConfig;
  test?: TestConfig;
  metadata?: ModelMetadata;
}

export interface ArtifactsConfig {
  modelPath: string;
  checkpointPath: string;
  logsPath: string;
}

export interface TestConfig {
  dataPaths?: {
    sample?: string;
    validation?: string;
    inference?: string;
  };
  fallbackToDummy?: boolean;
  variables?: Record<string, any>;
}

export interface EnvironmentConfig {
  name: string;
  url?: string;
  variables?: Record<string, string>;
  deploymentSettings?: DeploymentSettings;
}

export interface BuildConfig {
  outputDir: string;
  command: string;
  beforeBuild?: string[];
  afterBuild?: string[];
  include?: string[];
  exclude?: string[];
}

export interface DeployConfig {
  provider: 'aws' | 'vercel' | 'netlify' | 'custom';
  settings: Record<string, any>;
  beforeDeploy?: string[];
  afterDeploy?: string[];
}

export interface DeploymentSettings {
  autoScale?: boolean;
  minInstances?: number;
  maxInstances?: number;
  healthCheck?: string;
  timeout?: number;
}

export interface BuildOptions {
  env: string;
  watch?: boolean;
  output?: string;
  clean?: boolean;
  analyze?: boolean;
  tag?: string;
  arch?: string;
  index?: string;
  validate?: boolean;
  push?: boolean;
  strict?: boolean;
  verbose?: boolean;
}

export interface DeployOptions {
  env: string;
  force?: boolean;
  noBuild?: boolean;
  rollback?: boolean;
  message?: string;
}

export interface InitOptions {
  template: string;
  force?: boolean;
  install?: boolean;
  git?: boolean;
}

export interface AuthInfo {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    name?: string;
  };
  token?: string;
  expiresAt?: string;
}

export interface DeploymentInfo {
  id: string;
  environment: string;
  status: 'pending' | 'building' | 'deploying' | 'success' | 'failed';
  createdAt: string;
  completedAt?: string;
  message?: string;
  url?: string;
  logs?: string[];
}

export interface ProjectStatus {
  name: string;
  lastDeployment?: DeploymentInfo;
  environments: string[];
  buildStatus?: 'success' | 'failed' | 'pending';
  isGitClean?: boolean;
  currentBranch?: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

export interface Template {
  name: string;
  description: string;
  repository?: string;
  files: TemplateFile[];
  postInstall?: string[];
}

export interface TemplateFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface ModelMetadata {
  modelClassName?: string;
  inputShape?: string | Record<string, string>;
  architecture?: string;
  gitCommitHash?: string;
  trainingDataShape?: string;
  testDataShape?: string;
  lastUpdated?: string;
  detectedPatterns?: string[];
}

// Plan command interfaces
export interface PlanOptions {
  verbose?: boolean;
  json?: boolean;
  save?: string;
  arch?: string;
  index?: string;
  validate?: boolean;
}

export interface PlanDiff {
  type: 'added' | 'removed' | 'changed';
  category: 'dependencies' | 'artifacts' | 'model' | 'resources' | 'config';
  field: string;
  oldValue?: any;
  newValue?: any;
  impact: 'low' | 'medium' | 'high';
  description: string;
}

export interface PlanComparison {
  planA: {
    timestamp: string;
    command: string;
    framework: string;
  };
  planB: {
    timestamp: string;
    command: string;
    framework: string;
  };
  differences: PlanDiff[];
  summary: {
    totalChanges: number;
    highImpactChanges: number;
    categoryCounts: Record<string, number>;
  };
}

export interface SavedPlan {
  filePath: string;
  plan: any; // PlanFile from plan.ts
  metadata: {
    savedAt: string;
    savedBy?: string;
    description?: string;
    tags?: string[];
  };
}

export interface ReplayOptions {
  plan: string;
  validate?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
}