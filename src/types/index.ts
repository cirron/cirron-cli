/** The CLI's global config, persisted at `~/.cirron/config.json`. `auth` holds device-flow credentials; `token` is the fallback the transport also accepts. */
export interface CirronConfig {
  apiUrl: string;
  auth?: {
    // New JWT auth structure
    accessToken: string;
    refreshToken: string;
    expiresAt?: string;
  };
  defaultEnv: string;
  retries: number;
  timeout: number;
  token?: string;
  version?: number;
}

export interface GlobalSettings {
  api: {
    url: string;
    timeout: number;
    retries: number;
    token?: string;
  };
  cloud: {
    syncSettings: boolean;
    defaultRegion?: string;
    preferredProvider?: "aws" | "azure" | "gcp";
  };
  development: {
    defaultPythonVersion: string;
    preferredIDE: "vscode" | "pycharm" | "jupyter" | "none";
    autoLint: boolean;
    autoFormat: boolean;
  };
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
  version: number;
}

export interface ProjectSettings {
  build: {
    defaultArch: string;
    enableCache: boolean;
    pushOnBuild: boolean;
    validateBeforeBuild: boolean;
  };
  deployment: {
    defaultEnvironment: string;
    autoRollback: boolean;
    healthCheckTimeout: number;
  };
  general: {
    autoSave: boolean;
    buildOnChange: boolean;
    testOnBuild: boolean;
  };
  test: {
    runParallel: boolean;
    failFast: boolean;
    coverageThreshold: number;
    includeBenchmarks: boolean;
  };
  version: number;
}

/** The platform's standard `{ success, data }` envelope. Several routes return a flat body instead — those have their own response types. */
export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
  message?: string;
  success: boolean;
}

/** A project's `cirron.yaml` / `cirron.yml` / `cirron.json`, as loaded from disk. */
export interface ProjectConfig {
  artifacts?: ArtifactsConfig;
  build?: BuildConfig;
  deploy?: DeployConfig;
  description?: string;
  env?: Record<string, string>;
  environments?: Record<string, EnvironmentConfig>;
  framework: "pytorch" | "tensorflow" | "sklearn" | "onnx" | "custom";
  gpuRequired?: boolean;
  hardware?: HardwareConfig;
  metadata?: ModelMetadata;
  // Required core fields, matching the cirron-sample-models reference shape.
  name: string;
  /**
   * Slug of the Cirron Platform this project belongs to.
   *
   * A hint only: the CLI never resolves it locally and never learns a bucket
   * or credential from it. The server validates the slug against the caller's
   * organization and rejects one they do not own. Omitted means the server
   * infers the Platform from the artifact name or falls back to the org
   * default.
   */
  platform?: string;
  profiling?: Record<string, unknown>;

  // Optional because new scaffolds no longer write them, but ten commands
  // still read them; they go once those commands are migrated.
  pythonVersion?: string;
  servingConfig?: ServingConfig;
  settings?: ProjectSettings;
  test?: TestConfig;
  type: string;
  version: string;
}

// Monorepo / workspace configuration

export interface WorkspaceModelEntry {
  path: string;
}

export interface WorkspaceDefaults {
  env?: Record<string, string>;
  profiling?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A root config carrying a `workspace` key, which is what puts the CLI in monorepo mode. */
export interface WorkspaceConfig {
  workspace: {
    defaults?: WorkspaceDefaults;
    models: WorkspaceModelEntry[];
    name: string;
  };
}

export interface ServingConfig {
  class_labels?: string[];
  feature_order?: string[];
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  runtime: string;
}

export interface ArtifactsConfig {
  checkpointPath: string;
  logsPath: string;
  modelPath: string;
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
  deploymentSettings?: DeploymentSettings;
  name: string;
  url?: string;
  variables?: Record<string, string>;
}

export interface BuildConfig {
  afterBuild?: string[];
  beforeBuild?: string[];
  command: string;
  exclude?: string[];
  include?: string[];
  outputDir: string;
}

export interface DeployConfig {
  afterDeploy?: string[];
  beforeDeploy?: string[];
  provider: "aws" | "vercel" | "netlify" | "custom";
  settings: Record<string, any>;
}

export interface DeploymentSettings {
  autoScale?: boolean;
  healthCheck?: string;
  maxInstances?: number;
  minInstances?: number;
  timeout?: number;
}

export interface BuildOptions {
  analyze?: boolean;
  arch?: string;
  clean?: boolean;
  env: string;
  force?: boolean;
  index?: string;
  interactive?: boolean;
  output?: string;
  push?: boolean;
  strict?: boolean;
  tag?: string;
  validate?: boolean;
  verbose?: boolean;
  watch?: boolean;
}

export interface DeployOptions {
  env: string;
  force?: boolean;
  message?: string;
  noBuild?: boolean;
  rollback?: boolean;
}

export interface InitOptions {
  force?: boolean;
  git?: boolean;
  install?: boolean;
  template: string;
}

/** `GET /api/cli/status` response: whether the stored credentials are valid, and who they belong to. */
export interface AuthInfo {
  organization?: {
    id: string;
    name: string;
    type?: string;
  };
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
  valid: boolean;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUrl: string;
}

export interface DeviceTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
}

