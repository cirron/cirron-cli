import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type {
  ProjectConfig,
  PushArtifactInfo,
  PushFileInfo,
  PushOptions,
  PushResourceType,
  PushResult,
  PushSummary,
} from "../types";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import {
  collectFiles,
  collectProjectFiles,
  isResourceTyped,
  KNOWN_RESOURCE_TYPES,
  parseNameTag,
} from "../utils/artifacts";
import { computeFileChecksum } from "../utils/checksum";
import { mapWithConcurrency } from "../utils/concurrency";
import { ConfigManager } from "../utils/config";
import { formatSize } from "../utils/format";
import { getShortCommitHash } from "../utils/git";
import { logger } from "../utils/logger";
import { loadProjectConfigOrNull as loadProjectConfig } from "../utils/project-config";

// Constants

/**
 * The client has to choose an upload path before it has talked to the server,
 * so this cannot be read from the API. `init` echoes the authoritative value
 * back and the driver logs a debug line when the two disagree.
 */
const MULTIPART_THRESHOLD_BYTES = 256 * 1024 * 1024;

/** Parts in flight at once. Bounded to stay well inside registry rate limits. */
const PART_UPLOAD_CONCURRENCY = 4;

/**
 * Files hashed at once. Hashing is disk-and-CPU bound rather than
 * network-bound, so this is higher than the upload concurrency.
 */
const CHECKSUM_CONCURRENCY = 8;

// Helpers

function checkAuth(): { api: CirronApi } | null {
  const configManager = new ConfigManager();
  const currentConfig = configManager.load();

  if (!(currentConfig.token || currentConfig.auth?.accessToken)) {
    logger.error("Not authenticated");
    logger.info(`Run ${chalk.cyan("cirron auth login")} to authenticate`);
    return null;
  }

  return { api: new CirronApi(currentConfig) };
}

/** The narrowed option bag `uploadSingleFile` accepts. */
interface UploadOpts {
  force?: boolean;
  gitHash?: string;
  message?: string;
  name?: string;
  platform?: string;
  registry?: string;
  resource?: string;
  tag?: string;
}

/**
 * Drop the unset fields from a set of upload options.
 *
 * `exactOptionalPropertyTypes` rejects `{ tag: undefined }` where the target
 * declares `tag?: string`, so every caller was hand-writing the same
 * conditional assignment block. The input type accepts explicit `undefined`;
 * the output type does not.
 */
function buildUploadOpts(values: {
  force?: boolean | undefined;
  gitHash?: string | undefined;
  message?: string | undefined;
  name?: string | undefined;
  platform?: string | undefined;
  registry?: string | undefined;
  resource?: string | undefined;
  tag?: string | undefined;
}): UploadOpts {
  const opts: UploadOpts = {};
  if (values.resource) {
    opts.resource = values.resource;
  }
  if (values.name) {
    opts.name = values.name;
  }
  if (values.tag) {
    opts.tag = values.tag;
  }
  if (values.message) {
    opts.message = values.message;
  }
  if (values.registry) {
    opts.registry = values.registry;
  }
  if (values.force) {
    opts.force = values.force;
  }
  if (values.gitHash) {
    opts.gitHash = values.gitHash;
  }
  if (values.platform) {
    opts.platform = values.platform;
  }
  return opts;
}

/**
 * The Platform slug to send with an upload, if any.
 *
 * `--platform` beats the `platform` key in the project config; with neither
 * set the CLI sends nothing and the server resolves the Platform from the
 * artifact name or the organization default. The CLI never interprets the
 * slug beyond passing it along.
 */
function resolvePlatformHint(flag: string | undefined): string | undefined {
  return flag ?? loadProjectConfig()?.platform;
}

/**
 * Follow a 404 with a hint at what to fix.
 *
 * A rejected `--platform` slug also comes back as "not found", so the generic
 * "register your project" advice would send the user to fix something
 * unrelated. Match the more specific case first.
 */
function logNotFoundHint(message: string): void {
  const lower = message.toLowerCase();
  if (!(lower.includes("not found") || message.includes("404"))) {
    return;
  }
  if (lower.includes("platform")) {
    logger.info(
      `Check the platform slug, or omit ${chalk.cyan("--platform")} to use your default`
    );
    return;
  }
  logger.info(
    `If this project is not yet registered, run: ${chalk.cyan("cirron register")}`
  );
}

