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
  PushMultipartAbort,
  PushMultipartComplete,
  PushMultipartInit,
  PushMultipartPartRecord,
  PushMultipartPartUrl,
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

/**
 * HTTP client for the Cirron platform's `/api/cli/*` surface.
 *
 * Everything comes from the `CirronConfig` handed to the constructor — base
 * URL, timeout, retry count and credentials — so a caller that wants different
 * settings constructs a different instance rather than mutating this one.
 *
 * Two behaviors are worth knowing before calling anything:
 *
 * - **Credential precedence.** The device-flow JWT (`auth.accessToken`) wins,
 *   falling back to `config.token`.
 * - **Requests can rewrite your config file.** A token near expiry, or a 401
 *   on a retryable request, triggers a refresh that persists new tokens to
 *   `~/.cirron/config.json` mid-request. A long-running command can therefore
 *   see the on-disk config change underneath it.
 *
 * Several methods call platform routes that do not exist yet and can only
 * 404 — the three `env` methods and `getRegistryArtifacts`. Each says so.
 */
export class CirronApi {
  private config: CirronConfig;

  constructor(config: CirronConfig) {
    this.config = config;
  }

  /**
   * Validate the stored credentials against the platform.
   *
   * @returns The authenticated user and organization.
   * @throws NotAuthenticatedError when the credentials are missing or rejected.
   */
  async verifyAuth(): Promise<AuthInfo> {
    const response = await this.request("/api/cli/status");
    return response as any;
  }