/**
 * A successful device-flow poll. The platform answers 200 with a flat
 * camelCase body; every non-success case is a 4xx/429 the transport throws on,
 * so there is no `status` discriminator on the wire.
 */
export interface DeviceAuthStatus {
  accessToken?: string;
  expiresIn?: number;
  refreshToken?: string;
  tokenType?: string;
}

export interface DeploymentInfo {
  completedAt?: string;
  createdAt: string;
  environment: string;
  id: string;
  logs?: string[];
  message?: string;
  /**
   * Known states, plus anything else the platform sends — `normalizeDeployment`
   * passes unmapped statuses through lowercased. `string & {}` keeps
   * autocomplete for the literals.
   */
  status:
    | "pending"
    | "building"
    | "deploying"
    | "success"
    | "failed"
    | "rolled_back"
    | (string & {});
  url?: string;
}

/** A deployment as it arrives on the wire, before status casing is normalized. */
export interface RawDeploymentInfo extends Omit<DeploymentInfo, "status"> {
  status: string;
}

/** `POST /api/cli/deployments` and `GET /api/cli/deployments/{id}` response. */
export interface DeploymentResponse {
  data: RawDeploymentInfo;
  success: boolean;
}

/** `GET /api/cli/models/{name}/deployments` response. */
export interface DeploymentListResponse {
  data: RawDeploymentInfo[];
  success: boolean;
}

/** `POST /api/cli/models/{name}/rollback` response. */
export interface RollbackDeploymentResponse {
  deployment: RawDeploymentInfo;
  message: string;
  rolledBackFrom: { id: string; name: string } | null;
  success: boolean;
}

/**
 * An inference key's listable metadata. The key material itself is never
 * returned by any list; the `prefix` (`ifk-` + 8 hex) is the only durable
 * handle for telling keys apart.
 */
export interface InferenceKeyInfo {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string | null;
  prefix: string;
  revokedAt: string | null;
}

/** `POST .../keys` and `POST .../keys/{id}/rotate` response payload. */
export interface IssuedInferenceKey {
  key: InferenceKeyInfo;
  /** Shown exactly once at issue/rotate time; never retrievable again. */
  rawKey: string;
}

/** `GET /api/cli/deployments/{id}/keys` response. */
export interface InferenceKeyListResponse {
  data: { keys: InferenceKeyInfo[] };
  success: boolean;
}

/** `POST /api/cli/deployments/{id}/keys` (and `/rotate`) response. */
export interface InferenceKeyIssueResponse {
  data: IssuedInferenceKey;
  success: boolean;
}

/** Model as returned by `POST /api/cli/models`. */
export interface ModelSummary {
  active?: boolean;
  category?: string;
  createdAt?: string;
  description?: string;
  framework?: string;
  id: string;
  name: string;
  selectedDirectory?: string;
  source?: string;
  updatedAt?: string;
}

/** `POST /api/cli/models` response — `{ success, model }`, not a `{ data }` envelope. */
export interface CreateModelResponse {
  model: ModelSummary;
  success: boolean;
}

/** Local project state, plus remote deployments when `status --remote` can reach the platform. */
export interface ProjectStatus {
  buildStatus?: "success" | "failed" | "pending";
  currentBranch?: string;
  environments: string[];
  isGitClean?: boolean;
  lastDeployment?: DeploymentInfo;
  name: string;
}

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: string;
  timestamp: string;
}

export interface Template {
  description: string;
  files: TemplateFile[];
  name: string;
  postInstall?: string[];
  repository?: string;
}

export interface TemplateFile {
  content: string;
  executable?: boolean;
  path: string;
}

/** Provenance recorded at init or build time — git commit, framework versions — used to detect drift later. */
export interface ModelMetadata {
  architecture?: string;
  detectedPatterns?: string[];
  gitCommitHash?: string;
  inputShape?: string | Record<string, string>;
  lastUpdated?: string;
  modelClassName?: string;
  testDataShape?: string;
  trainingDataShape?: string;
}

