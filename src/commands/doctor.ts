import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fetch from "node-fetch";
import type { CirronConfig } from "../types";
import { ConfigManager } from "../utils/config";
import {
  findInstalledPackage,
  type InstalledPackage,
  normalizeDistName,
  type RequiresDistEntry,
  readRequiresDist,
} from "../utils/dist-info";
import { HardwareDetector } from "../utils/hardware";
import { logger } from "../utils/logger";
import {
  discoverPythonEnv,
  type PythonEnv,
  type PythonEnvMissing,
} from "../utils/python-env";
import {
  type ResolutionSource,
  type ResolvedSdkConfig,
  resolveSdkConfig,
} from "../utils/sdk-config";
import { CLI_VERSION } from "../utils/version";
import {
  CORE_DIST_NAMES,
  installHintFor,
  noteForPackage,
  SECTION_ORDER,
  SECTION_TITLES,
  type Section,
  sectionForExtra,
} from "./doctor.presentation";

const CIRRON_YAML_NAMES = ["cirron.yaml", "cirron.yml", "cirron.json"];
const HEALTH_TIMEOUT_MS = 3000;
// Meta-extras that re-aggregate other groups in pyproject.toml — skipping
// them avoids duplicating every package under "Other extras".
const META_EXTRAS = new Set(["all", "sql"]);

interface DoctorOptions {
  json?: boolean;
  noColor?: boolean;
  strict?: boolean;
  venv?: string;
}

interface DepRow {
  distName: string;
  extra: string | null;
  installed: boolean;
  installHint: string;
  note: string | undefined;
  section: Section;
  version: string | null;
}

interface PlatformReport {
  authSource: "cli" | "sdk" | "env" | "api" | null;
  configured: boolean;
  endpoint: string;
  endpointSource: "cli" | "sdk";
  error: string | null;
  latencyMs: number | null;
  message: string;
  platformVersion: string | null;
  reachable: boolean | null;
  status: string | null;
  workspaceId: string | null;
}

interface SpoolReport {
  bytes: number;
  dir: string;
  diskFreeBytes: number | null;
  exists: boolean;
  files: number;
  newestMtime: string | null;
  oldestMtime: string | null;
}

interface LocalReport {
  cirronYamlPath: string | null;
  cliAuthenticated: boolean;
  cliConfigFound: boolean;
  cliConfigPath: string;
  dotenvPath: string | null;
  sdkConfigTomlFound: boolean;
  sdkConfigTomlPath: string;
}

interface GpuReport {
  available: boolean;
  detail: string | null;
  memory: string | null;
  model: string | null;
  vendor: string | null;
}

interface DoctorReport {
  cli: { version: string; userAgent: string };
  deps: {
    rowsBySection: Record<Section, DepRow[]>;
    missingCore: string[];
    unknownExtras: string[];
  };
  exitCode: 0 | 1;
  gpu: GpuReport;
  local: LocalReport;
  node: { version: string };
  platform: { system: string; release: string; arch: string; pretty: string };
  platformApi: PlatformReport;
  pythonEnv: {
    found: boolean;
    root: string | null;
    source: string | null;
    sitePackages: string | null;
    pythonVersion: string | null;
    pythonExecutable: string | null;
    checked: string[];
    reason: string | null;
  };
  sdk: {
    installed: boolean;
    version: string | null;
    metadataPath: string | null;
  };
  sdkConfig: ResolvedSdkConfig;
  spool: SpoolReport;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  if (options.noColor) {
    chalk.level = 0;
  }

  const report = await collect(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report);
  }

  process.exit(report.exitCode);
}

