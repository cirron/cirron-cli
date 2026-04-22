// src/utils/session.ts
//
// Session reconstruction for `cirron traces`. Reads JSON batch files from
// the spool, dedupes spans/marks/snapshots across batches, and groups them
// into logical sessions rooted at each `cirron.session` span.
//
// Shape mirrors cirron_sdk/docs/spool-format.md (schema_version 1). Unknown
// fields are preserved per the forward-compat rule so minor SDK bumps don't
// break the CLI.

import fs from 'fs-extra';
import path from 'path';
import { logger } from './logger';
import {
  listSpoolFiles,
  resolveSnapshotDir,
  type SpoolFile,
} from './spool';

export type SpoolValueKind = 'point' | 'summary';

export interface SpoolSpan {
  id: string;
  parentId: string | null;
  name: string;
  index: number | null;
  startNs: bigint;
  endNs: bigint | null;
  cpuNs: bigint | null;
  gpuNs: bigint | null;
  memoryPeakBytes: bigint | null;
  threadId: bigint | null;
  pid: number | null;
  rank: number;
  attrs: Record<string, unknown>;
  markIds: string[];
}

export interface SpoolMark {
  id: string;
  spanId: string; // may be "root" legacy sentinel
  name: string;
  valueType: string;
  value: unknown;
  attrs: Record<string, unknown>;
  tsNs: bigint;
  kind: SpoolValueKind;
}

export interface SpoolSnapshotStats {
  mean?: number;
  std?: number;
  min?: number;
  max?: number;
  norm?: number;
  histogram?: { bins: number[]; counts: number[] };
  [k: string]: unknown;
}

export interface SpoolSnapshot {
  id: string;
  spanId: string;
  tensorName: string;
  shape: number[];
  dtype: string;
  mode: 'stats' | 'sampled' | 'full';
  stats: SpoolSnapshotStats | null;
  blobUri: string | null;
  tsNs: bigint;
  attrs: Record<string, unknown>;
}

export interface SpoolBatch {
  schemaVersion: number;
  sdkVersion: string;
  batchId: string;
  createdNs: bigint;
  sourceFile: string;
  spans: SpoolSpan[];
  marks: SpoolMark[];
  snapshots: SpoolSnapshot[];
}

export interface Session {
  id: string;
  startedNs: bigint;
  endedNs: bigint | null;
  isLive: boolean;
  root: SpoolSpan;
  spans: Map<string, SpoolSpan>; // includes root
  childrenOf: Map<string, string[]>; // parent_id → ordered child ids
  marks: SpoolMark[];
  snapshots: SpoolSnapshot[];
  batchFiles: string[];
  totalBytes: number;
  sdkVersion: string;
  schemaVersion: number;
}

export interface LoadOptions {
  onError?: 'warn' | 'throw' | 'skip';
}