// List command types
export interface BuildInfo {
  completedAt?: string;
  createdAt: string;
  duration?: number;
  error?: string;
  id: string;
  projectName?: string;
  status: "SUCCESS" | "FAILED" | "IN_PROGRESS" | "PENDING";
}

export interface ModelInstance {
  endpoint?: string;
  id: string;
  modelInstance?: {
    name: string;
    version: string;
    model?: {
      type: string;
    };
  };
  name: string;
  status?: "ACTIVE" | "DEPLOYING" | "FAILED" | "INACTIVE";
  type?: string;
  version: string;
}

export interface ModelImage {
  createdAt: string;
  id: string;
  name?: string;
  repository?: string;
  size?: number;
  tag?: string;
  updatedAt?: string;
}

export interface RegistryArtifact {
  createdAt: string;
  id: string;
  name: string;
  pipeline?: {
    id: string;
    name: string;
  };
  type: string;
  version?: string;
}

// Plan command interfaces
export interface PlanOptions {
  arch?: string;
  index?: string;
  interactive?: boolean;
  json?: boolean;
  save?: string;
  validate?: boolean;
  verbose?: boolean;
}

export interface PlanDiff {
  category: "dependencies" | "artifacts" | "model" | "resources" | "config";
  description: string;
  field: string;
  impact: "low" | "medium" | "high";
  newValue?: any;
  oldValue?: any;
  type: "added" | "removed" | "changed";
}

/** The result of diffing two plans: what changed, and the impact of each change. */
export interface PlanComparison {
  differences: PlanDiff[];
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
  summary: {
    totalChanges: number;
    highImpactChanges: number;
    categoryCounts: Record<string, number>;
  };
}

/** A stored plan plus the metadata under which it was saved. */
export interface SavedPlan {
  filePath: string;
  metadata: {
    savedAt: string;
    savedBy?: string;
    description?: string;
    tags?: string[];
  };
  plan: any; // PlanFile from plan.ts
}

export interface ReplayOptions {
  dryRun?: boolean;
  force?: boolean;
  plan: string;
  validate?: boolean;
  verbose?: boolean;
}

export interface PlanCompareOptions {
  json?: boolean;
  save?: string;
  verbose?: boolean;
}

export interface PlanSaveOptions {
  all?: boolean;
  cleanup?: number;
  description?: string;
  json?: boolean;
  list?: boolean;
  name?: string;
  tags?: string;
  verbose?: boolean;
}

// Hardware configuration interfaces
/** A detected or declared hardware profile, as persisted in the project config. */
export interface HardwareConfig {
  architecture: string;
  compatibility: FrameworkCompatibility;
  detectedAt?: string;
  isCurrentDevice?: boolean;
  specifications: HardwareSpecs;
  type: "cpu" | "gpu" | "cuda" | "custom";
}

export interface HardwareSpecs {
  cpu?: {
    cores: number;
    model: string;
    architecture: string;
  };
  cuda?: {
    version: string;
    available: boolean;
    devices: CudaDevice[];
  };
  custom?: Record<string, any>;
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
}

export interface CudaDevice {
  computeCapability: string;
  id: number;
  memory: string;
  name: string;
}

export interface FrameworkCompatibility {
  pytorch: boolean;
  requirements?: string[];
  sklearn: boolean;
  tensorflow: boolean;
  warnings?: string[];
}

export interface HardwareOptions {
  configure?: boolean;
  current?: boolean;
  detect?: boolean;
  from?: string;
  interactive?: boolean;
  json?: boolean;
  list?: boolean;
  profile?: string;
  save?: string;
  verbose?: boolean;
}

export interface HardwareProfile {
  config: HardwareConfig;
  description: string;
  frameworks: string[];
  name: string;
  recommended: boolean;
}

// Settings management interfaces
export interface SettingsOptions {
  delete?: string;
  edit?: boolean;
  explain?: string;
  export?: string;
  get?: string;
  global?: boolean;
  import?: string;
  json?: boolean;
  list?: boolean;
  project?: boolean;
  reset?: boolean;
  set?: string;
  template?: string;
  verbose?: boolean;
}

// Config command options (merged config + settings with scope flags)
export interface ConfigCommandOptions {
  delete?: string;
  edit?: boolean;
  explain?: string;
  export?: string;
  get?: string;
  import?: string;
  json?: boolean;
  // Operations (superset of config + settings)
  list?: boolean;
  reset?: boolean;
  // Scope flag
  scope?: "cli" | "global" | "project";
  set?: string;
  template?: string;
  verbose?: boolean;
}

export interface SettingsSource {
  file?: string;
  type: "default" | "global" | "project" | "cli";
  value: any;
}

