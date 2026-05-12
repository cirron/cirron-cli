/**
 * Monorepo / workspace layer for the Cirron CLI.
 *
 * A root cirron config (`cirron.yaml`, `cirron.yml`, or `cirron.json`) with a
 * top-level `workspace:` key puts the CLI in monorepo mode: it discovers the
 * model directories listed under `workspace.models`, applies any
 * `workspace.defaults` to each, and lets commands fan out across them. Without
 * that key the CLI stays in single-model mode (the existing behavior).
 */

import path from "node:path";
import fs from "fs-extra";
import yaml from "js-yaml";
import { minimatch } from "minimatch";
import type {
  ProjectConfig,
  WorkspaceConfig,
  WorkspaceDefaults,
} from "../types";
import {
  CONFIG_FILES,
  loadProjectConfig,
  type ProjectConfigResult,
} from "./project-config";

export interface WorkspaceConfigResult {
  config: WorkspaceConfig;
  configPath: string;
  filename: string;
}

export interface DiscoveredModel {
  /** Model config with workspace defaults already merged in. */
  config: ProjectConfig;
  /** Absolute path to the model's cirron config file. */
  configPath: string;
  /** The model's `name` field from its own cirron config. */
  name: string;
  /** Path to the model directory, relative to the workspace root. */
  path: string;
}

export type CliMode =
  | { mode: "monorepo"; workspace: WorkspaceConfigResult; rootDir: string }
  | { mode: "single"; project: ProjectConfigResult }
  | { mode: "none" };