async function collect(options: DoctorOptions): Promise<DoctorReport> {
  const cwd = process.cwd();
  const env = discoverPythonEnv(options.venv, cwd);

  const sdkConfig = resolveSdkConfig();
  const cliConfigManager = new ConfigManager();
  const cliConfig = cliConfigManager.load();
  const cliConfigFound = cliConfigManager.exists();

  const pythonEnvInfo = buildPythonEnvInfo(env);
  const sdkPkg = env.root
    ? findInstalledPackage(env.sitePackages, "cirron-sdk")
    : null;

  const depsReport = sdkPkg
    ? buildDepRowsFromSdk(env as PythonEnv, sdkPkg)
    : buildDepRowsWithoutSdk(env);

  const spool = buildSpoolReport(sdkConfig.outputDir.value, cwd);
  const local = buildLocalReport(
    sdkConfig,
    cliConfigManager,
    cliConfigFound,
    cliConfig,
    cwd
  );
  const gpu = await detectGpu();
  const platformApi = await probePlatform(sdkConfig, cliConfig, cliConfigFound);

  const exitCode = determineExitCode({
    envMissing: env.root === null,
    sdkInstalled: sdkPkg !== null,
    missingCore: depsReport.missingCore,
    platformApi,
    strict: options.strict === true,
  });

  return {
    cli: { version: CLI_VERSION, userAgent: `cirron-cli/${CLI_VERSION}` },
    node: { version: process.version },
    platform: describePlatform(),
    pythonEnv: pythonEnvInfo,
    sdk: sdkPkg
      ? {
          installed: true,
          version: sdkPkg.version,
          metadataPath: sdkPkg.metadataPath,
        }
      : { installed: false, version: null, metadataPath: null },
    deps: depsReport,
    sdkConfig,
    platformApi,
    spool,
    local,
    gpu,
    exitCode,
  };
}

function buildPythonEnvInfo(
  env: PythonEnv | PythonEnvMissing
): DoctorReport["pythonEnv"] {
  if (env.root === null) {
    return {
      found: false,
      root: null,
      source: null,
      sitePackages: null,
      pythonVersion: null,
      pythonExecutable: null,
      checked: env.checked,
      reason: env.reason,
    };
  }
  return {
    found: true,
    root: env.root,
    source: env.source,
    sitePackages: env.sitePackages,
    pythonVersion: env.pythonVersion,
    pythonExecutable: env.pythonExecutable,
    checked: [],
    reason: null,
  };
}

