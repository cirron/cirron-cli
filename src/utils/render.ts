// src/utils/render.ts
//
// Text flamegraph rendering for `cirron traces view`. Produces the output
// format demonstrated in the SDK-51 story:
//
//   cirron.session — 561.7ms pid=1797 rank=0
//     epoch[0] — 42.1ms
//       data_load — 4.5ms data_load_ns=4541667
//       forward — 5.1ms

import chalk from "chalk";
import {
  type Session,
  type SpoolMark,
  type SpoolSpan,
  spanDurationNs,
} from "./session";
import { formatDurationNs } from "./spool";

export interface RenderOptions {
  maxDepth?: number;
  minWallNs?: bigint;
  nameFilter?: string;
  useColor?: boolean;
}

// Keys that users don't want echoed on every span line — either internal
// metadata, or fields we already render explicitly (pid/rank/thread_id)
// so the SDK redundantly stashing them in attrs doesn't surface twice.
const NOISY_ATTR_KEYS = new Set<string>([
  "cirron.internal",
  "cirron.scope.parent",
  "pid",
  "rank",
  "thread_id",
  "tid",
]);

export function shouldColor(
  stream: NodeJS.WriteStream,
  noColorFlag: boolean | undefined
): boolean {
  if (noColorFlag) {
    return false;
  }
  if (process.env["NO_COLOR"]) {
    return false;
  }
  return Boolean(stream.isTTY);
}

function formatAttrs(attrs: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (NOISY_ATTR_KEYS.has(k)) {
      continue;
    }
    if (v === null || v === undefined) {
      continue;
    }
    if (typeof v === "object") {
      continue; // avoid dumping nested JSON into the tree
    }
    pairs.push(`${k}=${String(v)}`);
  }
  return pairs.join(" ");
}

function formatMarkValue(mark: SpoolMark): string {
  if (typeof mark.value === "number") {
    const n = mark.value;
    if (Number.isInteger(n)) {
      return String(n);
    }
    // Keep a compact fixed-precision for floats.
    return Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6
      ? n.toExponential(3)
      : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof mark.value === "string") {
    return JSON.stringify(mark.value);
  }
  if (mark.value === null || mark.value === undefined) {
    return "null";
  }
  return JSON.stringify(mark.value);
}

function matchesFilter(
  span: SpoolSpan,
  session: Session,
  filter: string
): boolean {
  if (span.name.includes(filter)) {
    return true;
  }
  // include ancestors that lead to a matching descendant (tree context)
  const stack = [...(session.childrenOf.get(span.id) ?? [])];
  while (stack.length > 0) {
    const childId = stack.pop()!;
    const child = session.spans.get(childId);
    if (!child) {
      continue;
    }
    if (child.name.includes(filter)) {
      return true;
    }
    const grand = session.childrenOf.get(childId);
    if (grand) {
      stack.push(...grand);
    }
  }
  return false;
}

function aggregateSubtreeWallNs(
  session: Session,
  rootId: string
): { totalNs: bigint; spanCount: number } {
  let totalNs = 0n;
  let spanCount = 0;
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const span = session.spans.get(id);
    if (!span) {
      continue;
    }
    spanCount++;
    const dur = spanDurationNs(span);
    if (dur !== null) {
      totalNs += dur;
    }
    const kids = session.childrenOf.get(id);
    if (kids) {
      stack.push(...kids);
    }
  }
  return { totalNs, spanCount };
}

interface RenderContext {
  marksBySpan: Map<string, SpoolMark[]>;
  opts: Required<Omit<RenderOptions, "nameFilter">> & {
    nameFilter: string | null;
  };
  out: string[];
  session: Session;
}

