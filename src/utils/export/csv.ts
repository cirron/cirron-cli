// src/utils/export/csv.ts
//
// Flat spans-only CSV for quick analysis in Excel/Google Sheets. One row
// per span; marks are excluded (use Parquet or JSON for full fidelity).
// Hand-rolled writer — keeps the dependency surface small.

import fs from 'fs-extra';
import path from 'path';
import type { Session } from '../session';

const COLUMNS = [
  'session_id',
  'span_id',
  'parent_id',
  'name',
  'index',
  'start_ns',
  'end_ns',
  'duration_ns',
  'cpu_ns',
  'gpu_ns',
  'memory_peak_bytes',
  'thread_id',
  'pid',
  'rank',
  'attrs_json',
] as const;

function escapeCsv(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return escapeCsv(v);
  if (typeof v === 'number') return String(v);
  return escapeCsv(JSON.stringify(v));
}

export async function exportCsv(
  sessions: Session[],
  outputPath: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(path.resolve(outputPath)));
  const lines: string[] = [];
  lines.push(COLUMNS.join(','));

  for (const session of sessions) {
    for (const span of session.spans.values()) {
      const duration =
        span.endNs === null ? null : span.endNs - span.startNs;
      const row = [
        cell(session.id),
        cell(span.id),
        cell(span.parentId),
        cell(span.name),
        cell(span.index),
        cell(span.startNs),
        cell(span.endNs),
        cell(duration),
        cell(span.cpuNs),
        cell(span.gpuNs),
        cell(span.memoryPeakBytes),
        cell(span.threadId),
        cell(span.pid),
        cell(span.rank),
        cell(JSON.stringify(span.attrs)),
      ];
      lines.push(row.join(','));
    }
  }

  await fs.writeFile(outputPath, lines.join('\n') + '\n', 'utf-8');
}
