// `cirron traces {view,list,export,clear}`.
//
// Reads the local spool (`.cirron/spool/*.json`) + snapshots
// (`.cirron/snapshots/<span_id>/*.safetensors`). Never talks to the
// platform. Remote/run-scoped reads are not yet supported.

import path from "node:path";
import chalk, { Chalk } from "chalk";
import Table from "cli-table3";
import fs from "fs-extra";
import inquirer from "inquirer";
import { exportCsv } from "../utils/export/csv";
import { exportJson } from "../utils/export/json";
import { exportOtlp } from "../utils/export/otlp";
import { exportParquet } from "../utils/export/parquet";
import { logger } from "../utils/logger";
import {
  type RenderOptions,
  renderSessionTree,
  shouldColor,
} from "../utils/render";
import {
  readSafetensorsInfo,
  readSafetensorsTensor,
  type SafetensorsFileInfo,
  safetensorsFileExists,
  tensorPreview,
  writeSingleTensorSafetensors,
} from "../utils/safetensors";
import {
  loadSessions,
  type Session,
  type SpoolSnapshot,
  spanDurationNs,
} from "../utils/session";
import {
  formatDurationNs,
  humanBytes,
  nsToIso,
  parseDurationNs,
  resolveSnapshotDir,
  resolveSpoolDir,
} from "../utils/spool";

interface ViewOptions {
  depth?: string;
  json?: boolean;
  last?: string;
  minWall?: string;
  name?: string;
  noColor?: boolean;
  session?: string;
  spool?: string;
}

interface ListOptions {
  json?: boolean;
  spool?: string;
}

interface ExportOptions {
  format: string;
  output?: string;
  session?: string;
  spool?: string;
}

interface ClearOptions {
  before?: string;
  keep?: string;
  pruneOrphans?: boolean;
  spool?: string;
  yes?: boolean;
}

interface SnapshotsListOptions {
  json?: boolean;
  session?: string;
  span?: string;
  spool?: string;
}

interface SnapshotDetailOptions {
  export?: string;
  file?: string; // override blob path (weights vs gradients)
  json?: boolean;
  noColor?: boolean;
  preview?: string;
  spool?: string;
  tail?: string;
}