  // Device Flow Authentication Methods
  /**
   * Begin the RFC 8628 device authorization flow.
   *
   * @returns The device code, user code, verification URL, poll interval and
   * expiry window.
   */
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.request("/api/cli/auth/device", {
      method: "POST",
    });
    return response as any;
  }

  /**
   * Poll once for the outcome of a device authorization.
   *
   * A pending authorization is a normal, non-error result — callers poll until
   * the window closes rather than treating the first non-success as failure.
   *
   * @param deviceCode - The device code issued by `requestDeviceCode`.
   * @returns The current status, carrying tokens once approved.
   */
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

  /**
   * Fetch a single deployment by id.
   *
   * @param deploymentId - Platform deployment id.
   * @returns The deployment, with its status normalized to the CLI's union.
   */
  async getDeployment(deploymentId: string): Promise<DeploymentInfo> {
    const response = await this.request<DeploymentResponse>(
      `/api/cli/deployments/${deploymentId}`
    );
    return this.normalizeDeployment(response.data);
  }

  /**
   * List a model's deployments, most recent first.
   *
   * @param projectName - Model name to scope the listing to.
   * @param options - Optional `environment`, `status` and `limit` filters.
   * @returns The matching deployments, statuses normalized.
   */
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

  /**
   * Fetch logs for one environment of a model.
   *
   * @param projectName - Model name.
   * @param environment - Environment name, e.g. `production`.
   * @param options - `lines` caps how many entries return; `since` is an
   * ISO timestamp lower bound.
   * @returns The log entries.
   */
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

  /**
   * NOTE: the platform does not implement this route yet, so calls fail with
   * 404. `cirron env list` cannot work until it lands. Do not build on this.
   *
   * @param projectName - Model name to scope the lookup to.
   * @param environment - Environment name, e.g. `production`.
   * @returns The environment's variables, keyed by name.
   */
  async getEnvironmentVariables(
    projectName: string,
    environment: string
  ): Promise<Record<string, string>> {
    const response = await this.request(
      `/api/cli/models/${projectName}/env/${environment}`
    );
    return response.data;
  }

  /**
   * NOTE: the platform does not implement this route yet, so calls fail with
   * 404. `cirron env set` cannot work until it lands. Do not build on this.
   *
   * @param projectName - Model name to scope the write to.
   * @param environment - Environment name, e.g. `production`.
   * @param key - Variable name.
   * @param value - Variable value.
   */
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

  /**
   * NOTE: the platform does not implement this route yet, so calls fail with
   * 404. `cirron env delete` cannot work until it lands. Do not build on this.
   *
   * @param projectName - Model name to scope the delete to.
   * @param environment - Environment name, e.g. `production`.
   * @param key - Variable name to remove.
   */
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
  /**
   * List build reports.
   *
   * @param options - `limit` and `status` filter server-side. `projectId` is
   * sent but the platform ignores it, so results are not scoped by model.
   * @returns The build reports, or an empty array.
   */
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

  /**
   * List model instances.
   *
   * @param options - `limit` filters server-side. `modelId` is sent but the
   * platform ignores it, so results are not scoped to one model.
   * @returns The instances, or an empty array.
   */
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

  /**
   * List built container images for models.
   *
   * @param options - `limit` filters server-side. `modelId` is sent but the
   * platform ignores it.
   * @returns The images, or an empty array.
   */
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

  /**
   * NOTE: the platform does not implement this route yet, so calls fail with
   * 404. The registry exposes push, pull and sync but no artifact listing, so
   * `cirron list registry` cannot work until it lands. Do not build on this.
   *
   * @param options - Filters forwarded as query parameters.
   * @returns The matching registry artifacts.
   */
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

  /**
   * List deployment versions (executions).
   *
   * @param options - `limit` filters server-side. `modelInstanceId` and
   * `modelId` are sent but the platform ignores both.
   * @returns The executions, or an empty array.
   */
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

  /**
   * Start a pipeline run.
   *
   * @param pipelineNameOrId - Pipeline name or id; URL-encoded before sending.
   * @param options - Run overrides: `gpu`, `priority`, `tags` and a free-form
   * `config` object.
   * @returns The created run.
   */
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

  /**
   * Fetch a single run by id.
   *
   * @param runId - Platform run id.
   * @returns The run.
   */
  async getRun(runId: string): Promise<RunInfo> {
    const response = await this.request(
      `/api/cli/runs/${encodeURIComponent(runId)}`
    );
    return response.data;
  }

  /**
   * List runs.
   *
   * @param options - Optional `status`, `limit` and `pipeline` filters.
   * @returns The matching runs, or an empty array.
   */
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

  /**
   * Cancel a run.
   *
   * @param runId - Platform run id.
   * @param options - `force` skips the platform's graceful-shutdown path.
   * @returns The run in its post-cancellation state.
   */
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

  /**
   * Fetch a run's logs.
   *
   * @param runId - Platform run id.
   * @param options - `lines` caps how many entries return; `since` is an ISO
   * timestamp lower bound.
   * @returns The log entries, or an empty array.
   */
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

  /**
   * List registry artifacts matching a pull selector.
   *
   * @param options - Selector fields forwarded as query parameters: `resource`,
   * `name`, `tag`, `projectName`, `type` and `path`.
   * @returns The matching artifacts, or an empty array.
   */
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

  /**
   * Get a presigned download URL for one artifact.
   *
   * @param artifactId - Registry artifact id.
   * @returns The download URL and its metadata.
   */
  async getPullDownloadUrl(artifactId: string): Promise<PullDownloadInfo> {
    const params = new URLSearchParams();
    params.append("artifactId", artifactId);

    const response = await this.request(
      `/api/cli/registry/pull/download?${params}`
    );
    return response.data;
  }

  /**
   * Stream a URL to a local path, with retries.
   *
   * Sends no Authorization header: these are presigned URLs that already carry
   * their own credentials, and forwarding a bearer token to S3 or GCS would leak
   * it to a third party. Each retry gets its own AbortController, so one timeout
   * cannot latch and cancel every remaining attempt.
   *
   * @param url - Presigned download URL.
   * @param destPath - Local destination path.
   * @param onProgress - Called with bytes downloaded and total.
   * @throws If every attempt fails.
   */
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

  /**
   * Ask whether the registry already holds an artifact with this checksum.
   *
   * A hit lets push skip the upload entirely.
   *
   * @param checksum - SHA-256 of the file, lowercase hex.
   * @param options - Optional `resource` and `name` to scope the lookup.
   * @returns Whether the content exists, and its artifact id if so.
   */
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

  /**
   * Request a presigned URL for a single-PUT upload.
   *
   * The URL is signature-bound to the declared `size`, so the whole file must go
   * in one request. Artifacts above the multipart threshold use
   * `initMultipartUpload` instead.
   *
   * @param options - `filename`, `size` and `checksum` are required; `resource`,
   * `name`, `tag`, `registry` and `platform` route the artifact.
   * @returns The upload URL and the session id that `confirmUpload` resolves.
   */
  async getUploadUrl(options: {
    filename: string;
    size: number;
    checksum: string;
    resource?: string;
    name?: string;
    tag?: string;
    registry?: string;
    platform?: string;
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
    if (options.platform) {
      body["platform"] = options.platform;
    }

    const response = await this.request("/api/cli/registry/push/upload-url", {
      method: "POST",
      body,
    });
    return response.data;
  }

  /**
   * Tell the registry an upload finished, turning the session into an artifact.
   *
   * @param options - `uploadId`, `checksum` and `size` identify the upload;
   * `resource`, `name`, `tag`, `message` and `gitHash` become artifact metadata.
   * @returns The confirmed artifact.
   */
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

  /**
   * Group already-uploaded artifacts into a tagged version.
   *
   * @param options - `projectName` and the `artifacts` list are required; `tag`,
   * `message` and `gitHash` are omitted from the body when absent.
   * @returns The created version's id, tag and creation time.
   */
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

  /**
   * Look up an upload session's server-side state.
   *
   * Returns null rather than throwing when the session is missing or the request
   * fails, so callers can treat "no session" and "cannot reach the platform" the
   * same way.
   *
   * @param sessionId - Upload session id.
   * @returns The session, or null.
   */
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

  /**
   * Open a chunked upload session.
   *
   * Unused: large artifacts go through `initMultipartUpload` instead.
   *
   * @param options - File path, total size, chunk size, chunk count and checksum.
   * @returns The new session's id.
   */
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

  // Multipart upload (artifacts above the platform's multipart threshold)

  /**
   * Open a provider-native multipart upload.
   *
   * Creates the upload session itself, so callers must NOT also call
   * `getUploadUrl` or `createUploadSession` for the same artifact.
   */
  async initMultipartUpload(options: {
    filename: string;
    size: number;
    checksum: string;
    name?: string;
    contentType?: string;
    platform?: string;
  }): Promise<PushMultipartInit> {
    const body: Record<string, string | number> = {
      filename: options.filename,
      size: options.size,
      checksum: options.checksum,
    };
    if (options.name) {
      body["name"] = options.name;
    }
    if (options.contentType) {
      body["contentType"] = options.contentType;
    }
    // Forwarded here as well as on getUploadUrl: artifacts above the
    // multipart threshold never touch upload-url, and those are exactly the
    // large model weights most likely to need an explicit Platform.
    if (options.platform) {
      body["platform"] = options.platform;
    }

    const response = await this.request(
      "/api/cli/registry/push/multipart/init",
      { method: "POST", body }
    );
    return response.data;
  }

  /**
   * Presign one part's PUT. Part numbers are 1-based.
   *
   * Presigned part URLs expire, so call this immediately before uploading the
   * part rather than presigning the whole upload up front.
   */
  async getMultipartPartUrl(options: {
    sessionId: string;
    partNumber: number;
  }): Promise<PushMultipartPartUrl> {
    const response = await this.request(
      "/api/cli/registry/push/multipart/part-url",
      { method: "POST", body: options }
    );
    return response.data;
  }

  /** Record a finished part. Idempotent per part, so retries are safe. */
  async recordMultipartPart(options: {
    sessionId: string;
    partNumber: number;
    etag: string;
    sizeBytes?: number;
  }): Promise<PushMultipartPartRecord> {
    const body: Record<string, string | number> = {
      sessionId: options.sessionId,
      partNumber: options.partNumber,
      etag: options.etag,
    };
    if (options.sizeBytes !== undefined) {
      body["sizeBytes"] = options.sizeBytes;
    }

    const response = await this.request(
      "/api/cli/registry/push/multipart/part-complete",
      { method: "POST", body }
    );
    return response.data;
  }

  /**
   * Assemble the uploaded parts into the final object.
   *
   * Leaves the session open on purpose: `confirmUpload` remains the step that
   * creates the artifact and closes the session.
   */
  async completeMultipartUpload(options: {
    sessionId: string;
  }): Promise<PushMultipartComplete> {
    const response = await this.request(
      "/api/cli/registry/push/multipart/complete",
      { method: "POST", body: options }
    );
    return response.data;
  }

  /** Discard an in-progress multipart upload and its recorded parts. */
  async abortMultipartUpload(options: {
    sessionId: string;
  }): Promise<PushMultipartAbort> {
    const response = await this.request(
      "/api/cli/registry/push/multipart/abort",
      { method: "POST", body: options }
    );
    return response.data;
  }

  /**
   * Stream a local file to a presigned URL in one request, with retries.
   *
   * Sets an explicit Content-Length so the PUT is sized rather than chunked,
   * which presigned URLs require. Each retry gets its own AbortController and
   * re-streams from byte zero.
   *
   * @param url - Presigned upload URL.
   * @param filePath - Local file to send.
   * @param onProgress - Called with bytes uploaded and total.
   * @throws If every attempt fails.
   */
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

      // Hoisted so the finally can close it. A request that fails BEFORE the
      // body is consumed (connection refused, bad URL) never cancels the web
      // stream, so nothing would destroy the fd. Abort and socket errors do
      // propagate through Readable.toWeb and are already handled.
      let fileStream: ReturnType<typeof createReadStream> | undefined;

      try {
        const stream = createReadStream(filePath);
        fileStream = stream;
        let uploaded = 0;

        stream.on("data", (chunk: string | Buffer) => {
          uploaded +=
            typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
          if (onProgress && totalSize > 0) {
            onProgress(uploaded, totalSize);
          }
        });

        stream.on("error", () => {
          stream.destroy();
          controller.abort();
        });

        const response = await fetch(url, {
          method: "PUT",
          headers,
          // Native fetch needs a web stream and duplex; the explicit
          // Content-Length above is still honored, so presigned PUTs keep
          // getting a sized request rather than chunked encoding.
          body: Readable.toWeb(stream) as never,
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
        fileStream?.destroy();
      }
    }

    throw lastError;
  }

  /**
   * PUT one multipart part to its presigned URL and return the storage
   * provider's ETag.
   *
   * Deliberately does NOT send `Content-Range`: a presigned part URL is signed
   * for one (uploadId, partNumber) and takes the part's bytes as its entire
   * body. That is the difference from `uploadFileChunk`, which targets a
   * single-object URL and cannot be reused here.
   *
   * Retries per part rather than per upload, so a transient failure costs one
   * part instead of the whole artifact.
   *
   * `onProgress` reports a byte DELTA, not a running total, because parts
   * upload concurrently and the caller aggregates across them.
   */
  async uploadFilePart(
    url: string,
    filePath: string,
    start: number,
    length: number,
    onProgress?: (uploadedDelta: number) => void
  ): Promise<string> {
    await this.ensureValidToken();

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/octet-stream",
      "Content-Length": length.toString(),
    };

    let attempt = 0;
    let lastError: Error = new Error("Part upload failed after retries");

    while (attempt <= this.config.retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout * 10);

      // Hoisted so the finally can close it. See uploadFile: a request that
      // fails before the body is consumed never cancels the web stream.
      let fileStream: ReturnType<typeof createReadStream> | undefined;

      try {
        // Recreated per attempt: a consumed stream cannot be replayed.
        // createReadStream's `end` is inclusive.
        const stream = createReadStream(filePath, {
          start,
          end: start + length - 1,
        });
        fileStream = stream;

        stream.on("data", (chunk: string | Buffer) => {
          if (onProgress) {
            onProgress(
              typeof chunk === "string"
                ? Buffer.byteLength(chunk)
                : chunk.length
            );
          }
        });

        stream.on("error", () => {
          stream.destroy();
          controller.abort();
        });

        const response = await fetch(url, {
          method: "PUT",
          headers,
          body: Readable.toWeb(stream) as never,
          duplex: "half",
          signal: controller.signal,
        } as RequestInit);

        if (!response.ok) {
          throw new Error(
            `Part upload failed: HTTP ${response.status} ${response.statusText}`
          );
        }

        // Returned verbatim, quotes included: the platform hands this straight
        // back to the provider's complete call, which expects that form.
        const etag = response.headers.get("etag");
        if (!etag) {
          // Recording an empty etag would fail later and further away: the
          // platform's part-complete requires a non-empty string, so the user
          // would see "Invalid request body" instead of the real cause.
          throw new Error(
            `Part upload succeeded but the storage provider returned no ETag (part at byte ${start}). Multipart completion cannot proceed without it.`
          );
        }
        return etag;
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
        fileStream?.destroy();
      }
    }

    throw lastError;
  }

  /**
   * Upload one chunk of a chunked upload.
   *
   * Unused: parts go through `uploadFilePart`, which carries no Content-Range.
   *
   * @param url - Presigned URL for the chunk.
   * @param filePath - Local file to read the chunk from.
   * @param chunkIndex - Zero-based index of the chunk; with `chunkSize` this
   * gives the byte range read from the file.
   * @param chunkSize - Bytes per chunk.
   * @param totalSize - Size of the whole file, for the Content-Range header.
   * @param onProgress - Called with bytes uploaded and this chunk's total.
   * @returns The chunk's ETag.
   */
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

  /**
   * Compare a local manifest against the registry.
   *
   * @param options - `projectName` and a `manifest` of path, checksum and size
   * for every local file.
   * @returns What to push, what to pull, and what conflicts.
   */
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

  /**
   * Record the outcome of a sync so the next diff has a baseline.
   *
   * @param options - `projectName` plus the `pushed` and `pulled` file lists.
   */
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

  /**
   * Build the Authorization header from stored credentials.
   *
   * Prefers the device-flow JWT and falls back to `config.token`.
   *
   * @returns The header value, or undefined when no credentials are stored.
   */
  private getAuthHeader(): string | undefined {
    // Try JWT token first
    if (this.config.auth?.accessToken) {
      return `Bearer ${this.config.auth.accessToken}`;
    }
    if (this.config.token) {
      return `Bearer ${this.config.token}`;
    }
    return;
  }

  /**
   * Refresh the access token when it is close to expiring.
   *
   * Refreshes within five minutes of expiry and **rewrites
   * `~/.cirron/config.json`** as a side effect, so a long-running command can see
   * the on-disk config change underneath it. No-op without both an expiry and a
   * refresh token.
   */
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