function resolveTag(
  optionTag: string | undefined,
  parsedTag: string | undefined
): string | undefined {
  if (optionTag) {
    return optionTag;
  }
  if (parsedTag) {
    return parsedTag;
  }
  return;
}

async function prepareFileInfo(filePath: string): Promise<PushFileInfo> {
  const stat = await fs.stat(filePath);
  const checksum = await computeFileChecksum(filePath);
  return {
    filePath: path.resolve(filePath),
    relativePath: path.relative(process.cwd(), filePath),
    size: stat.size,
    checksum,
  };
}

async function resolveResourceFile(
  resource: PushResourceType,
  name: string,
  projectConfig: ProjectConfig | null
): Promise<string | null> {
  const cwd = process.cwd();
  const searchPaths: string[] = [];

  if (resource === "model") {
    if (projectConfig?.artifacts?.modelPath) {
      searchPaths.push(path.join(cwd, projectConfig.artifacts.modelPath));
    }
    searchPaths.push(
      path.join(cwd, "models", name),
      path.join(cwd, "models", `${name}.pth`),
      path.join(cwd, "models", `${name}.pt`),
      path.join(cwd, "models", `${name}.joblib`),
      path.join(cwd, "models", `${name}.pkl`),
      path.join(cwd, "models", `${name}.h5`),
      path.join(cwd, "models", `${name}.onnx`),
      path.join(cwd, name)
    );
  } else if (resource === "build") {
    searchPaths.push(
      path.join(cwd, "artifacts", name),
      path.join(cwd, "build", name),
      path.join(cwd, "dist", name),
      path.join(cwd, name)
    );
  } else if (resource === "runtime") {
    searchPaths.push(path.join(cwd, name), path.join(cwd, "runtime", name));
  } else if (resource === "image") {
    searchPaths.push(
      path.join(cwd, name),
      path.join(cwd, `${name}.tar`),
      path.join(cwd, `${name}.tar.gz`)
    );
  }

  for (const searchPath of searchPaths) {
    if (await fs.pathExists(searchPath)) {
      return searchPath;
    }
  }

  return null;
}

// Core Upload Flow

/**
 * Push one artifact: dedupe check, upload, then confirm.
 *
 * The two size paths are mutually exclusive rather than layered. Above the
 * platform's multipart threshold `init` opens its own upload session, so
 * asking for a single-PUT upload URL first would orphan a second one. Both
 * paths yield the session id that `confirmUpload` resolves.
 *
 * A dedupe hit short-circuits the upload entirely unless `force` is set.
 *
 * @param api - Authenticated platform client.
 * @param fileInfo - Path, size and checksum of the artifact.
 * @param options - Registry placement (`resource`, `name`, `tag`, `registry`,
 * `platform`), commit metadata (`message`, `gitHash`), and `force` to upload
 * even when the content already exists.
 * @param spinner - Progress spinner, updated in place.
 * @returns The push result, including whether it was deduped.
 */