function parseIntArg(s: string | undefined, fallback: number): number {
  if (!s) {
    return fallback;
  }
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer: ${s}`);
  }
  return n;
}

function noTracesFound(): void {
  logger.info(
    chalk.yellow(
      "No traces found. Run ci.profile() from Python to produce some."
    )
  );
}

// view

/** Entry point for `cirron traces view`: text flamegraph of a local session. */
export async function tracesViewCommand(options: ViewOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  const useColor = shouldColor(process.stdout, options.noColor);
  const maxDepth = options.depth
    ? parseIntArg(options.depth, Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;

  let minWallNs = 0n;
  if (options.minWall) {
    const parsed = parseDurationNs(options.minWall);
    if (parsed === null) {
      logger.error(
        `Invalid --min-wall: ${options.minWall} (try 1ms, 500us, 2s, 100ns)`
      );
      process.exitCode = 2;
      return;
    }
    minWallNs = parsed;
  }

  let selected: Session[];
  if (options.session) {
    const match = sessions.find(
      (s) => s.id === options.session || s.id.startsWith(options.session!)
    );
    if (!match) {
      logger.error(`No session found matching ${options.session}`);
      process.exitCode = 1;
      return;
    }
    selected = [match];
  } else {
    const last = parseIntArg(options.last, 1);
    selected = sessions.slice(0, last);
  }

  if (options.json) {
    const out = selected.map((session) => sessionToJsonTree(session));
    logger.json(out.length === 1 ? out[0] : out);
    return;
  }

  const renderOpts: RenderOptions = {
    maxDepth,
    minWallNs,
    useColor,
  };
  if (options.name !== undefined) {
    renderOpts.nameFilter = options.name;
  }

  const blocks: string[] = [];
  for (const session of selected) {
    blocks.push(renderSessionTree(session, renderOpts));
  }
  console.log(blocks.join("\n\n"));
}

function sessionToJsonTree(session: Session): unknown {
  const build = (spanId: string): unknown => {
    const span = session.spans.get(spanId);
    if (!span) {
      return null;
    }
    const dur = spanDurationNs(span);
    const children = (session.childrenOf.get(spanId) ?? []).map(build);
    const marks = session.marks
      .filter((m) => m.spanId === spanId)
      .map((m) => ({
        name: m.name,
        value: m.value,
        value_type: m.valueType,
        kind: m.kind,
        ts_ns: m.tsNs.toString(),
      }));
    return {
      id: span.id,
      name: span.name,
      index: span.index,
      start_ns: span.startNs.toString(),
      end_ns: span.endNs === null ? null : span.endNs.toString(),
      duration_ns: dur === null ? null : dur.toString(),
      pid: span.pid,
      rank: span.rank,
      attrs: span.attrs,
      marks,
      children,
    };
  };
  return {
    session_id: session.id,
    sdk_version: session.sdkVersion,
    started_ns: session.startedNs.toString(),
    ended_ns: session.endedNs === null ? null : session.endedNs.toString(),
    live: session.isLive,
    tree: build(session.root.id),
  };
}

// list

/** Entry point for `cirron traces list`: list reconstructed local sessions. */
export async function tracesListCommand(options: ListOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    if (options.json) {
      logger.json({ dir: spoolDir, sessions: [] });
    } else {
      noTracesFound();
    }
    return;
  }

  if (options.json) {
    logger.json({
      dir: spoolDir,
      sessions: sessions.map((s) => ({
        id: s.id,
        started_ns: s.startedNs.toString(),
        ended_ns: s.endedNs === null ? null : s.endedNs.toString(),
        live: s.isLive,
        spans: s.spans.size,
        marks: s.marks.length,
        snapshots: s.snapshots.length,
        bytes: s.totalBytes,
        sdk_version: s.sdkVersion,
      })),
    });
    return;
  }

  logger.info(
    `${chalk.bold("Spool:")} ${spoolDir}  ${chalk.gray(`(${sessions.length} session${sessions.length === 1 ? "" : "s"})`)}`
  );

  const table = new Table({
    head: [
      chalk.cyan("SESSION"),
      chalk.cyan("STARTED"),
      chalk.cyan("DURATION"),
      chalk.cyan("SPANS"),
      chalk.cyan("MARKS"),
      chalk.cyan("SNAPSHOTS"),
      chalk.cyan("SIZE"),
    ],
    colAligns: ["left", "left", "right", "right", "right", "right", "right"],
  });

  for (const s of sessions) {
    const dur =
      s.endedNs === null
        ? chalk.magenta("(live)")
        : formatDurationNs(s.endedNs - s.startedNs);
    table.push([
      `${s.id.slice(0, 8)}…`,
      nsToIso(s.startedNs),
      dur,
      String(s.spans.size),
      String(s.marks.length),
      String(s.snapshots.length),
      humanBytes(s.totalBytes),
    ]);
  }
  console.log(table.toString());
}

// export

/** Entry point for `cirron traces export`: write sessions as Parquet, OTLP, CSV or JSON. */
export async function tracesExportCommand(
  options: ExportOptions
): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  let selected = sessions;
  if (options.session) {
    const match = sessions.find(
      (s) => s.id === options.session || s.id.startsWith(options.session!)
    );
    if (!match) {
      logger.error(`No session found matching ${options.session}`);
      process.exitCode = 1;
      return;
    }
    selected = [match];
  }

  const format = options.format.toLowerCase();
  const output = options.output;

  try {
    if (format === "parquet") {
      const outDir = output ?? "./cirron-traces";
      const counts = await exportParquet(selected, outDir);
      logger.success(
        `Wrote ${counts.spans} spans, ${counts.marks} marks, ${counts.snapshots} snapshots to ${outDir}`
      );
    } else if (format === "json") {
      const outFile = output ?? "./cirron-traces.json";
      await exportJson(selected, outFile);
      logger.success(`Wrote merged JSON to ${outFile}`);
    } else if (format === "csv") {
      const outFile = output ?? "./cirron-traces.csv";
      await exportCsv(selected, outFile);
      logger.success(`Wrote spans CSV to ${outFile}`);
    } else if (format === "otel" || format === "otlp") {
      const outFile = output ?? "./cirron-traces.otlp.json";
      await exportOtlp(selected, outFile);
      logger.success(`Wrote OTLP JSON to ${outFile}`);
    } else {
      logger.error(
        `Unknown --format: ${options.format}. Supported: parquet, otel, csv, json.`
      );
      process.exitCode = 2;
    }
  } catch (err) {
    logger.error(`Export failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// clear

/** Entry point for `cirron traces clear`: delete local sessions and their snapshot directories. */
export async function tracesClearCommand(options: ClearOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const snapshotDir = resolveSnapshotDir(spoolDir);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    logger.info(chalk.yellow(`No traces to clear in ${spoolDir}`));
    return;
  }

  // Determine which sessions are eligible for deletion.
  let eligible = sessions.filter((s) => !s.isLive);
  if (options.before) {
    const cutoffMs = Date.parse(options.before);
    if (Number.isNaN(cutoffMs)) {
      logger.error(
        `Invalid --before date: ${options.before} (expected ISO-8601)`
      );
      process.exitCode = 2;
      return;
    }
    const cutoffNs = BigInt(cutoffMs) * 1_000_000n;
    eligible = eligible.filter((s) => s.startedNs < cutoffNs);
  }
  if (options.keep) {
    const keep = parseIntArg(options.keep, 0);
    // `sessions` is newest-first. Never delete a live session.
    const nonLiveNewestFirst = sessions.filter((s) => !s.isLive);
    const toKeep = new Set(nonLiveNewestFirst.slice(0, keep).map((s) => s.id));
    eligible = eligible.filter((s) => !toKeep.has(s.id));
  }

  if (eligible.length === 0) {
    logger.info(chalk.yellow("Nothing to delete."));
    return;
  }

  // Stage the delete list before touching disk.
  const batchFiles = new Set<string>();
  const spanIds = new Set<string>();
  let totalBytes = 0;
  let spanCount = 0;
  for (const s of eligible) {
    for (const f of s.batchFiles) {
      batchFiles.add(f);
    }
    for (const id of s.spans.keys()) {
      spanIds.add(id);
      spanCount++;
    }
    totalBytes += s.totalBytes;
  }

  // Snapshot dirs to remove: those whose span is being deleted, plus — under
  // --prune-orphans (default on) — any span no surviving session references.
  const survivingSpanIds = new Set<string>();
  for (const s of sessions) {
    if (eligible.includes(s)) {
      continue;
    }
    for (const id of s.spans.keys()) {
      survivingSpanIds.add(id);
    }
  }

  const snapshotDirsToDelete: string[] = [];
  if (await fs.pathExists(snapshotDir)) {
    const entries = await fs.readdir(snapshotDir);
    for (const entry of entries) {
      const full = path.join(snapshotDir, entry);
      const stat = await fs.stat(full);
      if (!stat.isDirectory()) {
        continue;
      }
      if (spanIds.has(entry)) {
        snapshotDirsToDelete.push(full);
      } else if (
        (options.pruneOrphans ?? true) &&
        !survivingSpanIds.has(entry)
      ) {
        snapshotDirsToDelete.push(full);
      }
    }
  }

  if (!options.yes) {
    const prompt = `Delete ${chalk.cyan(eligible.length)} session${eligible.length === 1 ? "" : "s"} (${spanCount.toLocaleString()} spans, ${humanBytes(totalBytes)}, ${snapshotDirsToDelete.length} snapshot dir${snapshotDirsToDelete.length === 1 ? "" : "s"})?`;
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      { type: "confirm", name: "confirm", message: prompt, default: false },
    ]);
    if (!confirm) {
      logger.info("Cancelled.");
      return;
    }
  }

  // Guard against partial deletes on Ctrl-C: set up a handler that aborts
  // before we touch disk, clears it once we're done.
  let interrupted = false;
  const sigintHandler = () => {
    interrupted = true;
  };
  process.on("SIGINT", sigintHandler);

  let deletedFiles = 0;
  let deletedDirs = 0;
  try {
    for (const file of batchFiles) {
      if (interrupted) {
        break;
      }
      try {
        await fs.unlink(file);
        deletedFiles++;
      } catch (err) {
        logger.error(`Failed to delete ${file}: ${(err as Error).message}`);
      }
    }
    for (const dir of snapshotDirsToDelete) {
      if (interrupted) {
        break;
      }
      try {
        await fs.remove(dir);
        deletedDirs++;
      } catch (err) {
        logger.error(`Failed to delete ${dir}: ${(err as Error).message}`);
      }
    }
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  if (interrupted) {
    logger.warn(
      `Interrupted. Deleted ${deletedFiles} batch file(s) and ${deletedDirs} snapshot dir(s) before exit.`
    );
    process.exitCode = 130;
    return;
  }

  logger.success(
    `Deleted ${deletedFiles} batch file${deletedFiles === 1 ? "" : "s"}` +
      (deletedDirs
        ? ` and ${deletedDirs} snapshot dir${deletedDirs === 1 ? "" : "s"}`
        : "") +
      "."
  );
}

