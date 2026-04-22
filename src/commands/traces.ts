// src/commands/traces.ts
//
// SDK-51: `cirron traces {view,list,export,clear}`.
//
// Reads the local spool (`.cirron/spool/*.json`) + snapshots
// (`.cirron/snapshots/<span_id>/*.safetensors`). Never talks to the
// platform. Remote/run-scoped reads are a follow-on ticket (see
// features/sdk-traces-platform-read.md in the platform monorepo).

import path from 'path';
import chalk from 'chalk';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { logger } from '../utils/logger';
import {
  formatDurationNs,
  humanBytes,
  nsToIso,
  parseDurationNs,
  resolveSnapshotDir,
  resolveSpoolDir,
} from '../utils/spool';
import {
  loadSessions,
  spanDurationNs,
  type Session,
} from '../utils/session';
import { renderSessionTree, shouldColor } from '../utils/render';
import { exportJson } from '../utils/export/json';
import { exportCsv } from '../utils/export/csv';
import { exportOtlp } from '../utils/export/otlp';
import { exportParquet } from '../utils/export/parquet';

interface ViewOptions {
  last?: string;
  name?: string;
  session?: string;
  depth?: string;
  minWall?: string;
  spool?: string;
  noColor?: boolean;
  json?: boolean;
}

interface ListOptions {
  spool?: string;
  json?: boolean;
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
  yes?: boolean;
  spool?: string;
  pruneOrphans?: boolean;
}

