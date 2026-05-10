// src/utils/export/parquet.ts
//
// Parquet writer for `cirron traces export --format parquet`. Emits three
// files (spans.parquet, marks.parquet, snapshots.parquet) into the output
// directory. Schemas mirror the platform Prisma models (TraceSpan,
// TraceMark, TraceSnapshot) so DuckDB / pandas / Polars users can query
// them with the same mental model as the platform.
//
// Uses `@dsnp/parquetjs` (pure JS) so the `pkg`-built binaries keep
// working without native modules.

import path from "node:path";
import fs from "fs-extra";
import type { Session, SpoolMark, SpoolSnapshot, SpoolSpan } from "../session";

// Resolved lazily so missing dep only trips users who ask for parquet.
interface ParquetSchemaCtor {
  new (schema: Record<string, unknown>): unknown;
}
interface ParquetWriterStatic {
  openFile(
    schema: unknown,
    path: string
  ): Promise<{
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }>;
}
interface ParquetModule {
  ParquetSchema: ParquetSchemaCtor;
  ParquetWriter: ParquetWriterStatic;
}

async function loadParquet(): Promise<ParquetModule> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@dsnp/parquetjs") as ParquetModule;
    return mod;
  } catch (err) {
    throw new Error(
      `Parquet export requires @dsnp/parquetjs. Reinstall the CLI or run: npm install @dsnp/parquetjs. Underlying error: ${(err as Error).message}`
    );
  }
}

const SPAN_SCHEMA = {
  id: { type: "UTF8" },
  session_id: { type: "UTF8" },
  parent_id: { type: "UTF8", optional: true },
  name: { type: "UTF8" },
  index: { type: "INT32", optional: true },
  start_ns: { type: "INT64" },
  end_ns: { type: "INT64", optional: true },
  duration_ns: { type: "INT64", optional: true },
  cpu_ns: { type: "INT64", optional: true },
  gpu_ns: { type: "INT64", optional: true },
  memory_peak_bytes: { type: "INT64", optional: true },
  thread_id: { type: "INT64", optional: true },
  pid: { type: "INT32", optional: true },
  rank: { type: "INT32" },
  attrs_json: { type: "UTF8" },
};

const MARK_SCHEMA = {
  id: { type: "UTF8" },
  span_id: { type: "UTF8" },
  session_id: { type: "UTF8" },
  name: { type: "UTF8" },
  value_type: { type: "UTF8" },
  value_float: { type: "DOUBLE", optional: true },
  value_int: { type: "INT64", optional: true },
  value_string: { type: "UTF8", optional: true },
  value_bool: { type: "BOOLEAN", optional: true },
  ts_ns: { type: "INT64" },
  kind: { type: "UTF8" },
  attrs_json: { type: "UTF8" },
};

const SNAPSHOT_SCHEMA = {
  id: { type: "UTF8" },
  span_id: { type: "UTF8" },
  session_id: { type: "UTF8" },
  tensor_name: { type: "UTF8" },
  dtype: { type: "UTF8" },
  shape_json: { type: "UTF8" },
  mode: { type: "UTF8" },
  stats_json: { type: "UTF8", optional: true },
  blob_uri: { type: "UTF8", optional: true },
  ts_ns: { type: "INT64" },
};

function spanRow(span: SpoolSpan, sessionId: string): Record<string, unknown> {
  const duration = span.endNs === null ? null : span.endNs - span.startNs;
  return {
    id: span.id,
    session_id: sessionId,
    parent_id: span.parentId ?? undefined,
    name: span.name,
    index: span.index ?? undefined,
    start_ns: span.startNs,
    end_ns: span.endNs ?? undefined,
    duration_ns: duration ?? undefined,
    cpu_ns: span.cpuNs ?? undefined,
    gpu_ns: span.gpuNs ?? undefined,
    memory_peak_bytes: span.memoryPeakBytes ?? undefined,
    thread_id: span.threadId ?? undefined,
    pid: span.pid ?? undefined,
    rank: span.rank,
    attrs_json: JSON.stringify(span.attrs ?? {}),
  };
}

function markRow(mark: SpoolMark, sessionId: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: mark.id,
    span_id: mark.spanId,
    session_id: sessionId,
    name: mark.name,
    value_type: mark.valueType,
    ts_ns: mark.tsNs,
    kind: mark.kind,
    attrs_json: JSON.stringify(mark.attrs ?? {}),
  };
  const v = mark.value;
  if (typeof v === "number") {
    if (mark.valueType === "int" && Number.isInteger(v)) {
      row["value_int"] = BigInt(v);
    } else {
      row["value_float"] = v;
    }
  } else if (typeof v === "bigint") {
    row["value_int"] = v;
  } else if (typeof v === "boolean") {
    row["value_bool"] = v;
  } else if (typeof v === "string") {
    row["value_string"] = v;
  } else if (v !== null && v !== undefined) {
    row["value_string"] = JSON.stringify(v);
  }
  return row;
}

function snapshotRow(
  snap: SpoolSnapshot,
  sessionId: string
): Record<string, unknown> {
  return {
    id: snap.id,
    span_id: snap.spanId,
    session_id: sessionId,
    tensor_name: snap.tensorName,
    dtype: snap.dtype,
    shape_json: JSON.stringify(snap.shape ?? []),
    mode: snap.mode,
    stats_json: snap.stats ? JSON.stringify(snap.stats) : undefined,
    blob_uri: snap.blobUri ?? undefined,
    ts_ns: snap.tsNs,
  };
}

export async function exportParquet(
  sessions: Session[],
  outputDir: string
): Promise<{ spans: number; marks: number; snapshots: number }> {
  const parquet = await loadParquet();
  await fs.ensureDir(path.resolve(outputDir));

  const spanSchema = new parquet.ParquetSchema(SPAN_SCHEMA);
  const markSchema = new parquet.ParquetSchema(MARK_SCHEMA);
  const snapshotSchema = new parquet.ParquetSchema(SNAPSHOT_SCHEMA);

  const spanWriter = await parquet.ParquetWriter.openFile(
    spanSchema,
    path.join(outputDir, "spans.parquet")
  );
  const markWriter = await parquet.ParquetWriter.openFile(
    markSchema,
    path.join(outputDir, "marks.parquet")
  );
  const snapshotWriter = await parquet.ParquetWriter.openFile(
    snapshotSchema,
    path.join(outputDir, "snapshots.parquet")
  );

  const counts = { spans: 0, marks: 0, snapshots: 0 };
  const seenSpans = new Set<string>();
  const seenMarks = new Set<string>();
  const seenSnapshots = new Set<string>();

  try {
    for (const session of sessions) {
      for (const span of session.spans.values()) {
        if (seenSpans.has(span.id)) {
          continue;
        }
        seenSpans.add(span.id);
        await spanWriter.appendRow(spanRow(span, session.id));
        counts.spans++;
      }
      for (const mark of session.marks) {
        if (seenMarks.has(mark.id)) {
          continue;
        }
        seenMarks.add(mark.id);
        await markWriter.appendRow(markRow(mark, session.id));
        counts.marks++;
      }
      for (const snap of session.snapshots) {
        if (seenSnapshots.has(snap.id)) {
          continue;
        }
        seenSnapshots.add(snap.id);
        await snapshotWriter.appendRow(snapshotRow(snap, session.id));
        counts.snapshots++;
      }
    }
  } finally {
    await spanWriter.close();
    await markWriter.close();
    await snapshotWriter.close();
  }

  return counts;
}