// snapshots (list) + snapshot (detail)

const HISTOGRAM_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function findSession(
  sessions: Session[],
  idOrPrefix: string
): Session | undefined {
  return sessions.find(
    (s) => s.id === idOrPrefix || s.id.startsWith(idOrPrefix)
  );
}

function findSnapshotSpan(
  sessions: Session[],
  spanId: string
): { session: Session; snapshots: SpoolSnapshot[] } | undefined {
  for (const session of sessions) {
    const snaps = session.snapshots.filter(
      (s) => s.spanId === spanId || s.spanId.startsWith(spanId)
    );
    if (snaps.length > 0) {
      return { session, snapshots: snaps };
    }
  }
  return;
}

function renderHistogram(
  bins: number[],
  counts: number[],
  width: number
): string {
  const max = counts.reduce((a, b) => (b > a ? b : a), 0);
  if (max <= 0) {
    return "(empty)";
  }
  const bars = counts
    .map((c) => {
      const frac = c / max;
      const idx = Math.min(
        HISTOGRAM_BLOCKS.length - 1,
        Math.max(0, Math.round(frac * (HISTOGRAM_BLOCKS.length - 1)))
      );
      return HISTOGRAM_BLOCKS[idx];
    })
    .join("");
  const rangeLo = bins[0]?.toExponential(2) ?? "?";
  const rangeHi = bins[bins.length - 1]?.toExponential(2) ?? "?";
  void width; // reserved for future wider renderings
  return `${bars}  [${rangeLo} … ${rangeHi}]  max_bucket=${max}`;
}

