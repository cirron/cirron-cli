import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import fs from "fs-extra";
import type {
  ApiResponse,
  AuthInfo,
  CirronConfig,
  CreateModelResponse,
  DeploymentInfo,
  DeploymentListResponse,
  DeploymentResponse,
  DeviceAuthStatus,
  DeviceCodeResponse,
  DeviceTokenResponse,
  LogEntry,
  ModelSummary,
  PullArtifactInfo,
  PullDownloadInfo,
  PushConfirmation,
  PushDedupeResult,
  PushSessionInfo,
  PushUploadUrl,
  RawDeploymentInfo,
  RollbackDeploymentResponse,
  RunInfo,
  SyncDiffResult,
} from "../types";
import {
  classifyFetchError,
  classifyHttpError,
  NotAuthenticatedError,
  PlatformBadRequestError,
  PlatformError,
  PlatformRateLimitError,
} from "./api-errors";
import { USER_AGENT } from "./version";

/**
 * Platform deployment status -> the CLI's lowercase union.
 *
 * `GET /api/cli/deployments/{id}` returns an already-lowercased status, while
 * the list and create endpoints return the raw stored value. This map
 * normalizes both onto a single union.
 */
const DEPLOYMENT_STATUS_MAP: Record<string, DeploymentInfo["status"]> = {
  ACTIVE: "success",
  BUILDING: "building",
  DEPLOYING: "deploying",
  ERROR: "failed",
  FAILED: "failed",
  HEALTHY: "success",
  PENDING: "pending",
  QUEUED: "pending",
  ROLLED_BACK: "rolled_back",
  RUNNING: "success",
};

export class CirronApi {
  private config: CirronConfig;

  constructor(config: CirronConfig) {
    this.config = config;
  }

  async verifyAuth(): Promise<AuthInfo> {
    const response = await this.request("/api/cli/status");
    return response as any;
  }

  // Device Flow Authentication Methods
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.request("/api/cli/auth/device", {
      method: "POST",
    });
    return response as any;
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthStatus> {
    const response = await this.request(
      `/api/cli/auth/device?device_code=${deviceCode}`
    );
    return response as any;
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * `POST /api/cli/auth/refresh` returns a flat snake_case body rather than
   * the `{ success, data }` envelope, which `DeviceTokenResponse` already
   * models exactly.
   */
  async refreshToken(refreshToken: string): Promise<DeviceTokenResponse> {
    return await this.requestRaw<DeviceTokenResponse>("/api/cli/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
    });
  }

  /**
   * Validate the stored credentials.
   *
   * `GET /api/cli/status` returns a flat `{ valid, token, user, organization }`
   * body rather than the `{ success, data }` envelope.
   */
  async validateAuth(): Promise<AuthInfo> {
    return await this.request<AuthInfo>("/api/cli/status");
  }

  /**
   * Register a new model with the platform.
   *
   * `POST /api/cli/models` returns `{ success, model }` rather than the
   * `{ success, data }` envelope.
   */
  async createProject(projectData: {
    name: string;
    framework: string;
    path: string;
    type?: string;
    servingConfig?: Record<string, any>;
    repositoryId?: string;
    repositoryPath?: string;
  }): Promise<ModelSummary> {
    const response = await this.request<CreateModelResponse>(
      "/api/cli/models",
      {
        method: "POST",
        body: projectData,
      }
    );
    return response.model;
  }

  /**
   * Create a deployment.
   *
   * The platform keys off `modelId`/`modelName` and ignores `projectName`, so
   * `modelName` is sent alongside it.
   */
  async createDeployment(deploymentData: {
    projectName: string;
    environment: string;
    message: string;
    buildConfig: any;
    deployConfig: any;
    envConfig: any;
  }): Promise<DeploymentInfo> {
    const response = await this.request<DeploymentResponse>(
      "/api/cli/deployments",
      {
        method: "POST",
        body: { ...deploymentData, modelName: deploymentData.projectName },
      }
    );
    return this.normalizeDeployment(response.data);
  }