export interface SettingsResolution {
  key: string;
  overriddenBy?: SettingsSource[];
  source: SettingsSource;
  value: any;
}

export interface SettingsTemplate {
  category: "ml" | "web" | "api" | "general";
  description: string;
  globalSettings?: Partial<GlobalSettings>;
  name: string;
  projectSettings?: Partial<ProjectSettings>;
  tags?: string[];
}

export interface SettingsExport {
  globalSettings?: GlobalSettings;
  metadata?: {
    exportedBy?: string;
    description?: string;
    tags?: string[];
  };
  projectSettings?: ProjectSettings;
  timestamp: string;
  type: "global" | "project" | "combined";
  version: number;
}

export interface SettingsValidationError {
  message: string;
  path: string;
  schema?: any;
  value: any;
}

export interface ModelConfig {
  architecture?: string;
  data?: {
    inputFormat?: string;
    outputFormat?: string;
    preprocessing?: string[];
    postprocessing?: string[];
  };
  dependencies?: {
    python?: string;
    packages?: Record<string, string>;
    requirements?: string[];
  };
  framework?: "pytorch" | "tensorflow" | "sklearn" | "custom";
  inference?: {
    device?: "cpu" | "gpu" | "cuda";
    precision?: "fp32" | "fp16" | "int8";
    batchSize?: number;
  };
  inputShape?: string | Record<string, string>;
  metadata?: {
    author?: string;
    description?: string;
    version?: string;
    created?: string;
    updated?: string;
    tags?: string[];
  };
  modelType?: string;
  name?: string;
  outputShape?: string | Record<string, string>;
  parameters?: {
    total?: number;
    trainable?: number;
    nonTrainable?: number;
  };
  training?: {
    epochs?: number;
    batchSize?: number;
    learningRate?: number;
    optimizer?: string;
    loss?: string;
    metrics?: string[];
  };
  version?: number;
}

// Run command types

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type RunPriority = "low" | "normal" | "high" | "critical";

export type SweepStrategy = "grid" | "random" | "bayesian";

export interface RunInfo {
  completedAt?: string;
  createdAt: string;
  duration?: number;
  error?: string;
  gpu?: string;
  id: string;
  metadata?: Record<string, unknown>;
  name?: string;
  pipeline?: {
    id: string;
    name: string;
  };
  priority?: RunPriority;
  startedAt?: string;
  status: RunStatus;
  tags?: string[];
  type: "pipeline" | "job" | "inference" | "sweep";
}

export interface RunPipelineOptions {
  config?: string;
  dryRun?: boolean;
  gpu?: string;
  priority?: string;
  tag?: string;
  watch?: boolean;
}

export interface RunListOptions {
  json?: boolean;
  last?: string;
  pipeline?: string;
  status?: string;
}

export interface RunStatusOptions {
  json?: boolean;
  watch?: boolean;
}

export interface RunCancelOptions {
  force?: boolean;
}

export interface RunLogsOptions {
  follow?: boolean;
  lines?: string;
}

export interface RunJobOptions {
  config?: string;
  dryRun?: boolean;
  gpu?: string;
  priority?: string;
}

export interface RunInferenceOptions {
  batchSize?: string;
  input?: string;
  model?: string;
  output?: string;
  watch?: boolean;
}

export interface RunSweepOptions {
  config?: string;
  parallel?: string;
  strategy?: string;
  trials?: string;
  watch?: boolean;
}

export interface PipelineConfig {
  gpu?: string;
  name?: string;
  parameters?: Record<string, unknown>;
  priority?: RunPriority;
  steps?: PipelineStep[];
  tags?: string[];
}

export interface PipelineStep {
  command?: string;
  dependsOn?: string[];
  image?: string;
  name: string;
  resources?: {
    gpu?: string;
    memory?: string;
    cpu?: string;
  };
}

// Pull command types

export type PullResourceType = "model" | "image" | "build" | "runtime";

export interface PullOptions {
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  ignore?: string;
  interactive?: boolean;
  json?: boolean;
  output?: string;
  registry?: string;
  tag?: string;
  type?: string;
}

export interface PullArtifactInfo {
  checksum: string;
  createdAt: string;
  filename: string;
  id: string;
  name: string;
  size: number;
  tag: string;
  type: string;
}

export interface PullDownloadInfo {
  artifactId: string;
  downloadUrl: string;
  expiresAt: string;
}

export interface PullResult {
  artifact: PullArtifactInfo;
  outputPath: string;
  skipped: boolean;
  verified: boolean;
}

// Push command types

export type PushResourceType = "model" | "image" | "build" | "runtime";