function formatStat(v: unknown): string {
  if (typeof v !== "number") {
    return "—";
  }
  if (!Number.isFinite(v)) {
    return String(v);
  }
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) {
    return v.toExponential(4);
  }
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Entry point for `cirron traces snapshots`: list tensor snapshots for a span. */
export async function tracesSnapshotsCommand(
  spanArg: string | undefined,
  options: SnapshotsListOptions
): Promise<void> {
  // Treat a bare positional (`cirron traces snapshots <span>`) as sugar for
  // `--span <span>` — less surprising than commander's "too many arguments".
  const spanFilter = options.span ?? spanArg;
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  let targets = sessions;
  if (options.session) {
    const match = findSession(sessions, options.session);
    if (!match) {
      logger.error(`No session found matching ${options.session}`);
      process.exitCode = 1;
      return;
    }
    targets = [match];
  }

  // Group by span for display. Span name comes from the session's span map.
  interface Row {
    count: number;
    modes: Set<string>;
    sessionId: string;
    spanId: string;
    spanName: string;
    withBlob: number;
  }
  const rows: Row[] = [];
  for (const session of targets) {
    const bySpan = new Map<string, Row>();
    for (const snap of session.snapshots) {
      if (spanFilter && !snap.spanId.startsWith(spanFilter)) {
        continue;
      }
      let row = bySpan.get(snap.spanId);
      if (!row) {
        const span = session.spans.get(snap.spanId);
        row = {
          sessionId: session.id,
          spanId: snap.spanId,
          spanName: span
            ? span.name + (span.index === null ? "" : `[${span.index}]`)
            : "(unknown)",
          count: 0,
          modes: new Set(),
          withBlob: 0,
        };
        bySpan.set(snap.spanId, row);
      }
      row.count++;
      row.modes.add(snap.mode);
      if (snap.blobUri) {
        row.withBlob++;
      }
    }
    rows.push(...bySpan.values());
  }

  if (rows.length === 0) {
    if (options.json) {
      logger.json({ dir: spoolDir, snapshots: [] });
    } else {
      logger.info(chalk.yellow("No snapshots found."));
    }
    return;
  }

  if (options.json) {
    logger.json({
      dir: spoolDir,
      snapshots: rows.map((r) => ({
        session_id: r.sessionId,
        span_id: r.spanId,
        span_name: r.spanName,
        tensor_count: r.count,
        modes: [...r.modes],
        with_blob: r.withBlob,
      })),
    });
    return;
  }

  logger.info(
    `${chalk.bold("Spool:")} ${spoolDir}  ${chalk.gray(`(${rows.length} span${rows.length === 1 ? "" : "s"} with snapshots)`)}`
  );
  const table = new Table({
    head: [
      chalk.cyan("SESSION"),
      chalk.cyan("SPAN"),
      chalk.cyan("NAME"),
      chalk.cyan("TENSORS"),
      chalk.cyan("MODES"),
      chalk.cyan("WITH BLOB"),
    ],
    colAligns: ["left", "left", "left", "right", "left", "right"],
  });
  for (const r of rows) {
    table.push([
      `${r.sessionId.slice(0, 8)}…`,
      `${r.spanId.slice(0, 8)}…`,
      r.spanName,
      String(r.count),
      [...r.modes].join(","),
      String(r.withBlob),
    ]);
  }
  console.log(table.toString());
}

