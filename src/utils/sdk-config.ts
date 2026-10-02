import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";

export type ResolutionSource = "default" | "config.toml" | "env" | "unset";

export interface ResolvedField<T> {
  /** Env var name when `source === 'env'`, else null. */
  envVar: string | null;
  source: ResolutionSource;
  value: T;
}

export interface ResolvedSdkConfig {
  apiEndpoint: ResolvedField<string>;
  apiKeyConfigured: ResolvedField<boolean>;
  configTomlFound: boolean;
  configTomlPath: string;
  flushInterval: ResolvedField<number>;
  ingestPath: ResolvedField<string>;
  loadMaxBytes: ResolvedField<number>;
  loadWarnBytes: ResolvedField<number>;
  outputDir: ResolvedField<string>;
  sampleRate: ResolvedField<number>;
  snapshots: ResolvedField<string>;
  spoolMaxBytes: ResolvedField<number>;
  workspaceId: ResolvedField<string | null>;
}

// Mirrors the SDK's own config defaults; keep the two in step.
const DEFAULTS = {
  api_endpoint: "https://app.cirron.com",
  workspace_id: null as string | null,
  output_dir: "./.cirron/",
  snapshots: "stats",
  sample_rate: 0.01,
  flush_interval: 1.0,
  spool_max_bytes: 1_000_000_000,
  ingest_path: "/api/traces",
  load_warn_bytes: 1_000_000_000,
  load_max_bytes: 10_000_000_000,
} as const;

// Field -> env var, mirroring _ENV_MAP in config.py.
const ENV_MAP: Record<string, string> = {
  api_key: "CIRRON_API_KEY",
  api_endpoint: "CIRRON_API_ENDPOINT",
  workspace_id: "CIRRON_WORKSPACE_ID",
  output_dir: "CIRRON_OUTPUT_DIR",
  snapshots: "CIRRON_SNAPSHOTS",
  sample_rate: "CIRRON_SAMPLE_RATE",
  flush_interval: "CIRRON_FLUSH_INTERVAL",
  spool_max_bytes: "CIRRON_SPOOL_MAX_BYTES",
  ingest_path: "CIRRON_INGEST_PATH",
  load_warn_bytes: "CIRRON_LOAD_WARN_BYTES",
  load_max_bytes: "CIRRON_LOAD_MAX_BYTES",
};

const VALID_SNAPSHOTS = new Set(["stats", "sampled", "full"]);

type Coercer = (raw: unknown) => unknown | null;

const COERCERS: Record<string, Coercer> = {
  api_key: coerceStr,
  api_endpoint: coerceStr,
  workspace_id: coerceStr,
  output_dir: coerceStr,
  snapshots: coerceSnapshot,
  sample_rate: coerceFloat,
  flush_interval: coerceFloat,
  spool_max_bytes: coerceInt,
  ingest_path: coerceStr,
  load_warn_bytes: coerceInt,
  load_max_bytes: coerceInt,
};

function coerceStr(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  return null;
}

function coerceFloat(raw: unknown): number | null {
  if (typeof raw === "boolean") {
    return null;
  }
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceInt(raw: unknown): number | null {
  if (typeof raw === "boolean") {
    return null;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function coerceSnapshot(raw: unknown): string | null {
  if (typeof raw === "string" && VALID_SNAPSHOTS.has(raw)) {
    return raw;
  }
  return null;
}

interface TomlLayer {
  found: boolean;
  path: string;
  values: Record<string, unknown>;
}

function readHomeConfigToml(homedir: string = os.homedir()): TomlLayer {
  const cfgPath = path.join(homedir, ".cirron", "config.toml");
  const layer: TomlLayer = { values: {}, path: cfgPath, found: false };
  if (!fs.existsSync(cfgPath)) {
    return layer;
  }
  layer.found = true;
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return layer;
  }
  const defaultTable = parsed["default"];
  if (
    !defaultTable ||
    typeof defaultTable !== "object" ||
    Array.isArray(defaultTable)
  ) {
    return layer;
  }
  const table = defaultTable as Record<string, unknown>;
  for (const [key, coerce] of Object.entries(COERCERS)) {
    if (key in table) {
      const coerced = coerce(table[key]);
      if (coerced !== null) {
        layer.values[key] = coerced;
      }
    }
  }
  return layer;
}

function readEnvOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, envVar] of Object.entries(ENV_MAP)) {
    const raw = env[envVar];
    if (raw === undefined || raw === "") {
      continue;
    }
    const coercer = COERCERS[key];
    if (!coercer) {
      continue;
    }
    const coerced = coercer(raw);
    if (coerced !== null) {
      out[key] = coerced;
    }
  }
  return out;
}

/**
 * TS mirror of cirron.core.config._resolve_config({}) — merges defaults,
 * ~/.cirron/config.toml [default] table, and CIRRON_* env vars, and
 * reports the source of each field for display.
 */
export function resolveSdkConfig(options?: {
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedSdkConfig {
  const homedir = options?.homedir ?? os.homedir();
  const env = options?.env ?? process.env;

  const toml = readHomeConfigToml(homedir);
  const envLayer = readEnvOverrides(env);

  function resolveField<T>(key: string, defaultValue: T): ResolvedField<T> {
    if (key in envLayer) {
      return {
        value: envLayer[key] as T,
        source: "env",
        envVar: ENV_MAP[key] ?? null,
      };
    }
    if (key in toml.values) {
      return {
        value: toml.values[key] as T,
        source: "config.toml",
        envVar: null,
      };
    }
    return { value: defaultValue, source: "default", envVar: null };
  }

  const apiKeyInEnv = "api_key" in envLayer;
  const apiKeyInToml = "api_key" in toml.values;
  const apiKeyConfigured: ResolvedField<boolean> = apiKeyInEnv
    ? { value: true, source: "env", envVar: ENV_MAP["api_key"] ?? null }
    : apiKeyInToml
      ? { value: true, source: "config.toml", envVar: null }
      : { value: false, source: "unset", envVar: null };

  return {
    apiKeyConfigured,
    apiEndpoint: resolveField<string>("api_endpoint", DEFAULTS.api_endpoint),
    workspaceId: resolveField<string | null>(
      "workspace_id",
      DEFAULTS.workspace_id
    ),
    outputDir: resolveField<string>("output_dir", DEFAULTS.output_dir),
    snapshots: resolveField<string>("snapshots", DEFAULTS.snapshots),
    sampleRate: resolveField<number>("sample_rate", DEFAULTS.sample_rate),
    flushInterval: resolveField<number>(
      "flush_interval",
      DEFAULTS.flush_interval
    ),
    spoolMaxBytes: resolveField<number>(
      "spool_max_bytes",
      DEFAULTS.spool_max_bytes
    ),
    ingestPath: resolveField<string>("ingest_path", DEFAULTS.ingest_path),
    loadWarnBytes: resolveField<number>(
      "load_warn_bytes",
      DEFAULTS.load_warn_bytes
    ),
    loadMaxBytes: resolveField<number>(
      "load_max_bytes",
      DEFAULTS.load_max_bytes
    ),
    configTomlPath: toml.path,
    configTomlFound: toml.found,
  };
}