export interface PushOptions {
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  ignore?: string;
  json?: boolean;
  message?: string;
  /** `--platform <slug>`; overrides `platform` in the project config. */
  platform?: string;
  registry?: string;
  tag?: string;
}

export interface PushFileInfo {
  checksum: string;
  filePath: string;
  relativePath: string;
  size: number;
}

export interface PushArtifactInfo {
  checksum: string;
  createdAt: string;
  filename: string;
  id: string;
  name: string;
  size: number;
  tag: string;
  type: string;
}

export interface PushUploadUrl {
  chunkSize: number;
  expiresAt: string;
  maxChunks: number;
  uploadId: string;
  uploadUrl: string;
}

export interface PushDedupeResult {
  artifactId?: string;
  artifactName?: string;
  exists: boolean;
  tag?: string;
}

export interface PushConfirmation {
  artifactId: string;
  checksum: string;
  createdAt: string;
  name: string;
  size: number;
  tag: string;
  type: string;
  versionId: string;
}

export interface PushSessionInfo {
  checksum: string;
  chunkChecksums: Record<number, string>;
  chunkSize: number;
  completedChunks: number[];
  createdAt: string;
  filePath: string;
  /** True when the session is backed by a provider-native multipart upload. */
  multipart?: boolean;
  sessionId: string;
  totalChunks: number;
  totalSize: number;
  updatedAt: string;
  uploadUrl: string;
}

/**
 * Multipart upload contract. `partSize` and `partCount` are authoritative:
 * the server owns the part geometry and the client slices to whatever it
 * returns. `multipartThreshold` is echoed back so a client can detect that its
 * own cutover constant has drifted from the server's.
 */
export interface PushMultipartInit {
  multipartThreshold: number;
  partCount: number;
  partSize: number;
  sessionId: string;
  /** The storage provider's multipart upload id, not the session id. */
  uploadId: string;
}

export interface PushMultipartPartUrl {
  expiresAt: string;
  partNumber: number;
  url: string;
}

export interface PushMultipartPartRecord {
  completedParts: number;
  partNumber: number;
  totalParts: number;
}

export interface PushMultipartComplete {
  partCount: number;
  sessionId: string;
}

export interface PushMultipartAbort {
  aborted: boolean;
  sessionId: string;
}

export interface PushResult {
  artifact: PushArtifactInfo;
  file: PushFileInfo;
  skipped: boolean;
  skipReason?: string;
  verified: boolean;
}

export interface PushSummary {
  failed: number;
  results: PushResult[];
  skipped: number;
  tag: string;
  totalBytes: number;
  totalFiles: number;
  uploaded: number;
  uploadedBytes: number;
}

// Sync command types

export type SyncConflictStrategy =
  | "keep-both"
  | "local-wins"
  | "remote-wins"
  | "prompt";

export interface SyncOptions {
  conflicts?: string;
  dryRun?: boolean;
  exclude?: string;
  force?: boolean;
  json?: boolean;
  pullOnly?: boolean;
  pushOnly?: boolean;
  verbose?: boolean;
}

export interface SyncFileManifestEntry {
  checksum: string;
  path: string;
  size: number;
}

export interface SyncRemoteFileEntry {
  artifactId: string;
  artifactName: string;
  checksum: string;
  createdAt: string;
  path: string;
  size: number;
  tag: string;
  type: string;
}

export interface SyncChangedFileEntry {
  artifactId: string;
  artifactName: string;
  localChecksum: string;
  localSize: number;
  path: string;
  remoteChecksum: string;
  remoteSize: number;
  tag: string;
  type: string;
}

export interface SyncConflictEntry {
  artifactId: string;
  artifactName: string;
  localChecksum: string;
  localSize: number;
  path: string;
  remoteChecksum: string;
  remoteSize: number;
  tag: string;
  type: string;
}

export interface SyncDiffResult {
  changedLocally: SyncChangedFileEntry[];
  changedRemotely: SyncChangedFileEntry[];
  conflicts: SyncConflictEntry[];
  localOnly: SyncFileManifestEntry[];
  remoteOnly: SyncRemoteFileEntry[];
  unchanged: SyncFileManifestEntry[];
}

export type SyncConflictResolution =
  | "skip"
  | "overwrite-local"
  | "overwrite-remote"
  | "keep-both";

export interface SyncSummary {
  conflictsResolved: number;
  conflictsSkipped: number;
  failed: number;
  pulled: number;
  pushed: number;
  totalChangedLocally: number;
  totalChangedRemotely: number;
  totalConflicts: number;
  totalLocalOnly: number;
  totalRemoteOnly: number;
  unchanged: number;
}
