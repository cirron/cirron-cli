export interface CirronConfig {
  version?: number;
  apiUrl: string;
  token?: string;           // Keep for backward compatibility with sk-* tokens
  auth?: {                  // New JWT auth structure
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  };
  defaultEnv: string;
  timeout: number;
  retries: number;
}

export interface GlobalSettings {
  version: number;
  general: {
    defaultTemplate: string;
    autoUpdate: boolean;
    telemetry: boolean;
    verboseLogging: boolean;
  };
  ui: {
    colorOutput: boolean;
    progressBars: boolean;
    confirmPrompts: boolean;
    interactiveMode: boolean;
  };
  development: {
    defaultPythonVersion: string;
    preferredIDE: 'vscode' | 'pycharm' | 'jupyter' | 'none';
    autoLint: boolean;
    autoFormat: boolean;
  };
  cloud: {
    syncSettings: boolean;
    defaultRegion?: string;
    preferredProvider?: 'aws' | 'azure' | 'gcp';
  };
  api: {
    url: string;
    timeout: number;
    retries: number;
    token?: string;
  };
}

export interface ProjectSettings {
  version: number;
  general: {
    autoSave: boolean;
    buildOnChange: boolean;
    testOnBuild: boolean;
  };
  build: {
    defaultArch: string;
    enableCache: boolean;
    pushOnBuild: boolean;
    validateBeforeBuild: boolean;
  };
  test: {
    runParallel: boolean;
    failFast: boolean;
    coverageThreshold: number;
    includeBenchmarks: boolean;
  };
  deployment: {
    defaultEnvironment: string;
    autoRollback: boolean;
    healthCheckTimeout: number;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ProjectConfig {
  version?: number;
  name: string;
  projectVersion: string;
  template: string;
  framework?: 'pytorch' | 'tensorflow' | 'sklearn' | 'custom';
  modelType?: string;
  pythonVersion?: string;
  gpuRequired?: boolean;
  hardware?: HardwareConfig;
  environments: Record<string, EnvironmentConfig>;
  build?: BuildConfig;
  deploy?: DeployConfig;
  artifacts?: ArtifactsConfig;
  test?: TestConfig;
  metadata?: ModelMetadata;
  settings?: ProjectSettings;
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
  force?: boolean;
  interactive?: boolean;
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
  valid: boolean;
  token?: {
    id: string;
    name: string;
    expiresAt: string;
    scopes: string[];
  };
  user?: {
    id: string;
    email: string;
    name?: string;
  };
  organization?: {
    id: string;
    name: string;
    type?: string;
  };
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface DeviceAuthStatus {
  status: 'pending' | 'authorized' | 'expired' | 'denied';
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
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

// List command types
export interface BuildInfo {
  id: string;
  projectName?: string;
  status: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS' | 'PENDING';
  createdAt: string;
  completedAt?: string;
  duration?: number;
  error?: string;
}

export interface ModelInstance {
  id: string;
  name: string;
  version: string;
  type?: string;
  status?: 'ACTIVE' | 'DEPLOYING' | 'FAILED' | 'INACTIVE';
  endpoint?: string;
  modelInstance?: {
    name: string;
    version: string;
    model?: {
      type: string;
    };
  };
}

export interface ModelImage {
  id: string;
  name?: string;
  repository?: string;
  tag?: string;
  size?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface RegistryArtifact {
  id: string;
  name: string;
  type: string;
  version?: string;
  pipeline?: {
    id: string;
    name: string;
  };
  createdAt: string;
}

// Plan command interfaces
export interface PlanOptions {
  verbose?: boolean;
  json?: boolean;
  save?: string;
  arch?: string;
  index?: string;
  validate?: boolean;
  interactive?: boolean;
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

export interface PlanCompareOptions {
  verbose?: boolean;
  json?: boolean;
  save?: string;
}

export interface PlanSaveOptions {
  all?: boolean;
  name?: string;
  description?: string;
  tags?: string;
  list?: boolean;
  cleanup?: number;
  verbose?: boolean;
  json?: boolean;
}

// Hardware configuration interfaces
export interface HardwareConfig {
  type: 'cpu' | 'gpu' | 'cuda' | 'custom';
  architecture: string;
  specifications: HardwareSpecs;
  compatibility: FrameworkCompatibility;
  detectedAt?: string;
  isCurrentDevice?: boolean;
}

export interface HardwareSpecs {
  cpu?: {
    cores: number;
    model: string;
    architecture: string;
  };
  gpu?: {
    model: string;
    memory: string;
    computeCapability?: string;
    drivers?: string;
  };
  memory?: {
    total: string;
    available: string;
  };
  cuda?: {
    version: string;
    available: boolean;
    devices: CudaDevice[];
  };
  custom?: Record<string, any>;
}

export interface CudaDevice {
  id: number;
  name: string;
  memory: string;
  computeCapability: string;
}

export interface FrameworkCompatibility {
  pytorch: boolean;
  tensorflow: boolean;
  sklearn: boolean;
  requirements?: string[];
  warnings?: string[];
}

export interface HardwareOptions {
  detect?: boolean;
  configure?: boolean;
  list?: boolean;
  profile?: string;
  save?: string;
  from?: string;
  current?: boolean;
  interactive?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface HardwareProfile {
  name: string;
  description: string;
  config: HardwareConfig;
  frameworks: string[];
  recommended: boolean;
}

// Settings management interfaces
export interface SettingsOptions {
  global?: boolean;
  project?: boolean;
  list?: boolean;
  get?: string;
  set?: string;
  delete?: string;
  edit?: boolean;
  export?: string;
  import?: string;
  template?: string;
  explain?: string;
  reset?: boolean;
  verbose?: boolean;
  json?: boolean;
}

export interface SettingsSource {
  type: 'default' | 'global' | 'project' | 'cli';
  file?: string;
  value: any;
}

export interface SettingsResolution {
  key: string;
  value: any;
  source: SettingsSource;
  overriddenBy?: SettingsSource[];
}

export interface SettingsTemplate {
  name: string;
  description: string;
  category: 'ml' | 'web' | 'api' | 'general';
  globalSettings?: Partial<GlobalSettings>;
  projectSettings?: Partial<ProjectSettings>;
  tags?: string[];
}

export interface SettingsExport {
  version: number;
  timestamp: string;
  type: 'global' | 'project' | 'combined';
  globalSettings?: GlobalSettings;
  projectSettings?: ProjectSettings;
  metadata?: {
    exportedBy?: string;
    description?: string;
    tags?: string[];
  };
}

export interface SettingsValidationError {
  path: string;
  message: string;
  value: any;
  schema?: any;
}

export interface ModelConfig {
  version?: number;
  name?: string;
  architecture?: string;
  framework?: 'pytorch' | 'tensorflow' | 'sklearn' | 'custom';
  modelType?: string;
  parameters?: {
    total?: number;
    trainable?: number;
    nonTrainable?: number;
  };
  inputShape?: string | Record<string, string>;
  outputShape?: string | Record<string, string>;
  training?: {
    epochs?: number;
    batchSize?: number;
    learningRate?: number;
    optimizer?: string;
    loss?: string;
    metrics?: string[];
  };
  inference?: {
    device?: 'cpu' | 'gpu' | 'cuda';
    precision?: 'fp32' | 'fp16' | 'int8';
    batchSize?: number;
  };
  data?: {
    inputFormat?: string;
    outputFormat?: string;
    preprocessing?: string[];
    postprocessing?: string[];
  };
  metadata?: {
    author?: string;
    description?: string;
    version?: string;
    created?: string;
    updated?: string;
    tags?: string[];
  };
  dependencies?: {
    python?: string;
    packages?: Record<string, string>;
    requirements?: string[];
  };
}