function buildDepRowsFromSdk(
  env: PythonEnv,
  sdkPkg: InstalledPackage
): DoctorReport["deps"] {
  const reqs = readRequiresDist(sdkPkg.metadataPath);
  const rowsBySection = makeEmptyRows();

  const sdkRow = makeRow(
    {
      requirement: "cirron-sdk",
      distName: "cirron-sdk",
      extra: null,
      raw: "cirron-sdk",
    },
    sdkPkg
  );
  rowsBySection.core.push(sdkRow);

  const unknownExtras = new Set<string>();
  const seen = new Set<string>();
  for (const req of reqs) {
    // Skip meta-extras that re-aggregate other groups (would duplicate rows).
    if (req.extra !== null && META_EXTRAS.has(req.extra)) {
      continue;
    }
    const key = `${req.extra ?? "-"}::${normalizeDistName(req.distName)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const installed = findInstalledPackage(env.sitePackages, req.distName);
    const row = makeRow(req, installed);
    rowsBySection[row.section].push(row);
    if (row.section === "other" && req.extra !== null) {
      unknownExtras.add(req.extra);
    }
  }

  for (const section of Object.keys(rowsBySection) as Section[]) {
    rowsBySection[section].sort((a, b) => a.distName.localeCompare(b.distName));
  }

  const missingCore: string[] = [];
  for (const name of CORE_DIST_NAMES) {
    const found = rowsBySection.core.find(
      (r) => normalizeDistName(r.distName) === normalizeDistName(name)
    );
    if (!(found && found.installed)) {
      missingCore.push(name);
    }
  }

  return {
    rowsBySection,
    missingCore,
    unknownExtras: [...unknownExtras].sort(),
  };
}

function buildDepRowsWithoutSdk(
  env: PythonEnv | PythonEnvMissing
): DoctorReport["deps"] {
  const rowsBySection = makeEmptyRows();
  const sdkInstalled = false;

  // Even without the SDK, surface "cirron-sdk missing" so users see the fix.
  rowsBySection.core.push({
    distName: "cirron-sdk",
    installed: false,
    version: null,
    extra: null,
    section: "core",
    note: undefined,
    installHint: "pip install 'cirron-sdk'",
  });

  const missingCore = sdkInstalled ? [] : ["cirron-sdk"];
  // We can't enumerate the other core deps without the SDK's METADATA, so
  // they're left off the report rather than faked.
  void env;
  return { rowsBySection, missingCore, unknownExtras: [] };
}

function makeRow(
  req: RequiresDistEntry,
  installed: InstalledPackage | null
): DepRow {
  const section = sectionForExtra(req.extra);
  const normalized = normalizeDistName(req.distName);
  return {
    distName: installed?.name ?? req.distName,
    installed: installed !== null,
    version: installed?.version ?? null,
    extra: req.extra,
    section,
    note: noteForPackage(normalized, req.extra),
    installHint: installHintFor(req.extra),
  };
}

function makeEmptyRows(): Record<Section, DepRow[]> {
  const out = {} as Record<Section, DepRow[]>;
  for (const section of SECTION_ORDER) {
    out[section] = [];
  }
  return out;
}

function buildSpoolReport(outputDir: string, cwd: string): SpoolReport {
  const resolvedOutput = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(cwd, outputDir);
  const dir = path.join(resolvedOutput, "spool");
  const report: SpoolReport = {
    dir,
    exists: false,
    files: 0,
    bytes: 0,
    oldestMtime: null,
    newestMtime: null,
    diskFreeBytes: null,
  };

  if (fs.existsSync(dir)) {
    report.exists = true;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let oldest: number | null = null;
      let newest: number | null = null;
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const stat = fs.statSync(path.join(dir, entry.name));
        report.files += 1;
        report.bytes += stat.size;
        const mtime = stat.mtimeMs;
        if (oldest === null || mtime < oldest) {
          oldest = mtime;
        }
        if (newest === null || mtime > newest) {
          newest = mtime;
        }
      }
      if (oldest !== null) {
        report.oldestMtime = new Date(oldest).toISOString();
      }
      if (newest !== null) {
        report.newestMtime = new Date(newest).toISOString();
      }
    } catch {
      // Unreadable directory — leave counts at zero.
    }
  }

  const statfs = (
    fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; bavail: number };
    }
  ).statfsSync;
  if (statfs) {
    try {
      const st = statfs(fs.existsSync(dir) ? dir : resolvedOutput);
      report.diskFreeBytes = Number(st.bsize) * Number(st.bavail);
    } catch {
      // statfs may fail on some platforms — non-fatal.
    }
  }

  return report;
}

function buildLocalReport(
  cfg: ResolvedSdkConfig,
  cliMgr: ConfigManager,
  cliConfigFound: boolean,
  cliConfig: CirronConfig,
  cwd: string
): LocalReport {
  const cirronYamlPath = findUpwards(cwd, CIRRON_YAML_NAMES);
  const dotenvPath = fs.existsSync(path.join(cwd, ".env"))
    ? path.join(cwd, ".env")
    : null;
  return {
    cliConfigPath: cliMgr.getConfigPath(),
    cliConfigFound,
    cliAuthenticated: cliHasAuth(cliConfig),
    sdkConfigTomlPath: cfg.configTomlPath,
    sdkConfigTomlFound: cfg.configTomlFound,
    cirronYamlPath,
    dotenvPath,
  };
}

function cliHasAuth(cfg: CirronConfig): boolean {
  return Boolean(cfg.auth?.accessToken);
}

function cliAuthHeader(cfg: CirronConfig): string | null {
  return cfg.auth?.accessToken ? `Bearer ${cfg.auth.accessToken}` : null;
}

function findUpwards(start: string, names: string[]): string | null {
  let current = path.resolve(start);
  while (true) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function detectGpu(): Promise<GpuReport> {
  try {
    const gpu = await HardwareDetector.detectGPU();
    if (!gpu) {
      return {
        available: false,
        vendor: null,
        model: null,
        memory: null,
        detail: null,
      };
    }
    const model = gpu.model && gpu.model !== "Unknown" ? gpu.model : null;
    const memory = gpu.memory && gpu.memory !== "Unknown" ? gpu.memory : null;
    return {
      available: Boolean(model || memory),
      vendor: null,
      model,
      memory,
      detail: [model, memory].filter(Boolean).join(" ") || null,
    };
  } catch {
    return {
      available: false,
      vendor: null,
      model: null,
      memory: null,
      detail: null,
    };
  }
}

async function probePlatform(
  cfg: ResolvedSdkConfig,
  cliConfig: CirronConfig,
  cliConfigFound: boolean
): Promise<PlatformReport> {
  // The CLI's ~/.cirron/config.json is the source of truth for auth
  // when `cirron auth login` has been run; the SDK's ~/.cirron/config.toml
  // is a separate layer for the Python SDK. Prefer the CLI config here so
  // `cirron doctor` reflects what `cirron auth status` reports.
  const cliAuthed = cliConfigFound && cliHasAuth(cliConfig);
  const endpoint = cliAuthed ? cliConfig.apiUrl : cfg.apiEndpoint.value;
  const endpointSource: "cli" | "sdk" = cliAuthed ? "cli" : "sdk";
  const workspaceId = cfg.workspaceId.value;
  const authSource: PlatformReport["authSource"] = cliConfig.auth?.accessToken
    ? "cli"
    : cfg.apiKeyConfigured.source === "env"
      ? "env"
      : cfg.apiKeyConfigured.source === "config.toml"
        ? "sdk"
        : cfg.apiKeyConfigured.value
          ? "api"
          : null;

  if (!(cliAuthed || cfg.apiKeyConfigured.value)) {
    return {
      configured: false,
      endpoint,
      endpointSource,
      workspaceId,
      authSource: null,
      reachable: null,
      latencyMs: null,
      status: null,
      platformVersion: null,
      error: null,
      message: "not configured — run `cirron auth login`",
    };
  }

  const url = `${trimTrailingSlash(endpoint)}/api/health`;
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const bearer = cliAuthHeader(cliConfig);
  if (bearer) {
    headers["Authorization"] = bearer;
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal as AbortSignal,
    });
    const latency = Math.round(performance.now() - start);
    let body: { status?: string; version?: string } = {};
    try {
      body = (await resp.json()) as { status?: string; version?: string };
    } catch {
      // Non-JSON body — treat as reachable but status unknown.
    }
    const reachable = resp.status >= 200 && resp.status < 600;
    const statusStr = body.status ?? (resp.ok ? "healthy" : "unhealthy");
    return {
      configured: true,
      endpoint,
      endpointSource,
      workspaceId,
      authSource,
      reachable,
      latencyMs: latency,
      status: statusStr,
      platformVersion: body.version ?? null,
      error: resp.ok ? null : `HTTP ${resp.status}`,
      message: describePlatformStatus(resp.status, statusStr, latency),
    };
  } catch (err) {
    const latency = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      configured: true,
      endpoint,
      endpointSource,
      workspaceId,
      authSource,
      reachable: false,
      latencyMs: latency,
      status: null,
      platformVersion: null,
      error: message,
      message: `unreachable: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function describePlatformStatus(
  httpStatus: number,
  status: string,
  latencyMs: number
): string {
  if (httpStatus >= 500) {
    return `${status} (HTTP ${httpStatus}, ${latencyMs}ms)`;
  }
  if (status === "healthy") {
    return `healthy — latency ${latencyMs}ms`;
  }
  return `${status} (${latencyMs}ms)`;
}

function determineExitCode(inputs: {
  envMissing: boolean;
  sdkInstalled: boolean;
  missingCore: string[];
  platformApi: PlatformReport;
  strict: boolean;
}): 0 | 1 {
  if (inputs.envMissing) {
    return inputs.strict ? 1 : 0;
  }
  if (!inputs.sdkInstalled) {
    return 1;
  }
  if (inputs.missingCore.length > 0) {
    return 1;
  }
  if (inputs.platformApi.configured) {
    if (inputs.platformApi.reachable === false) {
      return 1;
    }
    if (inputs.platformApi.status === "unhealthy") {
      return 1;
    }
  }
  return 0;
}

function describePlatform(): DoctorReport["platform"] {
  const system = os.platform();
  const release = os.release();
  const arch = os.arch();
  const pretty = `${prettyOsName(system)} ${release} ${arch}`;
  return { system, release, arch, pretty };
}

function prettyOsName(system: string): string {
  switch (system) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return system;
  }
}

// -------------------- rendering --------------------

function renderHuman(report: DoctorReport): void {
  console.log();
  console.log(chalk.bold(`cirron-cli ${report.cli.version}`));
  console.log(
    `Python ${report.pythonEnv.pythonVersion ?? "(unknown)"}${
      report.pythonEnv.pythonExecutable
        ? ` (${report.pythonEnv.pythonExecutable})`
        : ""
    }`
  );
  console.log(`Node ${report.node.version}`);
  console.log(`Platform: ${report.platform.pretty}`);
  console.log();

  renderPythonEnvSection(report);
  renderDepsSections(report);
  renderPlatformSection(report);
  renderLocalSection(report);
  renderSpoolSection(report);
  renderGpuSection(report);
  renderSummary(report);
}

function renderPythonEnvSection(report: DoctorReport): void {
  const env = report.pythonEnv;
  if (!env.found) {
    console.log(chalk.yellow("Environment:"));
    console.log(
      `  ${statusGlyph("warn")} ${env.reason ?? "no virtualenv detected"}`
    );
    if (env.checked.length > 0) {
      console.log(chalk.gray(`  checked: ${env.checked.join(", ")}`));
    }
    console.log(
      chalk.gray(
        "  Tip: activate a venv or pass --venv <path>. Extras checks are skipped."
      )
    );
    console.log();
    return;
  }
  console.log(chalk.cyan("Environment:"));
  console.log(`  Source           ${env.source}`);
  console.log(`  Root             ${env.root}`);
  console.log(chalk.gray(`  site-packages    ${env.sitePackages}`));
  console.log();
}

function renderDepsSections(report: DoctorReport): void {
  if (!report.pythonEnv.found) {
    return;
  }

  if (!report.sdk.installed) {
    console.log(chalk.cyan("Core:"));
    const row = report.deps.rowsBySection.core[0];
    if (row) {
      renderDepRow(row, 0);
    }
    console.log(
      chalk.gray(
        "  Install cirron-sdk to see available framework/data/snapshot extras."
      )
    );
    console.log();
    return;
  }

  const nameWidth = computeNameWidth(report);
  for (const section of SECTION_ORDER) {
    const rows = report.deps.rowsBySection[section];
    if (rows.length === 0) {
      continue;
    }
    console.log(chalk.cyan(`${SECTION_TITLES[section]}:`));
    for (const row of rows) {
      renderDepRow(row, nameWidth);
    }
    console.log();
  }
}

function computeNameWidth(report: DoctorReport): number {
  let max = 0;
  for (const section of SECTION_ORDER) {
    for (const row of report.deps.rowsBySection[section]) {
      if (row.distName.length > max) {
        max = row.distName.length;
      }
    }
  }
  return Math.min(Math.max(max, 12), 24);
}

function renderDepRow(row: DepRow, nameWidth: number): void {
  const name = row.distName.padEnd(nameWidth);
  const glyph = row.installed ? statusGlyph("ok") : statusGlyph("missing");
  const version = row.installed
    ? (row.version ?? "").padEnd(10)
    : "".padEnd(10);
  const note = row.installed
    ? row.note
      ? chalk.gray(row.note)
      : ""
    : chalk.gray(row.installHint);
  console.log(`  ${name}  ${glyph}  ${version} ${note}`);
}

function renderPlatformSection(report: DoctorReport): void {
  console.log(chalk.cyan("Platform:"));
  const endpointTag = chalk.gray(
    report.platformApi.endpointSource === "cli"
      ? "(from ~/.cirron/config.json)"
      : "(from SDK config)"
  );
  console.log(
    `  Endpoint         ${report.platformApi.endpoint} ${endpointTag}`
  );
  if (!report.platformApi.configured) {
    console.log(
      `  Authentication   ${statusGlyph("warn")} ${report.platformApi.message}`
    );
    console.log();
    return;
  }
  const glyph =
    report.platformApi.reachable && report.platformApi.status !== "unhealthy"
      ? statusGlyph("ok")
      : statusGlyph("missing");
  const authLabel =
    report.platformApi.authSource === "cli"
      ? "CLI"
      : report.platformApi.authSource === "sdk"
        ? "SDK"
        : report.platformApi.authSource === "env"
          ? "Environment"
          : report.platformApi.authSource === "api"
            ? "API key"
            : "unknown";
  console.log(`  Authentication   ${statusGlyph("ok")}  ${authLabel}`);
  if (report.platformApi.workspaceId) {
    console.log(`  Workspace        ${report.platformApi.workspaceId}`);
  }
  console.log(`  Connection       ${glyph}  ${report.platformApi.message}`);
  if (report.platformApi.platformVersion) {
    console.log(
      chalk.gray(`  Platform version ${report.platformApi.platformVersion}`)
    );
  }
  console.log();
}

function renderLocalSection(report: DoctorReport): void {
  console.log(chalk.cyan("Local:"));
  const cfg = report.sdkConfig;
  const cliTag = report.local.cliAuthenticated
    ? chalk.gray("(authenticated)")
    : report.local.cliConfigFound
      ? chalk.gray("(not authenticated)")
      : chalk.gray("(not found)");
  console.log(`  CLI config       ${report.local.cliConfigPath} ${cliTag}`);
  const sdkTag = report.local.sdkConfigTomlFound
    ? chalk.gray("(found)")
    : chalk.gray("(not found)");
  console.log(`  SDK config       ${report.local.sdkConfigTomlPath} ${sdkTag}`);
  if (report.local.cirronYamlPath) {
    console.log(`  Project config   ${report.local.cirronYamlPath}`);
  }
  if (report.local.dotenvPath) {
    console.log(`  .env             ${report.local.dotenvPath}`);
  }
  console.log(
    `  Output dir       ${cfg.outputDir.value} ${sourceTag(cfg.outputDir.source, cfg.outputDir.envVar)}`
  );
  console.log();
}

function renderSpoolSection(report: DoctorReport): void {
  console.log(chalk.cyan("Spool:"));
  const s = report.spool;
  const summary = s.exists
    ? `${s.files} file(s), ${formatBytes(s.bytes)}`
    : chalk.gray("(empty / not yet created)");
  console.log(`  Directory        ${s.dir}`);
  console.log(`  Contents         ${summary}`);
  if (s.oldestMtime && s.newestMtime && s.files > 1) {
    console.log(
      chalk.gray(`  Oldest / newest  ${s.oldestMtime}  ${s.newestMtime}`)
    );
  }
  if (s.diskFreeBytes !== null) {
    console.log(
      chalk.gray(`  Disk free        ${formatBytes(s.diskFreeBytes)}`)
    );
  }
  console.log();
}

function renderGpuSection(report: DoctorReport): void {
  if (!report.gpu.available) {
    return;
  }
  console.log(chalk.cyan("GPU:"));
  console.log(`  ${report.gpu.detail ?? report.gpu.model ?? "detected"}`);
  console.log();
}

function renderSummary(report: DoctorReport): void {
  if (report.exitCode === 0) {
    if (report.pythonEnv.found) {
      console.log(chalk.green("Environment looks good."));
    } else {
      logger.warn(
        "Dependency checks skipped — no Python environment detected."
      );
    }
  } else if (!report.pythonEnv.found) {
    logger.error("No Python environment detected (--strict).");
  } else if (!report.sdk.installed) {
    logger.error(
      "cirron-sdk is not installed in the target environment. Run: pip install 'cirron-sdk'"
    );
  } else if (report.deps.missingCore.length > 0) {
    logger.error(
      `Missing core dependencies: ${report.deps.missingCore.join(", ")}`
    );
  } else if (
    report.platformApi.configured &&
    report.platformApi.reachable === false
  ) {
    logger.error(
      `Platform unreachable at ${report.platformApi.endpoint}: ${report.platformApi.error ?? "unknown error"}`
    );
  }
  if (report.deps.unknownExtras.length > 0) {
    logger.info(
      chalk.gray(
        `  Note: installed SDK declares unknown extras (${report.deps.unknownExtras.join(", ")}). Upgrade cirron-cli for friendlier labels.`
      )
    );
  }
  console.log();
}

function statusGlyph(kind: "ok" | "missing" | "warn"): string {
  switch (kind) {
    case "ok":
      return chalk.green("[OK]");
    case "missing":
      return chalk.red("[X] ");
    case "warn":
      return chalk.yellow("[!] ");
    default:
      return "";
  }
}

function sourceTag(source: ResolutionSource, envVar: string | null): string {
  switch (source) {
    case "default":
      return chalk.gray("(default)");
    case "config.toml":
      return chalk.gray("(config.toml)");
    case "env":
      return chalk.gray(`(env: ${envVar ?? "CIRRON_*"})`);
    case "unset":
      return chalk.gray("(unset)");
    default:
      return "";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