  async getDeployment(deploymentId: string): Promise<DeploymentInfo> {
    const response = await this.request<DeploymentResponse>(
      `/api/cli/deployments/${deploymentId}`
    );
    return this.normalizeDeployment(response.data);
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
    if (options.environment) {
      params.append("environment", options.environment);
    }
    if (options.status) {
      params.append("status", options.status);
    }
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }

    const response = await this.request<DeploymentListResponse>(
      `/api/cli/models/${projectName}/deployments?${params}`
    );
    return response.data.map((deployment) =>
      this.normalizeDeployment(deployment)
    );
  }

  /**
   * Roll an environment back to a previous deployment.
   *
   * `POST /api/cli/models/{name}/rollback` returns
   * `{ success, message, deployment, rolledBackFrom }` rather than the
   * `{ success, data }` envelope.
   */
  async rollbackDeployment(
    projectName: string,
    environment: string,
    deploymentId: string
  ): Promise<DeploymentInfo> {
    const response = await this.request<RollbackDeploymentResponse>(
      `/api/cli/models/${projectName}/rollback`,
      {
        method: "POST",
        body: {
          environment,
          deploymentId,
        },
      }
    );
    return this.normalizeDeployment(response.deployment);
  }

  /**
   * Report a build result to the platform.
   *
   * The platform keys off `modelId`/`modelName` and ignores `projectName`, so
   * `modelName` is sent alongside it.
   */
  async reportBuild(buildData: {
    projectName: string;
    environment: string;
    status: "success" | "failed";
    timestamp: string;
    error?: string;
  }): Promise<void> {
    await this.request("/api/cli/builds", {
      method: "POST",
      body: { ...buildData, modelName: buildData.projectName },
    });
  }

  /**
   * Normalize a wire deployment's status onto the CLI's lowercase union.
   *
   * The status field is an open string rather than a closed set, so the
   * toLowerCase() fallback covers any state the map does not list.
   */
  private normalizeDeployment(deployment: RawDeploymentInfo): DeploymentInfo {
    return {
      ...deployment,
      status:
        DEPLOYMENT_STATUS_MAP[deployment.status] ??
        deployment.status.toLowerCase(),
    };
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
    if (options.lines) {
      params.append("lines", options.lines.toString());
    }
    if (options.since) {
      params.append("since", options.since);
    }

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
      method: "PUT",
      body: { [key]: value },
    });
  }

  async deleteEnvironmentVariable(
    projectName: string,
    environment: string,
    key: string
  ): Promise<void> {
    await this.request(
      `/api/cli/models/${projectName}/env/${environment}/${key}`,
      {
        method: "DELETE",
      }
    );
  }

  // List command methods
  async getBuilds(
    options: { limit?: number; status?: string; projectId?: string } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.status) {
      params.append("status", options.status);
    }
    if (options.projectId) {
      params.append("projectId", options.projectId);
    }

    const response = await this.request(`/api/cli/builds?${params}`);
    return response.data || [];
  }

  async getModelInstances(
    options: { limit?: number; modelId?: string } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.modelId) {
      params.append("modelId", options.modelId);
    }

    const response = await this.request(`/api/cli/models?${params}`);
    return response.data || response || [];
  }

  async getModelImages(
    options: { limit?: number; modelId?: string } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.modelId) {
      params.append("modelId", options.modelId);
    }

    const response = await this.request(`/api/cli/images/models?${params}`);
    return response.data || [];
  }

  async getRegistryArtifacts(
    options: {
      limit?: number;
      type?: string;
      pipelineId?: string;
      nodeId?: string;
      latest?: boolean;
    } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.type) {
      params.append("type", options.type);
    }
    if (options.pipelineId) {
      params.append("pipelineId", options.pipelineId);
    }
    if (options.nodeId) {
      params.append("nodeId", options.nodeId);
    }
    if (options.latest) {
      params.append("latest", "true");
    }

    const response = await this.request(
      `/api/cli/registry/artifacts?${params}`
    );
    return response.data?.artifacts || response.data || [];
  }

  async getDeploymentExecutions(
    options: { limit?: number; modelInstanceId?: string; modelId?: string } = {}
  ): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.modelInstanceId) {
      params.append("modelInstanceId", options.modelInstanceId);
    }
    if (options.modelId) {
      params.append("modelId", options.modelId);
    }

    const response = await this.request(
      `/api/cli/deployments/versions?${params}`
    );
    return response.data || response || [];
  }

  // Run command methods

  async triggerPipelineRun(
    pipelineNameOrId: string,
    options: {
      config?: Record<string, unknown>;
      gpu?: string;
      priority?: string;
      tags?: string[];
    } = {}
  ): Promise<RunInfo> {
    const response = await this.request(
      `/api/cli/pipelines/${encodeURIComponent(pipelineNameOrId)}/run`,
      {
        method: "POST",
        body: {
          gpu: options.gpu,
          priority: options.priority,
          tags: options.tags,
          config: options.config,
        },
      }
    );
    return response.data;
  }

  async getRun(runId: string): Promise<RunInfo> {
    const response = await this.request(
      `/api/cli/runs/${encodeURIComponent(runId)}`
    );
    return response.data;
  }

  async getRuns(
    options: { status?: string; limit?: number; pipeline?: string } = {}
  ): Promise<RunInfo[]> {
    const params = new URLSearchParams();
    if (options.status) {
      params.append("status", options.status);
    }
    if (options.limit) {
      params.append("limit", options.limit.toString());
    }
    if (options.pipeline) {
      params.append("pipeline", options.pipeline);
    }

    const response = await this.request(`/api/cli/runs?${params}`);
    return response.data || [];
  }

  async cancelRun(
    runId: string,
    options: {
      force?: boolean;
    } = {}
  ): Promise<RunInfo> {
    const response = await this.request(
      `/api/cli/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        body: { force: options.force },
      }
    );
    return response.data;
  }

  async getRunLogs(
    runId: string,
    options: {
      lines?: number;
      since?: string;
    } = {}
  ): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    if (options.lines) {
      params.append("lines", options.lines.toString());
    }
    if (options.since) {
      params.append("since", options.since);
    }

    const response = await this.request(
      `/api/cli/runs/${encodeURIComponent(runId)}/logs?${params}`
    );
    return response.data || [];
  }

  // Pull command methods

  async getPullArtifacts(
    options: {
      resource?: string;
      name?: string;
      tag?: string;
      projectName?: string;
      type?: string;
      path?: string;
    } = {}
  ): Promise<PullArtifactInfo[]> {
    const params = new URLSearchParams();
    if (options.resource) {
      params.append("resource", options.resource);
    }
    if (options.name) {
      params.append("name", options.name);
    }
    if (options.tag) {
      params.append("tag", options.tag);
    }
    if (options.projectName) {
      params.append("projectName", options.projectName);
    }
    if (options.type) {
      params.append("type", options.type);
    }
    if (options.path) {
      params.append("path", options.path);
    }

    const response = await this.request(`/api/cli/registry/pull?${params}`);
    return response.data?.artifacts || response.data || [];
  }

  async getPullDownloadUrl(artifactId: string): Promise<PullDownloadInfo> {
    const params = new URLSearchParams();
    params.append("artifactId", artifactId);

    const response = await this.request(
      `/api/cli/registry/pull/download?${params}`
    );
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
      "User-Agent": USER_AGENT,
    };

    let attempt = 0;
    let lastError: Error = new Error("Download failed after retries");

    while (attempt <= this.config.retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout * 10); // 10x normal timeout for large downloads

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Download failed: HTTP ${response.status} ${response.statusText}`
          );
        }

        if (!response.body) {
          throw new Error("Download failed: empty response body");
        }

        const totalSize = Number.parseInt(
          response.headers.get("content-length") || "0",
          10
        );
        let downloaded = 0;

        const fileStream = createWriteStream(destPath);
        // Native fetch hands back a web ReadableStream; the rest of this
        // method wants Node stream semantics.
        const bodyStream = Readable.fromWeb(response.body);

        await new Promise<void>((resolve, reject) => {
          bodyStream.on("data", (chunk: Buffer) => {
            downloaded += chunk.length;
            if (onProgress && totalSize > 0) {
              onProgress(downloaded, totalSize);
            }
          });

          bodyStream.pipe(fileStream);

          bodyStream.on("error", (err: Error) => {
            fileStream.close();
            reject(err);
          });

          fileStream.on("finish", () => {
            fileStream.close();
            resolve();
          });

          fileStream.on("error", (err: Error) => {
            reject(err);
          });
        });

        return;
      } catch (error) {
        lastError = error as Error;

        if (
          error instanceof Error &&
          (error.message.includes("401") || error.message.includes("403"))
        ) {
          throw error;
        }

        attempt++;
        if (attempt <= this.config.retries) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }

  // Push command methods

  async checkDedupe(
    checksum: string,
    options: {
      resource?: string;
      name?: string;
    } = {}
  ): Promise<PushDedupeResult> {
    const body: Record<string, string> = { checksum };
    if (options.resource) {
      body["resource"] = options.resource;
    }
    if (options.name) {
      body["name"] = options.name;
    }

    const response = await this.request("/api/cli/registry/push/check-dedupe", {
      method: "POST",
      body,
    });
    return response.data;
  }

  async getUploadUrl(options: {
    filename: string;
    size: number;
    checksum: string;
    resource?: string;
    name?: string;
    tag?: string;
    registry?: string;
  }): Promise<PushUploadUrl> {
    const body: Record<string, string | number> = {
      filename: options.filename,
      size: options.size,
      checksum: options.checksum,
    };
    if (options.resource) {
      body["resource"] = options.resource;
    }
    if (options.name) {
      body["name"] = options.name;
    }
    if (options.tag) {
      body["tag"] = options.tag;
    }
    if (options.registry) {
      body["registry"] = options.registry;
    }

    const response = await this.request("/api/cli/registry/push/upload-url", {
      method: "POST",
      body,
    });
    return response.data;
  }

  async confirmUpload(options: {
    uploadId: string;
    checksum: string;
    size: number;
    resource?: string;
    name?: string;
    tag?: string;
    message?: string;
    gitHash?: string;
  }): Promise<PushConfirmation> {
    const body: Record<string, string | number> = {
      uploadId: options.uploadId,
      checksum: options.checksum,
      size: options.size,
    };
    if (options.resource) {
      body["resource"] = options.resource;
    }
    if (options.name) {
      body["name"] = options.name;
    }
    if (options.tag) {
      body["tag"] = options.tag;
    }
    if (options.message) {
      body["message"] = options.message;
    }
    if (options.gitHash) {
      body["gitHash"] = options.gitHash;
    }

    const response = await this.request("/api/cli/registry/push/confirm", {
      method: "POST",
      body,
    });
    return response.data;
  }

  async createVersion(options: {
    projectName: string;
    tag?: string;
    artifacts: Array<{
      artifactId: string;
      filename: string;
      checksum: string;
      size: number;
      type: string;
    }>;
    message?: string;
    gitHash?: string;
  }): Promise<{ versionId: string; tag: string; createdAt: string }> {
    const response = await this.request("/api/cli/registry/push/version", {
      method: "POST",
      body: {
        projectName: options.projectName,
        artifacts: options.artifacts,
        ...(options.tag ? { tag: options.tag } : {}),
        ...(options.message ? { message: options.message } : {}),
        ...(options.gitHash ? { gitHash: options.gitHash } : {}),
      },
    });
    return response.data;
  }

  async getUploadSession(sessionId: string): Promise<PushSessionInfo | null> {
    try {
      const response = await this.request(
        `/api/cli/registry/push/session/${encodeURIComponent(sessionId)}`
      );
      return response.data;
    } catch {
      return null;
    }
  }

  async createUploadSession(options: {
    filePath: string;
    totalSize: number;
    chunkSize: number;
    totalChunks: number;
    checksum: string;
  }): Promise<{ sessionId: string }> {
    const response = await this.request("/api/cli/registry/push/session", {
      method: "POST",
      body: options,
    });
    return response.data;
  }

  async uploadFile(
    url: string,
    filePath: string,
    onProgress?: (uploaded: number, total: number) => void
  ): Promise<void> {
    await this.ensureValidToken();

    const stat = await fs.stat(filePath);
    const totalSize = stat.size;

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/octet-stream",
      "Content-Length": totalSize.toString(),
    };

    let attempt = 0;
    let lastError: Error = new Error("Upload failed after retries");

    while (attempt <= this.config.retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout * 10);

      try {
        const fileStream = createReadStream(filePath);
        let uploaded = 0;

        fileStream.on("data", (chunk: string | Buffer) => {
          uploaded +=
            typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          if (onProgress && totalSize > 0) {
            onProgress(uploaded, totalSize);
          }
        });

        fileStream.on("error", () => {
          fileStream.destroy();
          controller.abort();
        });

        const response = await fetch(url, {
          method: "PUT",
          headers,
          // Native fetch needs a web stream and duplex; the explicit
          // Content-Length above is still honored, so presigned PUTs keep
          // getting a sized request rather than chunked encoding.
          body: Readable.toWeb(fileStream) as never,
          duplex: "half",
          signal: controller.signal,
        } as RequestInit);

        if (!response.ok) {
          throw new Error(
            `Upload failed: HTTP ${response.status} ${response.statusText}`
          );
        }

        return;
      } catch (error) {
        lastError = error as Error;

        if (
          error instanceof Error &&
          (error.message.includes("401") || error.message.includes("403"))
        ) {
          throw error;
        }

        attempt++;
        if (attempt <= this.config.retries) {
          const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }

  async uploadFileChunk(
    url: string,
    filePath: string,
    chunkIndex: number,
    chunkSize: number,
    totalSize: number,
    onProgress?: (uploaded: number, chunkTotal: number) => void
  ): Promise<string> {
    await this.ensureValidToken();

    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, totalSize);
    const length = end - start;

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/octet-stream",
      "Content-Length": length.toString(),
      "Content-Range": `bytes ${start}-${end - 1}/${totalSize}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.timeout * 10);

    try {
      const fileStream = createReadStream(filePath, { start, end: end - 1 });
      let uploaded = 0;

      fileStream.on("data", (chunk: string | Buffer) => {
        uploaded +=
          typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (onProgress) {
          onProgress(uploaded, length);
        }
      });

      fileStream.on("error", () => {
        controller.abort();
      });

      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: Readable.toWeb(fileStream) as never,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit);

      if (!response.ok) {
        throw new Error(
          `Chunk upload failed: HTTP ${response.status} ${response.statusText}`
        );
      }

      return response.headers.get("etag") || "";
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Sync command methods

  async getSyncDiff(options: {
    projectName: string;
    manifest: Array<{ path: string; checksum: string; size: number }>;
  }): Promise<SyncDiffResult> {
    const response = await this.request("/api/cli/registry/sync/diff", {
      method: "POST",
      body: {
        projectName: options.projectName,
        manifest: options.manifest,
      },
    });
    return response.data;
  }

  async completeSyncMetadata(options: {
    projectName: string;
    pushed: Array<{ path: string; checksum: string; artifactId: string }>;
    pulled: Array<{ path: string; checksum: string; artifactId: string }>;
  }): Promise<void> {
    await this.request("/api/cli/registry/sync/complete", {
      method: "POST",
      body: {
        projectName: options.projectName,
        pushed: options.pushed,
        pulled: options.pulled,
      },
    });
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
    return;
  }

  private async ensureValidToken(): Promise<void> {
    if (!(this.config.auth?.expiresAt && this.config.auth?.refreshToken)) {
      return; // No JWT auth or refresh token available
    }

    const expiresAt = new Date(this.config.auth.expiresAt);
    const now = new Date();
    const fiveMinutes = 5 * 60 * 1000;

    // Refresh if expires within 5 minutes
    if (expiresAt.getTime() - now.getTime() < fiveMinutes) {
      try {
        const newTokens = await this.refreshToken(
          this.config.auth.refreshToken
        );

        // Update config with new tokens
        const { ConfigManager } = await import("./config");
        const configManager = new ConfigManager();
        const currentConfig = configManager.load();

        const expiresAt = new Date(
          Date.now() + newTokens.expires_in * 1000
        ).toISOString();
        currentConfig.auth = {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
          expiresAt,
        };

        configManager.save(currentConfig);

        // Update this instance's config
        this.config = currentConfig;
      } catch {
        // If refresh fails, continue with existing token and let the API request fail
        // Don't log refresh errors automatically - let calling code handle them
      }
    }
  }

  /**
   * Perform an authenticated request, refreshing the access token once on 401.
   *
   * The stored token is used until the server rejects it — on a 401 the token
   * is refreshed once and the request retried once. There is no proactive
   * refresh.
   *
   * `T` is the parsed response body. Most platform routes wrap their payload
   * in the `{ success, data }` envelope, so `T` defaults to `ApiResponse`;
   * routes that return a flat or differently-named body pass their own type.
   */
  private async request<T = ApiResponse>(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      isFormData?: boolean;
    } = {}
  ): Promise<T> {
    try {
      return await this.requestRaw<T>(endpoint, options);
    } catch (error) {
      const isUnauthorized = error instanceof NotAuthenticatedError;
      if (!(isUnauthorized && this.config.auth?.refreshToken)) {
        throw error;
      }

      try {
        const newTokens = await this.refreshToken(
          this.config.auth.refreshToken
        );
        const { ConfigManager } = await import("./config");
        const configManager = new ConfigManager();
        const currentConfig = configManager.load();
        currentConfig.auth = {
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
          ...(newTokens.expires_in
            ? {
                expiresAt: new Date(
                  Date.now() + newTokens.expires_in * 1000
                ).toISOString(),
              }
            : {}),
        };
        configManager.save(currentConfig);
        this.config = currentConfig;
      } catch {
        throw error;
      }

      return await this.requestRaw<T>(endpoint, options);
    }
  }

  /**
   * Perform a single request with retries, without the 401 refresh path.
   *
   * Throws a typed `PlatformError` on any non-2xx response, so callers can
   * treat the resolved value as a successful body. `T` is the parsed response
   * body and defaults to the `{ success, data }` envelope.
   */
  private async requestRaw<T = ApiResponse>(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      isFormData?: boolean;
    } = {}
  ): Promise<T> {
    const url = new URL(endpoint, this.config.apiUrl);
    const method = options.method || "GET";

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      ...options.headers,
    };

    // Support both JWT and legacy token authentication
    const authHeader = this.getAuthHeader();
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    let body: any;
    if (options.body) {
      if (options.isFormData) {
        body = options.body;
        // Let form-data set the content-type
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }
    }

    let attempt = 0;
    let lastError: Error = new Error("Request failed after retries");

    while (attempt <= this.config.retries) {
      // Per attempt, matching downloadFile/uploadFile: a controller shared
      // across retries latches aborted after the first timeout, so every
      // remaining retry would reject instantly instead of being tried.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout);

      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage =
            (errorData as any)?.message ||
            (errorData as any)?.error ||
            `HTTP ${response.status}: ${response.statusText}`;
          const retryAfterHeader = response.headers.get("retry-after");
          const parsedRetryAfter = retryAfterHeader
            ? Number.parseInt(retryAfterHeader, 10)
            : Number.NaN;
          // A Retry-After of 0 is valid ("retry immediately"), so test for NaN
          // rather than falsiness.
          const retryAfterSeconds = Number.isNaN(parsedRetryAfter)
            ? undefined
            : parsedRetryAfter;
          throw classifyHttpError(
            response.status,
            errorMessage,
            retryAfterSeconds
          );
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        // Convert raw fetch/network failures into typed PlatformError.
        const classified =
          error instanceof PlatformError ? error : classifyFetchError(error);
        lastError = classified as Error;

        // Don't retry on auth errors or other client-side (4xx) failures —
        // the request is wrong, retrying won't fix it. 429 is also left to the
        // caller, which knows whether to honor Retry-After and carry on.
        if (
          classified instanceof NotAuthenticatedError ||
          classified instanceof PlatformBadRequestError ||
          classified instanceof PlatformRateLimitError
        ) {
          throw classified;
        }

        // Don't retry refresh failures — let caller decide (fail fast, no 7s retry storm)
        if (endpoint === "/api/cli/auth/refresh") {
          throw classified;
        }

        attempt++;
      } finally {
        clearTimeout(timeoutId);
      }

      // Backoff happens after the finally so this attempt's timer is already
      // disarmed while we sleep.
      if (attempt <= this.config.retries) {
        // Exponential backoff
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