export async function uploadSingleFile(
  api: CirronApi,
  fileInfo: PushFileInfo,
  options: {
    resource?: string;
    name?: string;
    tag?: string;
    message?: string;
    registry?: string;
    force?: boolean;
    gitHash?: string;
    platform?: string;
  },
  spinner: ReturnType<typeof ora>
): Promise<PushResult> {
  const displayName = options.name || fileInfo.relativePath;

  // Step 1: Deduplication check
  if (!options.force) {
    spinner.text = `Checking for duplicates for ${displayName}...`;

    const dedupeOpts: { resource?: string; name?: string } = {};
    if (options.resource) {
      dedupeOpts.resource = options.resource;
    }
    if (options.name) {
      dedupeOpts.name = options.name;
    }

    const dedupeResult = await api.checkDedupe(fileInfo.checksum, dedupeOpts);

    if (dedupeResult.exists) {
      return {
        file: fileInfo,
        artifact: {
          id: dedupeResult.artifactId || "",
          name: dedupeResult.artifactName || displayName,
          type: options.resource || "file",
          tag: dedupeResult.tag || options.tag || "",
          filename: path.basename(fileInfo.filePath),
          size: fileInfo.size,
          checksum: fileInfo.checksum,
          createdAt: new Date().toISOString(),
        },
        verified: true,
        skipped: true,
        skipReason: "deduplicated",
      };
    }
  }

  // Steps 2-3: upload the bytes. See the note on this function for why the
  // two size paths are mutually exclusive rather than layered.
  let uploadId: string;

  if (fileInfo.size > MULTIPART_THRESHOLD_BYTES) {
    const multipartOpts: { name?: string; platform?: string } = {};
    if (options.name) {
      multipartOpts.name = options.name;
    }
    if (options.platform) {
      multipartOpts.platform = options.platform;
    }
    uploadId = await uploadMultipart(
      api,
      fileInfo,
      spinner,
      displayName,
      multipartOpts
    );
  } else {
    spinner.text = `Requesting upload URL for ${displayName}...`;

    const uploadUrlOpts: {
      filename: string;
      size: number;
      checksum: string;
      resource?: string;
      name?: string;
      tag?: string;
      registry?: string;
      platform?: string;
    } = {
      filename: path.basename(fileInfo.filePath),
      size: fileInfo.size,
      checksum: fileInfo.checksum,
    };
    if (options.resource) {
      uploadUrlOpts.resource = options.resource;
    }
    if (options.name) {
      uploadUrlOpts.name = options.name;
    }
    if (options.tag) {
      uploadUrlOpts.tag = options.tag;
    }
    if (options.registry) {
      uploadUrlOpts.registry = options.registry;
    }
    if (options.platform) {
      uploadUrlOpts.platform = options.platform;
    }

    const uploadInfo = await api.getUploadUrl(uploadUrlOpts);
    uploadId = uploadInfo.uploadId;

    spinner.text = `Uploading ${displayName} (${formatSize(fileInfo.size)})...`;
    await api.uploadFile(
      uploadInfo.uploadUrl,
      fileInfo.filePath,
      (uploaded, total) => {
        const pct = Math.round((uploaded / total) * 100);
        spinner.text = `Uploading ${displayName}: ${pct}% (${formatSize(uploaded)}/${formatSize(total)})`;
      }
    );
  }

  // Step 4: Confirm upload
  spinner.text = `Confirming upload for ${displayName}...`;

  const confirmOpts: {
    uploadId: string;
    checksum: string;
    size: number;
    resource?: string;
    name?: string;
    tag?: string;
    message?: string;
    gitHash?: string;
  } = {
    uploadId,
    checksum: fileInfo.checksum,
    size: fileInfo.size,
  };
  if (options.resource) {
    confirmOpts.resource = options.resource;
  }
  if (options.name) {
    confirmOpts.name = options.name;
  }
  if (options.tag) {
    confirmOpts.tag = options.tag;
  }
  if (options.message) {
    confirmOpts.message = options.message;
  }
  if (options.gitHash) {
    confirmOpts.gitHash = options.gitHash;
  }

  const confirmation = await api.confirmUpload(confirmOpts);

  return {
    file: fileInfo,
    artifact: {
      id: confirmation.artifactId,
      name: confirmation.name,
      type: confirmation.type,
      tag: confirmation.tag,
      filename: path.basename(fileInfo.filePath),
      size: confirmation.size,
      checksum: confirmation.checksum,
      createdAt: confirmation.createdAt,
    },
    verified: true,
    skipped: false,
  };
}

// Multipart Upload

/**
 * Upload an artifact as provider-native multipart parts.
 *
 * Returns the upload session id, which is what `confirmUpload` resolves (the
 * provider's own upload id is internal to the platform).
 *
 * Parts are presigned one at a time immediately before their PUT because a
 * presigned part URL expires well before a very large upload finishes.
 *
 * **Every part is uploaded every time; an interrupted upload cannot resume.**
 * `init` unconditionally opens a new provider-side multipart upload before it
 * decides whether to reuse a session row, so a re-run can never adopt parts a
 * previous run uploaded, and reading `session/{id}` for prior progress always
 * comes back empty. If `init` ever becomes idempotent, this is what changes.
 */