/** Entry point for `cirron traces snapshot`: inspect or export one span's tensor snapshots. */
export async function tracesSnapshotCommand(
  spanIdArg: string,
  tensorNameArg: string | undefined,
  options: SnapshotDetailOptions
): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);
  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  const match = findSnapshotSpan(sessions, spanIdArg);
  if (!match) {
    logger.error(`No snapshots found for span ${spanIdArg}`);
    process.exitCode = 1;
    return;
  }

  const span = match.session.spans.get(match.snapshots[0]!.spanId);
  const fullSpanId = match.snapshots[0]!.spanId;
  const useColor = shouldColor(process.stdout, options.noColor);
  // Scoped Chalk so --no-color reaches every path here; level 0 passes
  // strings through untouched.
  const c = new Chalk({ level: useColor ? 3 : 0 });

  // Figure out which safetensors files live under this span.
  const snapshotDir = resolveSnapshotDir(spoolDir);
  const spanDir = path.join(snapshotDir, fullSpanId);
  const candidateBlobs: { kind: string; path: string }[] = [];
  if (options.file) {
    candidateBlobs.push({
      kind: path.basename(options.file),
      path: options.file,
    });
  } else {
    for (const fname of ["weights.safetensors", "gradients.safetensors"]) {
      const full = path.join(spanDir, fname);
      if (safetensorsFileExists(full)) {
        candidateBlobs.push({
          kind: fname.replace(".safetensors", ""),
          path: full,
        });
      }
    }
  }

  // If a specific tensor was requested, try to locate it across blobs.
  const targetTensor = tensorNameArg;

  if (options.export && !targetTensor) {
    if (candidateBlobs.length === 0) {
      logger.error(
        `No safetensors blobs found under ${spanDir}. Nothing to export.`
      );
      process.exitCode = 1;
      return;
    }

    const destInput = path.resolve(options.export);
    // What's on disk wins; otherwise a .safetensors suffix, or a lone blob
    // going to an extensionless path, means file. Anything else is a dir.
    let destIsDir: boolean;
    try {
      const stat = await fs.stat(destInput);
      destIsDir = stat.isDirectory();
    } catch {
      if (destInput.toLowerCase().endsWith(".safetensors")) {
        destIsDir = false;
      } else if (
        candidateBlobs.length === 1 &&
        path.extname(destInput) === ""
      ) {
        destIsDir = false;
      } else {
        destIsDir = true;
      }
    }

    if (destIsDir) {
      await fs.ensureDir(destInput);
      for (const blob of candidateBlobs) {
        const destFile = path.join(destInput, path.basename(blob.path));
        await fs.copy(blob.path, destFile, { overwrite: true });
      }
      logger.success(
        `Copied ${candidateBlobs.length} safetensors blob${candidateBlobs.length === 1 ? "" : "s"} to ${destInput}`
      );
    } else {
      if (candidateBlobs.length !== 1) {
        logger.error(
          `Destination ${destInput} is a single file but ${candidateBlobs.length} blobs were found (${candidateBlobs.map((b) => b.kind).join(", ")}). Pass a directory, or narrow the selection with --file.`
        );
        process.exitCode = 2;
        return;
      }
      await fs.ensureDir(path.dirname(destInput));
      await fs.copy(candidateBlobs[0]!.path, destInput, { overwrite: true });
      logger.success(`Copied ${candidateBlobs[0]!.path} → ${destInput}`);
    }
    return;
  }

  // Render span header
  const headerLines: string[] = [];
  headerLines.push(`${c.bold("Span")}     ${fullSpanId}`);
  if (span) {
    headerLines.push(
      `${c.bold("Name")}     ${span.name}${span.index === null ? "" : `[${span.index}]`}`
    );
  }
  headerLines.push(`${c.bold("Session")}  ${match.session.id}`);
  headerLines.push(
    `${c.bold("Records")}  ${match.snapshots.length} snapshot record${match.snapshots.length === 1 ? "" : "s"}`
  );
  console.log(headerLines.join("\n"));

  // Stats view: either for a single tensor, or a summary if no tensor named.
  if (!targetTensor) {
    // Summary: show per-tensor stats table for the first N (up to 40) records.
    const display = match.snapshots.slice(0, 40);
    const statsTable = new Table({
      head: [
        c.cyan("TENSOR"),
        c.cyan("DTYPE"),
        c.cyan("SHAPE"),
        c.cyan("MEAN"),
        c.cyan("STD"),
        c.cyan("NORM"),
        c.cyan("MODE"),
      ],
      colAligns: ["left", "left", "left", "right", "right", "right", "left"],
    });
    for (const snap of display) {
      statsTable.push([
        snap.tensorName,
        snap.dtype,
        `[${snap.shape.join(",")}]`,
        formatStat(snap.stats?.["mean"]),
        formatStat(snap.stats?.["std"]),
        formatStat(snap.stats?.["norm"]),
        snap.mode,
      ]);
    }
    console.log(`\n${statsTable.toString()}`);
    if (match.snapshots.length > display.length) {
      logger.info(
        c.gray(
          `… ${match.snapshots.length - display.length} more records not shown. Pass a tensor name to focus.`
        )
      );
    }

    // Safetensors header listing if blobs exist
    for (const blob of candidateBlobs) {
      try {
        const info = await readSafetensorsInfo(blob.path);
        await printSafetensorsSummary(blob, info, c);
      } catch (err) {
        logger.warn(`Could not read ${blob.path}: ${(err as Error).message}`);
      }
    }
    return;
  }

  // Targeted tensor view
  const record = match.snapshots.find((s) => s.tensorName === targetTensor);
  if (!record) {
    logger.error(
      `No snapshot record for tensor "${targetTensor}" on this span.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n${c.bold("Tensor")}   ${record.tensorName}  ${c.gray(`(${record.dtype}, shape=[${record.shape.join(",")}], mode=${record.mode})`)}`
  );

  const stats = record.stats;
  if (stats) {
    const lines = [
      `  mean = ${formatStat(stats["mean"])}`,
      `  std  = ${formatStat(stats["std"])}`,
      `  min  = ${formatStat(stats["min"])}`,
      `  max  = ${formatStat(stats["max"])}`,
      `  norm = ${formatStat(stats["norm"])}`,
    ];
    console.log(lines.join("\n"));

    const hist = stats["histogram"] as
      | { bins?: number[]; counts?: number[] }
      | undefined;
    if (hist && Array.isArray(hist.bins) && Array.isArray(hist.counts)) {
      console.log(
        `\n  histogram: ${renderHistogram(hist.bins, hist.counts, 40)}`
      );
    }
  } else {
    console.log("  (no stats recorded)");
  }

  // Safetensors blob side: locate the tensor in whichever blob holds it.
  let blobForTensor: {
    kind: string;
    info: SafetensorsFileInfo;
    path: string;
  } | null = null;
  for (const blob of candidateBlobs) {
    try {
      const info = await readSafetensorsInfo(blob.path);
      if (info.tensors.some((t) => t.name === record.tensorName)) {
        blobForTensor = { kind: blob.kind, info, path: blob.path };
        break;
      }
    } catch {
      // non-fatal
    }
  }

  if (blobForTensor) {
    const ti = blobForTensor.info.tensors.find(
      (t) => t.name === record.tensorName
    )!;
    console.log(
      `\n${c.bold("Blob")}     ${blobForTensor.path}` +
        `\n  dtype=${ti.dtype} shape=[${ti.shape.join(",")}] bytes=${ti.byteSize}`
    );

    const previewN = options.preview ? parseIntArg(options.preview, 0) : 0;
    const tailN = options.tail ? parseIntArg(options.tail, 0) : 0;
    if (previewN > 0 || tailN > 0) {
      const data = await readSafetensorsTensor(
        blobForTensor.path,
        record.tensorName
      );
      if (previewN > 0) {
        const head = tensorPreview(data, previewN, "head");
        console.log(
          `  first ${head.length}: [${head.map(formatPreviewVal).join(", ")}]`
        );
      }
      if (tailN > 0) {
        const tail = tensorPreview(data, tailN, "tail");
        console.log(
          `  last  ${tail.length}: [${tail.map(formatPreviewVal).join(", ")}]`
        );
      }
    }

    if (options.export) {
      // Extract just this tensor into a fresh single-tensor file; copying the
      // blob would carry every other tensor for this span along with it.
      let dest = path.resolve(options.export);
      try {
        const stat = await fs.stat(dest);
        if (stat.isDirectory()) {
          const safeName = record.tensorName.replace(/[^A-Za-z0-9._-]/g, "_");
          dest = path.join(dest, `${safeName}.safetensors`);
        }
      } catch {
        // dest doesn't exist yet — treat the path as a file.
      }
      await fs.ensureDir(path.dirname(dest));
      await writeSingleTensorSafetensors(
        blobForTensor.path,
        record.tensorName,
        dest
      );
      logger.success(`Wrote single-tensor safetensors to ${dest}`);
    }
  } else if (record.mode !== "stats") {
    logger.warn(
      `Record mode is "${record.mode}" but no local safetensors blob was found under ${spanDir}. The blob may be uploaded to the platform only.`
    );
  }
}