function toBigIntOrNull(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

function toBigIntOrZero(v: unknown): bigint {
  return toBigIntOrNull(v) ?? 0n;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSpan(raw: Record<string, unknown>): SpoolSpan | null {
  const id = raw['id'];
  const name = raw['name'];
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  const parentRaw = raw['parent_id'];
  return {
    id,
    name,
    parentId: typeof parentRaw === 'string' ? parentRaw : null,
    index: toNumberOrNull(raw['index']),
    startNs: toBigIntOrZero(raw['start_ns']),
    endNs: toBigIntOrNull(raw['end_ns']),
    cpuNs: toBigIntOrNull(raw['cpu_ns']),
    gpuNs: toBigIntOrNull(raw['gpu_ns']),
    memoryPeakBytes: toBigIntOrNull(raw['memory_peak_bytes']),
    threadId: toBigIntOrNull(raw['thread_id']),
    pid: toNumberOrNull(raw['pid']),
    rank: toNumberOrNull(raw['rank']) ?? 0,
    attrs:
      raw['attrs'] && typeof raw['attrs'] === 'object'
        ? (raw['attrs'] as Record<string, unknown>)
        : {},
    markIds: Array.isArray(raw['mark_ids'])
      ? (raw['mark_ids'] as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [],
  };
}

function normalizeMark(raw: Record<string, unknown>): SpoolMark | null {
  const id = raw['id'];
  const spanId = raw['span_id'];
  const name = raw['name'];
  const valueType = raw['value_type'];
  if (
    typeof id !== 'string' ||
    typeof spanId !== 'string' ||
    typeof name !== 'string' ||
    typeof valueType !== 'string'
  ) {
    return null;
  }
  const kindRaw = raw['kind'];
  const kind: SpoolValueKind = kindRaw === 'summary' ? 'summary' : 'point';
  return {
    id,
    spanId,
    name,
    valueType,
    value: raw['value'],
    attrs:
      raw['attrs'] && typeof raw['attrs'] === 'object'
        ? (raw['attrs'] as Record<string, unknown>)
        : {},
    tsNs: toBigIntOrZero(raw['ts_ns']),
    kind,
  };
}

function normalizeSnapshot(raw: Record<string, unknown>): SpoolSnapshot | null {
  const id = raw['id'];
  const spanId = raw['span_id'];
  const tensorName = raw['tensor_name'];
  if (
    typeof id !== 'string' ||
    typeof spanId !== 'string' ||
    typeof tensorName !== 'string'
  ) {
    return null;
  }
  const modeRaw = raw['mode'];
  const mode: SpoolSnapshot['mode'] =
    modeRaw === 'sampled' || modeRaw === 'full' ? modeRaw : 'stats';
  return {
    id,
    spanId,
    tensorName,
    shape: Array.isArray(raw['shape'])
      ? (raw['shape'] as unknown[])
          .map((v) => toNumberOrNull(v))
          .filter((v): v is number => v !== null)
      : [],
    dtype: typeof raw['dtype'] === 'string' ? (raw['dtype'] as string) : '',
    mode,
    stats:
      raw['stats'] && typeof raw['stats'] === 'object'
        ? (raw['stats'] as SpoolSnapshotStats)
        : null,
    blobUri: typeof raw['blob_uri'] === 'string' ? (raw['blob_uri'] as string) : null,
    tsNs: toBigIntOrZero(raw['ts_ns']),
    attrs:
      raw['attrs'] && typeof raw['attrs'] === 'object'
        ? (raw['attrs'] as Record<string, unknown>)
        : {},
  };
}

function parseBatch(file: SpoolFile, raw: unknown): SpoolBatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const spansRaw = Array.isArray(obj['spans']) ? obj['spans'] : [];
  const marksRaw = Array.isArray(obj['marks']) ? obj['marks'] : [];
  const snapshotsRaw = Array.isArray(obj['snapshots']) ? obj['snapshots'] : [];

  const spans: SpoolSpan[] = [];
  for (const s of spansRaw as unknown[]) {
    if (s && typeof s === 'object') {
      const span = normalizeSpan(s as Record<string, unknown>);
      if (span) spans.push(span);
    }
  }
  const marks: SpoolMark[] = [];
  for (const m of marksRaw as unknown[]) {
    if (m && typeof m === 'object') {
      const mark = normalizeMark(m as Record<string, unknown>);
      if (mark) marks.push(mark);
    }
  }
  const snapshots: SpoolSnapshot[] = [];
  for (const s of snapshotsRaw as unknown[]) {
    if (s && typeof s === 'object') {
      const snap = normalizeSnapshot(s as Record<string, unknown>);
      if (snap) snapshots.push(snap);
    }
  }

  return {
    schemaVersion: toNumberOrNull(obj['schema_version']) ?? 1,
    sdkVersion: typeof obj['sdk_version'] === 'string' ? (obj['sdk_version'] as string) : '',
    batchId: typeof obj['batch_id'] === 'string' ? (obj['batch_id'] as string) : '',
    createdNs: toBigIntOrZero(obj['created_ns']) || file.createdNs,
    sourceFile: file.fullPath,
    spans,
    marks,
    snapshots,
  };
}

export async function* readBatches(
  spoolDir: string,
  opts: LoadOptions = {},
): AsyncIterable<SpoolBatch> {
  const onError = opts.onError ?? 'warn';
  const files = await listSpoolFiles(spoolDir);
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file.fullPath, 'utf-8');
    } catch (err) {
      if (onError === 'throw') throw err;
      if (onError === 'warn') {
        logger.warn(
          `Skipping unreadable spool file ${file.name}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (onError === 'throw') throw err;
      if (onError === 'warn') {
        logger.warn(
          `Skipping corrupt spool file ${file.name}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    const batch = parseBatch(file, parsed);
    if (!batch) {
      if (onError === 'throw') throw new Error(`Malformed batch in ${file.name}`);
      if (onError === 'warn') {
        logger.warn(`Skipping malformed batch ${file.name}`);
      }
      continue;
    }
    yield batch;
  }
}

// Merge two span records, preferring the one with end_ns set (complete).
function mergeSpans(a: SpoolSpan, b: SpoolSpan): SpoolSpan {
  if (a.endNs !== null && b.endNs === null) return a;
  if (b.endNs !== null && a.endNs === null) return b;
  // Both closed or both open — prefer newer (b, since we iterate chronologically).
  return b;
}

async function snapshotDirSize(dir: string): Promise<number> {
  if (!(await fs.pathExists(dir))) return 0;
  let total = 0;
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const stat = await fs.stat(path.join(dir, entry));
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

export async function loadSessions(spoolDir: string, opts: LoadOptions = {}): Promise<Session[]> {
  const spansById = new Map<string, SpoolSpan>();
  const marksById = new Map<string, SpoolMark>();
  const snapshotsById = new Map<string, SpoolSnapshot>();
  const spanToBatchFiles = new Map<string, Set<string>>();
  const byteAccum = new Map<string, number>(); // batch file → size
  let sdkVersion = '';
  let schemaVersion = 1;

  for await (const batch of readBatches(spoolDir, opts)) {
    if (batch.sdkVersion) sdkVersion = batch.sdkVersion;
    schemaVersion = batch.schemaVersion;
    // Rough file size tracking (only counted once per file)
    if (!byteAccum.has(batch.sourceFile)) {
      try {
        const stat = await fs.stat(batch.sourceFile);
        byteAccum.set(batch.sourceFile, stat.size);
      } catch {
        byteAccum.set(batch.sourceFile, 0);
      }
    }
    for (const span of batch.spans) {
      const prev = spansById.get(span.id);
      spansById.set(span.id, prev ? mergeSpans(prev, span) : span);
      let files = spanToBatchFiles.get(span.id);
      if (!files) {
        files = new Set();
        spanToBatchFiles.set(span.id, files);
      }
      files.add(batch.sourceFile);
    }
    for (const mark of batch.marks) marksById.set(mark.id, mark);
    for (const snap of batch.snapshots) snapshotsById.set(snap.id, snap);
  }

  // Identify session roots.
  const roots: SpoolSpan[] = [];
  for (const span of spansById.values()) {
    if (span.name === 'cirron.session' && span.parentId === null) {
      roots.push(span);
    }
  }

  // Determine each span's session via parent walk. Orphans (no resolvable
  // root) bucket under a synthetic session only if no real sessions exist.
  const spanSession = new Map<string, string>(); // span id → session id
  const orphanSpanIds: string[] = [];
  for (const span of spansById.values()) {
    let current: SpoolSpan | undefined = span;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) {
        current = undefined;
        break;
      }
      visited.add(current.id);
      if (current.name === 'cirron.session' && current.parentId === null) {
        spanSession.set(span.id, current.id);
        break;
      }
      if (current.parentId === null) {
        current = undefined;
        break;
      }
      current = spansById.get(current.parentId);
    }
    if (!spanSession.has(span.id)) {
      orphanSpanIds.push(span.id);
    }
  }

  const snapshotRoot = resolveSnapshotDir(spoolDir);

  // Build Session objects.
  const sessions: Session[] = [];
  for (const root of roots) {
    const sessionSpans = new Map<string, SpoolSpan>();
    const childrenOf = new Map<string, string[]>();
    const batchFiles = new Set<string>();

    for (const [spanId, sid] of spanSession) {
      if (sid === root.id) {
        const span = spansById.get(spanId);
        if (!span) continue;
        sessionSpans.set(spanId, span);
        if (span.parentId !== null) {
          let arr = childrenOf.get(span.parentId);
          if (!arr) {
            arr = [];
            childrenOf.set(span.parentId, arr);
          }
          arr.push(spanId);
        }
        const files = spanToBatchFiles.get(spanId);
        if (files) for (const f of files) batchFiles.add(f);
      }
    }

    // Sort children by startNs for deterministic rendering.
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => {
        const sa = sessionSpans.get(a)?.startNs ?? 0n;
        const sb = sessionSpans.get(b)?.startNs ?? 0n;
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }

    const sessionSpanIds = new Set(sessionSpans.keys());
    const sessionMarks = [...marksById.values()].filter((m) =>
      sessionSpanIds.has(m.spanId),
    );
    const sessionSnapshots = [...snapshotsById.values()].filter((s) =>
      sessionSpanIds.has(s.spanId),
    );

    let totalBytes = 0;
    for (const f of batchFiles) totalBytes += byteAccum.get(f) ?? 0;
    // Add snapshot dir sizes for spans in this session.
    for (const spanId of sessionSpanIds) {
      totalBytes += await snapshotDirSize(path.join(snapshotRoot, spanId));
    }

    sessions.push({
      id: root.id,
      startedNs: root.startNs,
      endedNs: root.endNs,
      isLive: root.endNs === null,
      root,
      spans: sessionSpans,
      childrenOf,
      marks: sessionMarks,
      snapshots: sessionSnapshots,
      batchFiles: [...batchFiles],
      totalBytes,
      sdkVersion,
      schemaVersion,
    });
  }

  // Orphan bucket — only emit if there are no real sessions. Keeps the
  // common case clean; lets us still render something when a spool was
  // produced before `ci.profile()` opened a root.
  if (sessions.length === 0 && orphanSpanIds.length > 0) {
    const spans = new Map<string, SpoolSpan>();
    const childrenOf = new Map<string, string[]>();
    const batchFiles = new Set<string>();
    let earliest: bigint | null = null;
    for (const spanId of orphanSpanIds) {
      const span = spansById.get(spanId);
      if (!span) continue;
      spans.set(spanId, span);
      if (span.parentId !== null) {
        let arr = childrenOf.get(span.parentId);
        if (!arr) {
          arr = [];
          childrenOf.set(span.parentId, arr);
        }
        arr.push(spanId);
      }
      if (earliest === null || span.startNs < earliest) earliest = span.startNs;
      const files = spanToBatchFiles.get(spanId);
      if (files) for (const f of files) batchFiles.add(f);
    }
    const syntheticRoot: SpoolSpan = {
      id: '_orphans',
      parentId: null,
      name: '(orphan spans)',
      index: null,
      startNs: earliest ?? 0n,
      endNs: null,
      cpuNs: null,
      gpuNs: null,
      memoryPeakBytes: null,
      threadId: null,
      pid: null,
      rank: 0,
      attrs: {},
      markIds: [],
    };
    spans.set(syntheticRoot.id, syntheticRoot);
    // Reparent top-level orphans to the synthetic root.
    const topLevel: string[] = [];
    for (const span of spans.values()) {
      if (span.id === syntheticRoot.id) continue;
      if (span.parentId === null || !spans.has(span.parentId)) {
        topLevel.push(span.id);
      }
    }
    childrenOf.set(syntheticRoot.id, topLevel);

    let totalBytes = 0;
    for (const f of batchFiles) totalBytes += byteAccum.get(f) ?? 0;

    sessions.push({
      id: syntheticRoot.id,
      startedNs: syntheticRoot.startNs,
      endedNs: null,
      isLive: false,
      root: syntheticRoot,
      spans,
      childrenOf,
      marks: [],
      snapshots: [],
      batchFiles: [...batchFiles],
      totalBytes,
      sdkVersion,
      schemaVersion,
    });
  }

  // Newest first.
  sessions.sort((a, b) =>
    a.startedNs > b.startedNs ? -1 : a.startedNs < b.startedNs ? 1 : 0,
  );
  return sessions;
}

export function spanDurationNs(span: SpoolSpan): bigint | null {
  if (span.endNs === null) return null;
  return span.endNs - span.startNs;
}