async function uploadMultipart(
  api: CirronApi,
  fileInfo: PushFileInfo,
  spinner: ReturnType<typeof ora>,
  displayName: string,
  options: { name?: string; platform?: string }
): Promise<string> {
  spinner.text = `Starting multipart upload for ${displayName}...`;

  const initOpts: {
    filename: string;
    size: number;
    checksum: string;
    name?: string;
    platform?: string;
  } = {
    filename: path.basename(fileInfo.filePath),
    size: fileInfo.size,
    checksum: fileInfo.checksum,
  };
  if (options.name) {
    initOpts.name = options.name;
  }
  if (options.platform) {
    initOpts.platform = options.platform;
  }

  const init = await api.initMultipartUpload(initOpts);

  if (init.multipartThreshold !== MULTIPART_THRESHOLD_BYTES) {
    logger.debug(
      `Server multipart threshold is ${init.multipartThreshold} but this CLI uses ${MULTIPART_THRESHOLD_BYTES}`
    );
  }

  // Every part, every time — resume is not possible; see the note above.
  const pending: number[] = [];
  for (let partNumber = 1; partNumber <= init.partCount; partNumber++) {
    pending.push(partNumber);
  }

  let uploadedBytes = 0;
  let done = 0;

  const updateProgress = (): void => {
    const pct = Math.min(
      100,
      Math.round((uploadedBytes / fileInfo.size) * 100)
    );
    spinner.text = `Uploading ${displayName}: ${pct}% (${done}/${init.partCount} parts)`;
  };
  updateProgress();

  try {
    await mapWithConcurrency(
      pending,
      PART_UPLOAD_CONCURRENCY,
      async (partNumber) => {
        const { url } = await api.getMultipartPartUrl({
          sessionId: init.sessionId,
          partNumber,
        });

        const start = (partNumber - 1) * init.partSize;
        const length = Math.min(init.partSize, fileInfo.size - start);

        // Capped at the part's own length: uploadFilePart retries internally
        // and re-streams from zero, so raw deltas would double-count.
        let partCounted = 0;
        const etag = await api.uploadFilePart(
          url,
          fileInfo.filePath,
          start,
          length,
          (delta) => {
            const counted = Math.min(delta, length - partCounted);
            if (counted > 0) {
              partCounted += counted;
              uploadedBytes += counted;
              updateProgress();
            }
          }
        );

        await api.recordMultipartPart({
          sessionId: init.sessionId,
          partNumber,
          etag,
          sizeBytes: length,
        });

        done++;
        updateProgress();
      }
    );

    spinner.text = `Assembling ${displayName} (${init.partCount} parts)...`;
    await api.completeMultipartUpload({ sessionId: init.sessionId });
  } catch (error) {
    // Abort so the provider stops billing for the orphaned parts. A failed
    // abort must not mask the failure that got us here.
    try {
      await api.abortMultipartUpload({ sessionId: init.sessionId });
    } catch (abortError) {
      const msg =
        abortError instanceof Error ? abortError.message : "Unknown error";
      logger.debug(
        `Failed to abort multipart upload ${init.sessionId}: ${msg}`
      );
    }
    throw error;
  }

  return init.sessionId;
}

// Dry Run

