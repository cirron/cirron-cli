// src/utils/export/json.ts
//
// Merged + deduped spool JSON. One object containing the union of all
// spans/marks/snapshots across the provided sessions. Output mirrors the
// single-batch spool shape (§spool-format.md) so downstream tools can
// read it with their existing spool parsers.

import fs from 'fs-extra';
import path from 'path';
import type { Session, SpoolMark, SpoolSnapshot, SpoolSpan } from '../session';

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function spanToWire(span: SpoolSpan): Record<string, unknown> {
  return {
    id: span.id,
    name: span.name,
    parent_id: span.parentId,
    index: span.index,
    start_ns: span.startNs.toString(),
    end_ns: span.endNs === null ? null : span.endNs.toString(),
    cpu_ns: span.cpuNs === null ? null : span.cpuNs.toString(),
    gpu_ns: span.gpuNs === null ? null : span.gpuNs.toString(),
    memory_peak_bytes:
      span.memoryPeakBytes === null ? null : span.memoryPeakBytes.toString(),
    thread_id: span.threadId === null ? null : span.threadId.toString(),
    pid: span.pid,
    rank: span.rank,
    attrs: span.attrs,
    mark_ids: span.markIds,
  };
}

function markToWire(mark: SpoolMark): Record<string, unknown> {
  return {
    id: mark.id,
    span_id: mark.spanId,
    name: mark.name,
    value_type: mark.valueType,
    value: mark.value,
    attrs: mark.attrs,
    ts_ns: mark.tsNs.toString(),
    kind: mark.kind,
  };
}

function snapshotToWire(snap: SpoolSnapshot): Record<string, unknown> {
  return {
    id: snap.id,
    span_id: snap.spanId,
    tensor_name: snap.tensorName,
    shape: snap.shape,
    dtype: snap.dtype,
    mode: snap.mode,
    stats: snap.stats,
    blob_uri: snap.blobUri,
    ts_ns: snap.tsNs.toString(),
    attrs: snap.attrs,
  };
}

export async function exportJson(
  sessions: Session[],
  outputPath: string,
): Promise<void> {
  const spans: Record<string, unknown>[] = [];
  const marks: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const seenSpans = new Set<string>();
  const seenMarks = new Set<string>();
  const seenSnapshots = new Set<string>();

  let sdkVersion = '';
  let schemaVersion = 1;

  for (const session of sessions) {
    if (session.sdkVersion) sdkVersion = session.sdkVersion;
    if (session.schemaVersion) schemaVersion = session.schemaVersion;
    for (const span of session.spans.values()) {
      if (seenSpans.has(span.id)) continue;
      seenSpans.add(span.id);
      spans.push(spanToWire(span));
    }
    for (const mark of session.marks) {
      if (seenMarks.has(mark.id)) continue;
      seenMarks.add(mark.id);
      marks.push(markToWire(mark));
    }
    for (const snap of session.snapshots) {
      if (seenSnapshots.has(snap.id)) continue;
      seenSnapshots.add(snap.id);
      snapshots.push(snapshotToWire(snap));
    }
  }

  const body = {
    schema_version: schemaVersion,
    sdk_version: sdkVersion,
    spans,
    marks,
    snapshots,
  };

  await fs.ensureDir(path.dirname(path.resolve(outputPath)));
  await fs.writeFile(outputPath, JSON.stringify(body, replacer, 2), 'utf-8');
}
