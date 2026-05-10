import fs from "fs";
import os from "os";
import path from "path";

export type VenvSource =
  | "VIRTUAL_ENV"
  | "CONDA_PREFIX"
  | ".venv"
  | "venv"
  | "override";

export interface PythonEnv {
  pythonExecutable: string | null;
  pythonVersion: string | null;
  root: string;
  sitePackages: string;
  source: VenvSource;
}

export interface PythonEnvMissing {
  checked: string[];
  reason: string;
  root: null;
}

/**
 * Locate a Python environment to inspect. Resolution order:
 *   override (if supplied) -> $VIRTUAL_ENV -> $CONDA_PREFIX -> ./.venv -> ./venv
 */
export function discoverPythonEnv(
  override: string | undefined,
  cwd: string = process.cwd()
): PythonEnv | PythonEnvMissing {
  const checked: string[] = [];
  const candidates: Array<{ root: string; source: VenvSource }> = [];

  if (override) {
    candidates.push({ root: path.resolve(override), source: "override" });
  } else {
    if (process.env["VIRTUAL_ENV"]) {
      candidates.push({
        root: process.env["VIRTUAL_ENV"],
        source: "VIRTUAL_ENV",
      });
    }
    if (process.env["CONDA_PREFIX"]) {
      candidates.push({
        root: process.env["CONDA_PREFIX"],
        source: "CONDA_PREFIX",
      });
    }
    candidates.push({ root: path.join(cwd, ".venv"), source: ".venv" });
    candidates.push({ root: path.join(cwd, "venv"), source: "venv" });
  }

  for (const cand of candidates) {
    checked.push(cand.root);
    const sitePackages = resolveSitePackages(cand.root);
    if (sitePackages) {
      const cfg = readPyvenvCfg(cand.root);
      return {
        root: cand.root,
        sitePackages,
        pythonVersion: cfg.version,
        pythonExecutable: cfg.executable,
        source: cand.source,
      };
    }
  }

  return {
    root: null,
    reason: override
      ? `no site-packages directory under ${override}`
      : "no virtual environment detected",
    checked,
  };
}

/**
 * Find site-packages under a venv root.
 *   POSIX  : {root}/lib/pythonX.Y/site-packages
 *   Windows: {root}/Lib/site-packages
 */
function resolveSitePackages(root: string): string | null {
  if (!fs.existsSync(root)) {
    return null;
  }

  if (os.platform() === "win32") {
    const winPath = path.join(root, "Lib", "site-packages");
    return fs.existsSync(winPath) ? winPath : null;
  }

  const libDir = path.join(root, "lib");
  if (!fs.existsSync(libDir)) {
    return null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(libDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith("python")) {
      const candidate = path.join(libDir, entry, "site-packages");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

interface PyvenvCfg {
  executable: string | null;
  version: string | null;
}

/** Parse pyvenv.cfg at the root of a venv. */
function readPyvenvCfg(root: string): PyvenvCfg {
  const cfgPath = path.join(root, "pyvenv.cfg");
  const result: PyvenvCfg = { version: null, executable: null };
  if (!fs.existsSync(cfgPath)) {
    return result;
  }
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "version" || key === "version_info") {
      result.version = value;
    } else if (
      (key === "executable" || key === "base-executable") &&
      !result.executable
    ) {
      result.executable = value;
    }
  }
  return result;
}