function printDryRun(
  files: PushFileInfo[],
  tag: string | undefined,
  jsonOutput: boolean
): void {
  if (jsonOutput) {
    const result = files.map((f) => {
      const entry: {
        path: string;
        size: number;
        checksum: string;
        tag?: string;
      } = {
        path: f.relativePath,
        size: f.size,
        checksum: f.checksum,
      };
      if (tag) {
        entry.tag = tag;
      }
      return entry;
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  logger.info(chalk.bold("Dry run - the following files would be pushed:"));
  console.log();

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  files.forEach((file, index) => {
    logger.info(`  ${index + 1}. ${chalk.cyan(file.relativePath)}`);
    logger.info(`     Size:     ${formatSize(file.size)}`);
    logger.info(`     Checksum: ${file.checksum.slice(0, 12)}...`);
    console.log();
  });

  logger.info(`Total: ${files.length} file(s), ${formatSize(totalSize)}`);
  if (tag) {
    logger.info(`Tag: ${chalk.cyan(tag)}`);
  }
  logger.info(chalk.gray("No files were uploaded. Remove --dry-run to push."));
}

// Main Command

/** Entry point for `cirron push`: upload artifacts to the registry, single-PUT or multipart by size. */
export async function pushCommand(
  resource: string | undefined,
  name: string | undefined,
  options: PushOptions
): Promise<void> {
  // Auth check
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  // Handle --all mode
  if (options.all) {
    await pushAll(api, options);
    return;
  }

  // Validate resource is provided when not using --all
  if (!resource) {
    logger.error("Resource type or path is required");
    logger.info(
      `Usage: ${chalk.cyan("cirron push <resource> [name] [options]")}`
    );
    logger.info(`       ${chalk.cyan("cirron push --all")}`);
    logger.info(`Resource types: ${KNOWN_RESOURCE_TYPES.join(", ")}`);
    return;
  }

  // Determine if resource-typed or path-based
  if (isResourceTyped(resource)) {
    await pushResourceTyped(api, resource as PushResourceType, name, options);
  } else {
    await pushPathBased(api, resource, options);
  }
}

/**
 * Programmatic push for a single file.
 * Used by build command's --push chain.
 */
export async function pushArtifact(
  filePath: string,
  options: {
    resource?: string;
    name?: string;
    tag?: string;
    message?: string;
    registry?: string;
    force?: boolean;
    json?: boolean;
    platform?: string;
  }
): Promise<PushResult> {
  const auth = checkAuth();
  if (!auth) {
    throw new Error("Not authenticated");
  }
  const { api } = auth;

  const fileInfo = await prepareFileInfo(filePath);
  const gitHash = getShortCommitHash() || undefined;

  const spinner = ora(`Pushing ${path.basename(filePath)}...`).start();

  try {
    const uploadOpts = buildUploadOpts({
      resource: options.resource,
      name: options.name,
      tag: options.tag,
      message: options.message,
      registry: options.registry,
      force: options.force,
      gitHash,
      platform: resolvePlatformHint(options.platform),
    });

    const result = await uploadSingleFile(api, fileInfo, uploadOpts, spinner);

    if (result.skipped) {
      spinner.info(
        `Skipped ${chalk.cyan(fileInfo.relativePath)} (${result.skipReason})`
      );
    } else {
      spinner.succeed(`Pushed ${chalk.cyan(fileInfo.relativePath)}`);
    }

    return result;
  } catch (error) {
    spinner.fail(`Failed to push ${path.basename(filePath)}`);
    throw error;
  }
}

// Resource-typed push

async function pushResourceTyped(
  api: CirronApi,
  resource: PushResourceType,
  name: string | undefined,
  options: PushOptions
): Promise<void> {
  if (!name) {
    logger.error(
      `Resource name is required for ${chalk.cyan(`cirron push ${resource}`)}`
    );
    logger.info(
      `Usage: ${chalk.cyan(`cirron push ${resource} <name> [--tag <tag>]`)}`
    );
    return;
  }

  const parsed = parseNameTag(name);
  const resolvedName = parsed.name;
  const resolvedTag = resolveTag(options.tag, parsed.tag);
  const projectConfig = loadProjectConfig();
  const gitHash = getShortCommitHash() || undefined;

  // Resolve the file to push
  const filePath = await resolveResourceFile(
    resource,
    resolvedName,
    projectConfig
  );
  if (!filePath) {
    logger.error(`Could not locate ${resource} file for "${resolvedName}"`);
    logger.info(
      "Ensure the artifact exists in your project or specify a path directly."
    );
    return;
  }

  const tagDisplay = resolvedTag ? `:${resolvedTag}` : "";
  const spinner = ora(
    `Preparing to push ${resource} ${resolvedName}${tagDisplay}...`
  ).start();

  try {
    const fileInfo = await prepareFileInfo(filePath);

    if (options.dryRun) {
      spinner.stop();
      printDryRun([fileInfo], resolvedTag, options.json ?? false);
      return;
    }

    const uploadOpts = buildUploadOpts({
      resource,
      name: resolvedName,
      tag: resolvedTag,
      message: options.message,
      registry: options.registry,
      force: options.force,
      gitHash,
      platform: resolvePlatformHint(options.platform),
    });

    const result = await uploadSingleFile(api, fileInfo, uploadOpts, spinner);

    if (result.skipped) {
      spinner.info(
        `Skipped ${chalk.cyan(resolvedName)}${tagDisplay} (${result.skipReason})`
      );
    } else {
      spinner.succeed(
        `Pushed ${chalk.cyan(resolvedName)}${tagDisplay} (${formatSize(fileInfo.size)})`
      );
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    spinner.fail(`Failed to push ${resource} ${resolvedName}`);
    handlePlatformError(error);
    if (error instanceof Error) {
      logger.error(error.message);
      logNotFoundHint(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

// Path-based push

async function pushPathBased(
  api: CirronApi,
  resourcePath: string,
  options: PushOptions
): Promise<void> {
  if (!(await fs.pathExists(resourcePath))) {
    logger.error(`Path not found: ${resourcePath}`);
    return;
  }

  const resolvedTag = resolveTag(options.tag, undefined);
  const gitHash = getShortCommitHash() || undefined;

  const spinner = ora(`Collecting files from ${resourcePath}...`).start();

  try {
    const filePaths = await collectFiles(resourcePath);

    if (filePaths.length === 0) {
      spinner.fail(`No files found at ${resourcePath}`);
      return;
    }

    spinner.text = `Computing checksums for ${filePaths.length} file(s)...`;
    const fileInfos = await mapWithConcurrency(
      filePaths,
      CHECKSUM_CONCURRENCY,
      (fp) => prepareFileInfo(fp)
    );

    if (options.dryRun) {
      spinner.stop();
      printDryRun(fileInfos, resolvedTag, options.json ?? false);
      return;
    }

    if (fileInfos.length === 1) {
      const fileInfo = fileInfos[0]!;

      const uploadOpts = buildUploadOpts({
        tag: resolvedTag,
        message: options.message,
        registry: options.registry,
        force: options.force,
        gitHash,
        platform: resolvePlatformHint(options.platform),
      });

      const result = await uploadSingleFile(api, fileInfo, uploadOpts, spinner);

      if (result.skipped) {
        spinner.info(
          `Skipped ${chalk.cyan(resourcePath)} (${result.skipReason})`
        );
      } else {
        spinner.succeed(
          `Pushed ${chalk.cyan(resourcePath)} (${formatSize(fileInfo.size)})`
        );
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      }
    } else {
      spinner.succeed(
        `Found ${fileInfos.length} file(s) in ${chalk.cyan(resourcePath)}`
      );

      const multiOpts: {
        tag?: string;
        message?: string;
        registry?: string;
        force?: boolean;
        json?: boolean;
        gitHash?: string;
        platform?: string;
      } = {};
      if (resolvedTag) {
        multiOpts.tag = resolvedTag;
      }
      if (options.message) {
        multiOpts.message = options.message;
      }
      if (options.registry) {
        multiOpts.registry = options.registry;
      }
      if (options.force) {
        multiOpts.force = options.force;
      }
      if (options.json) {
        multiOpts.json = options.json;
      }
      if (gitHash) {
        multiOpts.gitHash = gitHash;
      }
      const multiPlatform = resolvePlatformHint(options.platform);
      if (multiPlatform) {
        multiOpts.platform = multiPlatform;
      }

      await pushMultipleFiles(api, fileInfos, multiOpts);
    }
  } catch (error) {
    spinner.fail(`Failed to push ${resourcePath}`);
    if (error instanceof Error) {
      logger.error(error.message);
      logNotFoundHint(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

// Push all

async function pushAll(api: CirronApi, options: PushOptions): Promise<void> {
  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    logger.error(
      "No cirron config found (cirron.yaml or cirron.json) in current directory"
    );
    logger.info(
      `Run ${chalk.cyan("cirron init")} to initialize a project, or use ${chalk.cyan("cirron push <resource> <name>")} to push a specific artifact`
    );
    return;
  }

  const spinner = ora(
    `Collecting project artifacts for ${projectConfig.name}...`
  ).start();

  try {
    const filePaths = await collectProjectFiles(projectConfig, options.ignore);

    if (filePaths.length === 0) {
      spinner.info("No artifact files found in project");
      logger.info(
        "Ensure your project config has artifacts configured, or use path-based push."
      );
      return;
    }

    spinner.text = `Computing checksums for ${filePaths.length} file(s)...`;
    const fileInfos = await mapWithConcurrency(
      filePaths,
      CHECKSUM_CONCURRENCY,
      (fp) => prepareFileInfo(fp)
    );

    const resolvedTag = resolveTag(options.tag, undefined);
    const gitHash = getShortCommitHash() || undefined;

    if (options.dryRun) {
      spinner.stop();
      printDryRun(fileInfos, resolvedTag, options.json ?? false);
      return;
    }

    spinner.succeed(
      `Found ${fileInfos.length} artifact file(s) for project ${chalk.cyan(projectConfig.name)}`
    );

    const allOpts: {
      tag?: string;
      message?: string;
      registry?: string;
      force?: boolean;
      json?: boolean;
      gitHash?: string;
      projectName?: string;
      platform?: string;
    } = {
      projectName: projectConfig.name,
    };
    if (resolvedTag) {
      allOpts.tag = resolvedTag;
    }
    if (options.message) {
      allOpts.message = options.message;
    }
    if (options.registry) {
      allOpts.registry = options.registry;
    }
    if (options.force) {
      allOpts.force = options.force;
    }
    if (options.json) {
      allOpts.json = options.json;
    }
    if (gitHash) {
      allOpts.gitHash = gitHash;
    }
    const allPlatform = resolvePlatformHint(options.platform);
    if (allPlatform) {
      allOpts.platform = allPlatform;
    }

    await pushMultipleFiles(api, fileInfos, allOpts);
  } catch (error) {
    spinner.fail("Failed to push project artifacts");
    if (error instanceof Error) {
      logger.error(error.message);
      logNotFoundHint(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

// Multi-file push with summary

async function pushMultipleFiles(
  api: CirronApi,
  files: PushFileInfo[],
  options: {
    tag?: string;
    message?: string;
    registry?: string;
    force?: boolean;
    json?: boolean;
    gitHash?: string;
    projectName?: string;
    platform?: string;
  }
): Promise<void> {
  const results: PushResult[] = [];
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let uploadedBytes = 0;

  for (const fileInfo of files) {
    const itemSpinner = ora(
      `Pushing ${fileInfo.relativePath} (${formatSize(fileInfo.size)})...`
    ).start();

    try {
      const uploadOpts = buildUploadOpts({
        tag: options.tag,
        message: options.message,
        registry: options.registry,
        force: options.force,
        gitHash: options.gitHash,
        platform: options.platform,
      });

      const result = await uploadSingleFile(
        api,
        fileInfo,
        uploadOpts,
        itemSpinner
      );

      if (result.skipped) {
        itemSpinner.info(
          `Skipped ${chalk.cyan(fileInfo.relativePath)} (${result.skipReason})`
        );
        skipCount++;
      } else {
        itemSpinner.succeed(
          `Pushed ${chalk.cyan(fileInfo.relativePath)} (${formatSize(fileInfo.size)})`
        );
        successCount++;
        uploadedBytes += fileInfo.size;
      }

      results.push(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      itemSpinner.fail(`Failed to push ${fileInfo.relativePath}: ${msg}`);
      failCount++;
      const failedArtifact: PushArtifactInfo = {
        id: "",
        name: fileInfo.relativePath,
        type: "file",
        tag: options.tag || "",
        filename: path.basename(fileInfo.filePath),
        size: fileInfo.size,
        checksum: fileInfo.checksum,
        createdAt: new Date().toISOString(),
      };
      results.push({
        file: fileInfo,
        artifact: failedArtifact,
        verified: false,
        skipped: false,
      });
    }
  }

  // Create version entry if project-wide push
  if (options.projectName && successCount > 0) {
    try {
      const artifactEntries = results
        .filter((r) => !r.skipped && r.artifact.id)
        .map((r) => ({
          artifactId: r.artifact.id,
          filename: r.artifact.filename,
          checksum: r.artifact.checksum,
          size: r.artifact.size,
          type: r.artifact.type,
        }));

      if (artifactEntries.length > 0) {
        const versionOpts: {
          projectName: string;
          artifacts: typeof artifactEntries;
          tag?: string;
          message?: string;
          gitHash?: string;
        } = {
          projectName: options.projectName,
          artifacts: artifactEntries,
        };
        if (options.tag) {
          versionOpts.tag = options.tag;
        }
        if (options.message) {
          versionOpts.message = options.message;
        }
        if (options.gitHash) {
          versionOpts.gitHash = options.gitHash;
        }

        await api.createVersion(versionOpts);
      }
    } catch (error) {
      logger.warn(
        "Failed to create version entry. Artifacts were uploaded successfully."
      );
      if (error instanceof Error) {
        logger.debug(`Version creation error: ${error.message}`);
      }
    }
  }

  // Summary
  console.log();
  logger.info(chalk.bold("Push summary:"));
  logger.info(
    `  Uploaded: ${chalk.green(String(successCount))} (${formatSize(uploadedBytes)})`
  );
  if (skipCount > 0) {
    logger.info(
      `  Skipped:  ${chalk.yellow(String(skipCount))} (identical content)`
    );
  }
  if (failCount > 0) {
    logger.info(`  Failed:   ${chalk.red(String(failCount))}`);
  }
  if (options.tag) {
    logger.info(`  Tag:      ${chalk.cyan(options.tag)}`);
  }

  if (options.json) {
    const summary: PushSummary = {
      totalFiles: files.length,
      uploaded: successCount,
      skipped: skipCount,
      failed: failCount,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      uploadedBytes,
      tag: options.tag || "",
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
  }

  if (failCount > 0) {
    process.exit(1);
  }
}
