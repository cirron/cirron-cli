// src/utils/spool.ts
//
// Shared spool-directory helpers consumed by both `cirron spool` (SDK-18)
// and `cirron traces` (SDK-51). The spool format is documented public API
// — see `cirron_sdk/docs/spool-format.md`.

import fs from "fs-extra";
import path from "path";

export const SPOOL_FILENAME_RE = /^(\d+)-[0-9a-f]+\.json$/;
export const DEFAULT_SPOOL_SUBPATH = path.join(".cirron", "spool");
export const DEFAULT_SNAPSHOT_SUBPATH = path.join(".cirron", "snapshots");

export interface SpoolFile {
  createdNs: bigint;
  fullPath: string;
  name: string;
  size: number;
}

export function resolveSpoolDir(dir: string | undefined): string {
  return path.resolve(dir ?? path.join(process.cwd(), DEFAULT_SPOOL_SUBPATH));
}

export function resolveSnapshotDir(spoolDir: string): string {
  // Snapshot dir is a sibling of the spool dir under .cirron/
  return path.resolve(path.dirname(spoolDir), "snapshots");
}

export async function listSpoolFiles(spoolDir: string): Promise<SpoolFile[]> {
  if (!(await fs.pathExists(spoolDir))) {
    return [];
  }
  const entries = await fs.readdir(spoolDir);
  const files = (
    await Promise.all(
      entries.map(async (name): Promise<SpoolFile | null> => {
        const match = name.match(SPOOL_FILENAME_RE);
        if (!match) {
          return null;
        }
        const fullPath = path.join(spoolDir, name);
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          name,
          fullPath,
          createdNs: BigInt(match[1]!),
          size: stat.size,
        };
      })
    )
  ).filter((f): f is SpoolFile => f !== null);
  files.sort((a, b) =>
    a.createdNs < b.createdNs ? -1 : a.createdNs > b.createdNs ? 1 : 0
  );
  return files;
}

export function humanBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export function nsToIso(ns: bigint): string {
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

const DURATION_UNITS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

// Parse "1ms", "500us", "2.5s", "100ns" into nanoseconds. Returns null on
// malformed input so callers can surface a usage error.
export function parseDurationNs(s: string): bigint | null {
  const m = s.match(/^\s*(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|m|h)\s*$/);
  if (!m) {
    return null;
  }
  const scale = DURATION_UNITS[m[2]!];
  if (scale === undefined) {
    return null;
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  // Multiply in floating-point to preserve fractional values, then floor.
  return BigInt(Math.floor(num * Number(scale)));
}

// Format a nanosecond duration as a compact human string (e.g. "42.1ms").
export function formatDurationNs(ns: bigint | null | undefined): string {
  if (ns === null || ns === undefined) {
    return "—";
  }
  const n = Number(ns);
  if (n < 1000) {
    return `${n}ns`;
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}us`;
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(1)}ms`;
  }
  if (n < 60_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}s`;
  }
  const minutes = Math.floor(n / 60_000_000_000);
  const seconds = (n % 60_000_000_000) / 1_000_000_000;
  return `${minutes}m${seconds.toFixed(1)}s`;
}