function parseConfigFile(configPath: string, filename: string): unknown {
  const raw = fs.readFileSync(configPath, "utf8");
  const isYaml = filename.endsWith(".yaml") || filename.endsWith(".yml");
  try {
    return isYaml ? yaml.load(raw) : JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${filename}: ${msg}`);
  }
}

export function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspace" in value &&
    typeof (value as { workspace: unknown }).workspace === "object" &&
    (value as { workspace: unknown }).workspace !== null
  );
}

function findCirronConfigInDir(dir: string): string | null {
  for (const filename of CONFIG_FILES) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Load the root workspace config from `dir` (defaults to cwd). Returns null if
 * there is no cirron config there, or if the config has no `workspace` key.
 */
export function loadWorkspaceConfig(
  dir?: string
): WorkspaceConfigResult | null {
  const baseDir = path.resolve(dir || process.cwd());
  for (const filename of CONFIG_FILES) {
    const configPath = path.join(baseDir, filename);
    if (!(fs.existsSync(configPath) && fs.statSync(configPath).isFile())) {
      continue;
    }
    const parsed = parseConfigFile(configPath, filename);
    if (isWorkspaceConfig(parsed)) {
      return { config: parsed, configPath, filename };
    }
    return null;
  }
  return null;
}

/**
 * Determine which mode the CLI should operate in for the given directory:
 * monorepo (workspace config present), single-model (a plain cirron config),
 * or none (no cirron config at all). Only inspects `dir` itself — there is no
 * upward search, so running inside a model subdirectory of a monorepo yields
 * `single` for that model.
 */
export function detectMode(dir?: string): CliMode {
  const baseDir = path.resolve(dir || process.cwd());
  const workspace = loadWorkspaceConfig(baseDir);
  if (workspace) {
    return { mode: "monorepo", workspace, rootDir: baseDir };
  }
  const project = loadProjectConfig(baseDir);
  if (project) {
    return { mode: "single", project };
  }
  return { mode: "none" };
}

/**
 * Shallow-merge workspace defaults into a model config. `env` is shallow-merged
 * with the model winning on conflicts; `profiling` is replaced wholesale when
 * the model defines its own; any other default key is used only when the model
 * does not already set it.
 */
export function mergeWorkspaceDefaults(
  defaults: WorkspaceDefaults | undefined,
  modelConfig: ProjectConfig
): ProjectConfig {
  if (!defaults) {
    return { ...modelConfig };
  }

  const {
    env: defaultEnv,
    profiling: defaultProfiling,
    ...otherDefaults
  } = defaults;
  const merged: ProjectConfig = { ...modelConfig };

  const mergedRecord = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(otherDefaults)) {
    if (mergedRecord[key] === undefined) {
      mergedRecord[key] = value;
    }
  }

  if (defaultEnv) {
    merged.env = { ...defaultEnv, ...(modelConfig.env ?? {}) };
  }

  if (defaultProfiling && modelConfig.profiling === undefined) {
    merged.profiling = { ...defaultProfiling };
  }

  return merged;
}

function loadMergedModel(
  modelDir: string,
  relPath: string,
  rootDir: string,
  defaults: WorkspaceDefaults | undefined
): DiscoveredModel | null {
  const configPath = findCirronConfigInDir(modelDir);
  if (!configPath) {
    return null;
  }
  const result = loadProjectConfig(modelDir);
  if (!result) {
    return null;
  }
  const config = mergeWorkspaceDefaults(defaults, result.config);
  return {
    name: config.name,
    path: relPath || path.relative(rootDir, modelDir) || ".",
    configPath,
    config,
  };
}

function expandGlobEntry(
  pattern: string,
  rootDir: string,
  defaults: WorkspaceDefaults | undefined
): DiscoveredModel[] {
  const parentRel = path.dirname(pattern);
  const parentDir = path.resolve(rootDir, parentRel);
  if (!(fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory())) {
    return [];
  }
  const found: DiscoveredModel[] = [];
  for (const entry of fs.readdirSync(parentDir).sort()) {
    const childRel = path.posix.join(parentRel === "." ? "" : parentRel, entry);
    if (!minimatch(childRel.replace(/\\/g, "/"), pattern.replace(/\\/g, "/"))) {
      continue;
    }
    const childDir = path.join(parentDir, entry);
    if (!fs.statSync(childDir).isDirectory()) {
      continue;
    }
    const model = loadMergedModel(childDir, childRel, rootDir, defaults);
    if (model) {
      found.push(model);
    }
  }
  return found;
}

/**
 * Resolve every entry in `workspace.models` to a concrete model. Glob entries
 * (containing `*`) expand to immediate subdirectories that contain a cirron
 * config; literal entries that do not point at a directory with a cirron
 * config are reported under `missing`. Duplicate model directories are
 * de-duplicated by their resolved path.
 */
export function discoverModels(
  workspace: WorkspaceConfig,
  rootDir: string
): { resolved: DiscoveredModel[]; missing: string[] } {
  const defaults = workspace.workspace.defaults;
  const resolved: DiscoveredModel[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  const add = (model: DiscoveredModel): void => {
    const key = path.resolve(rootDir, model.path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    resolved.push(model);
  };

  for (const entry of workspace.workspace.models ?? []) {
    const rel = entry.path.replace(/\\/g, "/");
    if (rel.includes("*")) {
      const matches = expandGlobEntry(rel, rootDir, defaults);
      for (const m of matches) {
        add(m);
      }
      continue;
    }
    const cleanRel = rel.replace(/\/+$/, "");
    const modelDir = path.resolve(rootDir, cleanRel);
    if (!(fs.existsSync(modelDir) && fs.statSync(modelDir).isDirectory())) {
      missing.push(entry.path);
      continue;
    }
    const model = loadMergedModel(modelDir, cleanRel, rootDir, defaults);
    if (!model) {
      missing.push(entry.path);
      continue;
    }
    add(model);
  }

  return { resolved, missing };
}

/**
 * Filter discovered models by a list of requested identifiers. Each identifier
 * matches a model's `name` field or its workspace-relative path. Returns the
 * matched models plus any identifiers that matched nothing.
 */
export function filterModels(
  models: DiscoveredModel[],
  names: string[]
): { matched: DiscoveredModel[]; unmatched: string[] } {
  const matched: DiscoveredModel[] = [];
  const matchedKeys = new Set<string>();
  const unmatched: string[] = [];

  for (const name of names) {
    const wanted = name.replace(/\\/g, "/").replace(/\/+$/, "");
    const hits = models.filter(
      (m) => m.name === name || m.path.replace(/\/+$/, "") === wanted
    );
    if (hits.length === 0) {
      unmatched.push(name);
      continue;
    }
    for (const hit of hits) {
      if (!matchedKeys.has(hit.path)) {
        matchedKeys.add(hit.path);
        matched.push(hit);
      }
    }
  }

  return { matched, unmatched };
}