function renderSpan(ctx: RenderContext, spanId: string, depth: number): void {
  const span = ctx.session.spans.get(spanId);
  if (!span) {
    return;
  }

  const durNs = spanDurationNs(span);
  if (ctx.opts.minWallNs > 0n && durNs !== null && durNs < ctx.opts.minWallNs) {
    return;
  }
  if (
    ctx.opts.nameFilter &&
    !matchesFilter(span, ctx.session, ctx.opts.nameFilter)
  ) {
    return;
  }

  const indent = "  ".repeat(depth);
  const color = ctx.opts.useColor;

  let label = span.name;
  if (span.index !== null && span.index !== undefined) {
    label += `[${span.index}]`;
  }
  const coloredLabel = color ? chalk.cyan(label) : label;

  const durStr = formatDurationNs(durNs);
  const coloredDur = color ? chalk.yellow(durStr) : durStr;

  const attrsStr = formatAttrs(span.attrs);
  const extras: string[] = [];
  // Only the session root carries pid/rank worth rendering — descendants
  // inherit them, and echoing every line clutters the tree.
  if (span.parentId === null) {
    if (span.pid !== null) {
      extras.push(`pid=${span.pid}`);
    }
    extras.push(`rank=${span.rank}`);
  } else if (span.rank !== 0) {
    extras.push(`rank=${span.rank}`);
  }
  if (attrsStr) {
    extras.push(attrsStr);
  }
  const extrasStr = extras.length
    ? " " + (color ? chalk.gray(extras.join(" ")) : extras.join(" "))
    : "";

  const liveTag =
    span.endNs === null ? (color ? chalk.magenta(" (open)") : " (open)") : "";

  ctx.out.push(
    `${indent}${coloredLabel} — ${coloredDur}${extrasStr}${liveTag}`
  );

  // Marks attached to this span
  const marks = ctx.marksBySpan.get(spanId);
  if (marks && marks.length > 0) {
    const markIndent = "  ".repeat(depth + 1);
    for (const mark of marks) {
      const lhs = color ? chalk.gray("ci.mark") : "ci.mark";
      const name = color ? chalk.white(mark.name) : mark.name;
      const val = formatMarkValue(mark);
      const kindTag =
        mark.kind === "summary"
          ? color
            ? chalk.gray(" (summary)")
            : " (summary)"
          : "";
      ctx.out.push(`${markIndent}${lhs} ${name}=${val}${kindTag}`);
    }
  }

  const children = ctx.session.childrenOf.get(spanId) ?? [];
  const nextDepth = depth + 1;

  if (nextDepth > ctx.opts.maxDepth && children.length > 0) {
    // Aggregate only the descendant subtrees — the current span's own
    // duration is already rendered on the line above, so including it
    // here would double-count and produce a total exceeding the parent.
    let totalNs = 0n;
    let spanCount = 0;
    for (const childId of children) {
      const r = aggregateSubtreeWallNs(ctx.session, childId);
      totalNs += r.totalNs;
      spanCount += r.spanCount;
    }
    if (spanCount > 0) {
      const tag = color
        ? chalk.gray(`(${spanCount} spans, collapsed)`)
        : `(${spanCount} spans, collapsed)`;
      ctx.out.push(
        `${"  ".repeat(depth + 1)}… ${formatDurationNs(totalNs)} ${tag}`
      );
    }
    return;
  }

  for (const childId of children) {
    renderSpan(ctx, childId, nextDepth);
  }
}

export function renderSessionTree(
  session: Session,
  opts: RenderOptions = {}
): string {
  const normalized = {
    maxDepth: opts.maxDepth ?? Number.MAX_SAFE_INTEGER,
    minWallNs: opts.minWallNs ?? 0n,
    nameFilter: opts.nameFilter ?? null,
    useColor: opts.useColor ?? false,
  };

  const marksBySpan = new Map<string, SpoolMark[]>();
  for (const mark of session.marks) {
    let arr = marksBySpan.get(mark.spanId);
    if (!arr) {
      arr = [];
      marksBySpan.set(mark.spanId, arr);
    }
    arr.push(mark);
  }
  for (const arr of marksBySpan.values()) {
    arr.sort((a, b) => (a.tsNs < b.tsNs ? -1 : a.tsNs > b.tsNs ? 1 : 0));
  }

  const ctx: RenderContext = {
    session,
    opts: normalized,
    out: [],
    marksBySpan,
  };
  renderSpan(ctx, session.root.id, 0);
  return ctx.out.join("\n");
}
