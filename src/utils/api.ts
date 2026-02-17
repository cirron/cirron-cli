import fetch from 'node-fetch';
import { createWriteStream } from 'fs';
import type {
  CirronConfig,
  ApiResponse,
  AuthInfo,
  DeploymentInfo,
  LogEntry,
  DeviceCodeResponse,
  DeviceTokenResponse,
  DeviceAuthStatus,
  RunInfo,
  PullArtifactInfo,
  PullDownloadInfo
} from '../types';

export class CirronApi {
  private config: CirronConfig;

  constructor(config: CirronConfig) {
    this.config = config;
  }

  async verifyAuth(): Promise<AuthInfo> {
    const response = await this.request('/api/cli/status');
    return response as any;
  }

  // Device Flow Authentication Methods
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.request('/api/cli/auth/device', { method: 'POST' });
    return response as any;
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthStatus> {
    const response = await this.request(`/api/cli/auth/device?device_code=${deviceCode}`);
    return response as any;
  }

  async refreshToken(refreshToken: string): Promise<DeviceTokenResponse> {
    const response = await this.requestRaw('/api/cli/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken }
    });
    return response.data;
  }

  async validateAuth(): Promise<{ valid: boolean; user?: any }> {
    const response = await this.request('/api/cli/status');
    return response.data;
  }

  async createProject(projectData: {
    name: string;
    template: string;
    path: string;
  }): Promise<any> {
    const response = await this.request('/api/cli/models', {
      method: 'POST',
      body: projectData
    });
    return response.data;
  }

  async createDeployment(deploymentData: {
    projectName: string;
    environment: string;
    message: string;
    buildConfig: any;
    deployConfig: any;
    envConfig: any;
  }): Promise<DeploymentInfo> {
    const response = await this.request('/api/cli/deployments', {
      method: 'POST',
      body: deploymentData
    });
    return response.data;
  }

  async getDeployment(deploymentId: string): Promise<DeploymentInfo> {
    const response = await this.request(`/api/cli/deployments/${deploymentId}`);
    return response.data;
  }

  async getDeployments(
    projectName: string, 
    options: {
      environment?: string;
      status?: string;
      limit?: number;
    } = {}
  ): Promise<DeploymentInfo[]> {
    const params = new URLSearchParams();
    if (options.environment) params.append('environment', options.environment);
    if (options.status) params.append('status', options.status);
    if (options.limit) params.append('limit', options.limit.toString());

    const response = await this.request(`/api/cli/models/${projectName}/deployments?${params}`);
    return response.data;
  }

  async rollbackDeployment(
    projectName: string,
    environment: string,
    deploymentId: string
  ): Promise<DeploymentInfo> {
    const response = await this.request(`/api/cli/models/${projectName}/rollback`, {
      method: 'POST',
      body: {
        environment,
        deploymentId
      }
    });
    return response.data;
  }

  async reportBuild(buildData: {
    projectName: string;
    environment: string;
    status: 'success' | 'failed';
    timestamp: string;
    error?: string;
  }): Promise<void> {
    await this.request('/api/cli/builds', {
      method: 'POST',
      body: buildData
    });
  }

  async getLogs(
    projectName: string,
    environment: string,
    options: {
      lines?: number;
      since?: string;
    } = {}
  ): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (options.lines) params.append('lines', options.lines.toString());
    if (options.since) params.append('since', options.since);

    const response = await this.request(
      `/api/cli/models/${projectName}/logs/${environment}?${params}`
    );
    return response.data;
  }

  async getEnvironmentVariables(
    projectName: string,
    environment: string
  ): Promise<Record<string, string>> {
    const response = await this.request(
      `/api/cli/models/${projectName}/env/${environment}`
    );
    return response.data;
  }

  async setEnvironmentVariable(
    projectName: string,
    environment: string,
    key: string,
    value: string
  ): Promise<void> {
    await this.request(`/api/cli/models/${projectName}/env/${environment}`, {
      method: 'PUT',
      body: { [key]: value }
    });
  }

  async deleteEnvironmentVariable(
    projectName: string,
    environment: string,
    key: string
  ): Promise<void> {
    await this.request(`/api/cli/models/${projectName}/env/${environment}/${key}`, {
      method: 'DELETE'
    });
  }

  // List command methods
  async getBuilds(options: {
    limit?: number;
    status?: string;
    projectId?: string;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.status) params.append('status', options.status);
    if (options.projectId) params.append('projectId', options.projectId);

    const response = await this.request(`/api/cli/builds?${params}`);
    return response.data || [];
  }

  async getModelInstances(options: {
    limit?: number;
    modelId?: string;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.modelId) params.append('modelId', options.modelId);

    const response = await this.request(`/api/cli/models?${params}`);
    return response.data || response || [];
  }

  async getModelImages(options: {
    limit?: number;
    modelId?: string;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.modelId) params.append('modelId', options.modelId);

    const response = await this.request(`/api/cli/images/models?${params}`);
    return response.data || [];
  }

  async getRegistryArtifacts(options: {
    limit?: number;
    type?: string;
    pipelineId?: string;
    nodeId?: string;
    latest?: boolean;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.type) params.append('type', options.type);
    if (options.pipelineId) params.append('pipelineId', options.pipelineId);
    if (options.nodeId) params.append('nodeId', options.nodeId);
    if (options.latest) params.append('latest', 'true');

    const response = await this.request(`/api/cli/registry/artifacts?${params}`);
    return response.data?.artifacts || response.data || [];
  }

  async getDeploymentExecutions(options: {
    limit?: number;
    modelInstanceId?: string;
    modelId?: string;
  } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.modelInstanceId) params.append('modelInstanceId', options.modelInstanceId);
    if (options.modelId) params.append('modelId', options.modelId);

    const response = await this.request(`/api/cli/deployments/versions?${params}`);
    return response.data || response || [];
  }

  // Run command methods

  async triggerPipelineRun(pipelineNameOrId: string, options: {
    config?: Record<string, unknown>;
    gpu?: string;
    priority?: string;
    tags?: string[];
  } = {}): Promise<RunInfo> {
    const response = await this.request(`/api/cli/pipelines/${encodeURIComponent(pipelineNameOrId)}/run`, {
      method: 'POST',
      body: {
        gpu: options.gpu,
        priority: options.priority,
        tags: options.tags,
        config: options.config,
      }
    });
    return response.data;
  }

  async getRun(runId: string): Promise<RunInfo> {
    const response = await this.request(`/api/cli/runs/${encodeURIComponent(runId)}`);
    return response.data;
  }

  async getRuns(options: {
    status?: string;
    limit?: number;
    pipeline?: string;
  } = {}): Promise<RunInfo[]> {
    const params = new URLSearchParams();
    if (options.status) params.append('status', options.status);
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.pipeline) params.append('pipeline', options.pipeline);

    const response = await this.request(`/api/cli/runs?${params}`);
    return response.data || [];
  }

  async cancelRun(runId: string, options: {
    force?: boolean;
  } = {}): Promise<RunInfo> {
    const response = await this.request(`/api/cli/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: { force: options.force }
    });
    return response.data;
  }

  async getRunLogs(runId: string, options: {
    lines?: number;
    since?: string;
  } = {}): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (options.lines) params.append('lines', options.lines.toString());
    if (options.since) params.append('since', options.since);

    const response = await this.request(`/api/cli/runs/${encodeURIComponent(runId)}/logs?${params}`);
    return response.data || [];
  }

  // Pull command methods

  async getPullArtifacts(options: {
    resource?: string;
    name?: string;
    tag?: string;
    projectName?: string;
    type?: string;
    path?: string;
  } = {}): Promise<PullArtifactInfo[]> {
    const params = new URLSearchParams();
    if (options.resource) params.append('resource', options.resource);
    if (options.name) params.append('name', options.name);
    if (options.tag) params.append('tag', options.tag);
    if (options.projectName) params.append('projectName', options.projectName);
    if (options.type) params.append('type', options.type);
    if (options.path) params.append('path', options.path);

    const response = await this.request(`/api/cli/registry/pull?${params}`);
    return response.data?.artifacts || response.data || [];
  }

  async getPullDownloadUrl(artifactId: string): Promise<PullDownloadInfo> {
    const params = new URLSearchParams();
    params.append('artifactId', artifactId);

    const response = await this.request(`/api/cli/registry/pull/download?${params}`);
    return response.data;
  }

  async downloadFile(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<void> {
    await this.ensureValidToken();

    // Don't send auth headers to external presigned URLs (S3/GCS) —
    // the presigned URL already contains its own auth credentials
    const headers: Record<string, string> = {
      'User-Agent': 'cirron-cli/1.0.0',
    };

    let attempt = 0;
    let lastError: Error;

    while (attempt <= this.config.retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout * 10); // 10x normal timeout for large downloads

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Download failed: empty response body');
        }

        const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
        let downloaded = 0;

        const fileStream = createWriteStream(destPath);

        await new Promise<void>((resolve, reject) => {
          response.body!.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (onProgress && totalSize > 0) {
              onProgress(downloaded, totalSize);
            }
          });

          response.body!.pipe(fileStream);

          response.body!.on('error', (err: Error) => {
            fileStream.close();
            reject(err);
          });

          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });

          fileStream.on('error', (err: Error) => {
            reject(err);
          });
        });

        return;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error &&
            (error.message.includes('401') || error.message.includes('403'))) {
          throw error;
        }

        attempt++;
        if (attempt <= this.config.retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError!;
  }

  private getAuthHeader(): string | undefined {
    // Try JWT token first
    if (this.config.auth?.accessToken) {
      return `Bearer ${this.config.auth.accessToken}`;
    }
    // Fallback to legacy sk-* token
    if (this.config.token) {
      return `Bearer ${this.config.token}`;
    }
    return undefined;
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.config.auth?.expiresAt || !this.config.auth?.refreshToken) {
      return; // No JWT auth or refresh token available
    }
    
    const expiresAt = new Date(this.config.auth.expiresAt);
    const now = new Date();
    const fiveMinutes = 5 * 60 * 1000;
    
    // Refresh if expires within 5 minutes
    if (expiresAt.getTime() - now.getTime() < fiveMinutes) {
      try {
        const newTokens = await this.refreshToken(this.config.auth.refreshToken);
        
        // Update config with new tokens
        const { ConfigManager } = await import('./config');
        const configManager = new ConfigManager();
        const currentConfig = configManager.load();
        
        const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
        currentConfig.auth = {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
          expiresAt
        };
        
        configManager.save(currentConfig);
        
        // Update this instance's config
        this.config = currentConfig;
      } catch (error) {
        // If refresh fails, continue with existing token and let the API request fail
        // Don't log refresh errors automatically - let calling code handle them
      }
    }
  }

  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      isFormData?: boolean;
    } = {}
  ): Promise<ApiResponse> {
    // Ensure token is valid before making request
    await this.ensureValidToken();
    
    return this.requestRaw(endpoint, options);
  }

  private async requestRaw(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      isFormData?: boolean;
    } = {}
  ): Promise<ApiResponse> {
    const url = new URL(endpoint, this.config.apiUrl);
    const method = options.method || 'GET';
    
    const headers: Record<string, string> = {
      'User-Agent': 'cirron-cli/1.0.0',
      ...options.headers
    };

    // Support both JWT and legacy token authentication
    const authHeader = this.getAuthHeader();
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    let body: any = undefined;
    if (options.body) {
      if (options.isFormData) {
        body = options.body;
        // Let form-data set the content-type
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.timeout);

    let attempt = 0;
    let lastError: Error;

    while (attempt <= this.config.retries) {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage = (errorData as any)?.message || 
                              (errorData as any)?.error || 
                              `HTTP ${response.status}: ${response.statusText}`;
          throw new Error(errorMessage);
        }

        const data = await response.json();
        return data as ApiResponse;

      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on authentication errors
        if (error instanceof Error && 
            (error.message.includes('401') || error.message.includes('403'))) {
          throw error;
        }

        attempt++;
        if (attempt <= this.config.retries) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    clearTimeout(timeoutId);
    throw lastError!;
  }
}