function formatPreviewVal(v: number | bigint): string {
  if (typeof v === "bigint") {
    return v.toString();
  }
  if (!Number.isFinite(v)) {
    return String(v);
  }
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e4)) {
    return v.toExponential(3);
  }
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

async function printSafetensorsSummary(
  blob: { kind: string; path: string },
  info: SafetensorsFileInfo,
  c: InstanceType<typeof Chalk>
): Promise<void> {
  const totalBytes = info.tensors.reduce((a, t) => a + t.byteSize, 0);
  console.log(
    `\n${c.bold(`${blob.kind}.safetensors`)}  ${c.gray(`(${info.tensors.length} tensor${info.tensors.length === 1 ? "" : "s"}, ${humanBytes(totalBytes)}, file=${humanBytes(info.fileSize)})`)}`
  );
  const table = new Table({
    head: [c.cyan("NAME"), c.cyan("DTYPE"), c.cyan("SHAPE"), c.cyan("BYTES")],
    colAligns: ["left", "left", "left", "right"],
  });
  const display = info.tensors.slice(0, 25);
  for (const t of display) {
    table.push([
      t.name,
      t.dtype,
      `[${t.shape.join(",")}]`,
      humanBytes(t.byteSize),
    ]);
  }
  console.log(table.toString());
  if (info.tensors.length > display.length) {
    logger.info(
      c.gray(
        `… ${info.tensors.length - display.length} more tensors not shown.`
      )
    );
  }
}