function parseIntArg(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer: ${s}`);
  }
  return n;
}

function noTracesFound(): void {
  logger.info(
    chalk.yellow(
      'No traces found. Run ci.profile() from Python to produce some.',
    ),
  );
}

// view

export async function tracesViewCommand(options: ViewOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  const useColor = shouldColor(process.stdout, options.noColor);
  const maxDepth = options.depth ? parseIntArg(options.depth, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;

  let minWallNs = 0n;
  if (options.minWall) {
    const parsed = parseDurationNs(options.minWall);
    if (parsed === null) {
      logger.error(
        `Invalid --min-wall: ${options.minWall} (try 1ms, 500us, 2s, 100ns)`,
      );
      process.exitCode = 2;
      return;
    }
    minWallNs = parsed;
  }

  let selected: Session[];
  if (options.session) {
    const match = sessions.find((s) => s.id === options.session || s.id.startsWith(options.session!));
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

  const renderOpts: import('../utils/render').RenderOptions = {
    maxDepth,
    minWallNs,
    useColor,
  };
  if (options.name !== undefined) renderOpts.nameFilter = options.name;

  const blocks: string[] = [];
  for (const session of selected) {
    blocks.push(renderSessionTree(session, renderOpts));
  }
  console.log(blocks.join('\n\n'));
}

function sessionToJsonTree(session: Session): unknown {
  const build = (spanId: string): unknown => {
    const span = session.spans.get(spanId);
    if (!span) return null;
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
    `${chalk.bold('Spool:')} ${spoolDir}  ${chalk.gray(`(${sessions.length} session${sessions.length === 1 ? '' : 's'})`)}`,
  );

  const table = new Table({
    head: [
      chalk.cyan('SESSION'),
      chalk.cyan('STARTED'),
      chalk.cyan('DURATION'),
      chalk.cyan('SPANS'),
      chalk.cyan('MARKS'),
      chalk.cyan('SNAPSHOTS'),
      chalk.cyan('SIZE'),
    ],
    colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const s of sessions) {
    const dur =
      s.endedNs === null ? chalk.magenta('(live)') : formatDurationNs(s.endedNs - s.startedNs);
    table.push([
      s.id.slice(0, 8) + '…',
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

export async function tracesExportCommand(options: ExportOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.spool);
  const sessions = await loadSessions(spoolDir);

  if (sessions.length === 0) {
    noTracesFound();
    return;
  }

  let selected = sessions;
  if (options.session) {
    const match = sessions.find(
      (s) => s.id === options.session || s.id.startsWith(options.session!),
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
    if (format === 'parquet') {
      const outDir = output ?? './cirron-traces';
      const counts = await exportParquet(selected, outDir);
      logger.success(
        `Wrote ${counts.spans} spans, ${counts.marks} marks, ${counts.snapshots} snapshots to ${outDir}`,
      );
    } else if (format === 'json') {
      const outFile = output ?? './cirron-traces.json';
      await exportJson(selected, outFile);
      logger.success(`Wrote merged JSON to ${outFile}`);
    } else if (format === 'csv') {
      const outFile = output ?? './cirron-traces.csv';
      await exportCsv(selected, outFile);
      logger.success(`Wrote spans CSV to ${outFile}`);
    } else if (format === 'otel' || format === 'otlp') {
      const outFile = output ?? './cirron-traces.otlp.json';
      await exportOtlp(selected, outFile);
      logger.success(`Wrote OTLP JSON to ${outFile}`);
    } else {
      logger.error(
        `Unknown --format: ${options.format}. Supported: parquet, otel, csv, json.`,
      );
      process.exitCode = 2;
    }
  } catch (err) {
    logger.error(`Export failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// clear

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
      logger.error(`Invalid --before date: ${options.before} (expected ISO-8601)`);
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
    logger.info(chalk.yellow('Nothing to delete.'));
    return;
  }

  // Stage the delete list before touching disk.
  const batchFiles = new Set<string>();
  const spanIds = new Set<string>();
  let totalBytes = 0;
  let spanCount = 0;
  for (const s of eligible) {
    for (const f of s.batchFiles) batchFiles.add(f);
    for (const id of s.spans.keys()) {
      spanIds.add(id);
      spanCount++;
    }
    totalBytes += s.totalBytes;
  }

  // Figure out snapshot dirs to remove (only those whose span is in the
  // to-delete set). Then, if --prune-orphans (default true), also drop any
  // snapshot dir whose span isn't referenced by any *surviving* session.
  const survivingSpanIds = new Set<string>();
  for (const s of sessions) {
    if (eligible.includes(s)) continue;
    for (const id of s.spans.keys()) survivingSpanIds.add(id);
  }

  const snapshotDirsToDelete: string[] = [];
  if (await fs.pathExists(snapshotDir)) {
    const entries = await fs.readdir(snapshotDir);
    for (const entry of entries) {
      const full = path.join(snapshotDir, entry);
      const stat = await fs.stat(full);
      if (!stat.isDirectory()) continue;
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
    const prompt = `Delete ${chalk.cyan(eligible.length)} session${eligible.length === 1 ? '' : 's'} (${spanCount.toLocaleString()} spans, ${humanBytes(totalBytes)}, ${snapshotDirsToDelete.length} snapshot dir${snapshotDirsToDelete.length === 1 ? '' : 's'})?`;
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      { type: 'confirm', name: 'confirm', message: prompt, default: false },
    ]);
    if (!confirm) {
      logger.info('Cancelled.');
      return;
    }
  }

  // Guard against partial deletes on Ctrl-C: set up a handler that aborts
  // before we touch disk, clears it once we're done.
  let interrupted = false;
  const sigintHandler = () => {
    interrupted = true;
  };
  process.on('SIGINT', sigintHandler);

  let deletedFiles = 0;
  let deletedDirs = 0;
  try {
    for (const file of batchFiles) {
      if (interrupted) break;
      try {
        await fs.unlink(file);
        deletedFiles++;
      } catch (err) {
        logger.error(`Failed to delete ${file}: ${(err as Error).message}`);
      }
    }
    for (const dir of snapshotDirsToDelete) {
      if (interrupted) break;
      try {
        await fs.remove(dir);
        deletedDirs++;
      } catch (err) {
        logger.error(`Failed to delete ${dir}: ${(err as Error).message}`);
      }
    }
  } finally {
    process.off('SIGINT', sigintHandler);
  }

  if (interrupted) {
    logger.warn(
      `Interrupted. Deleted ${deletedFiles} batch file(s) and ${deletedDirs} snapshot dir(s) before exit.`,
    );
    process.exitCode = 130;
    return;
  }

  logger.success(
    `Deleted ${deletedFiles} batch file${deletedFiles === 1 ? '' : 's'}` +
      (deletedDirs
        ? ` and ${deletedDirs} snapshot dir${deletedDirs === 1 ? '' : 's'}`
        : '') +
      `.`,
  );
}
