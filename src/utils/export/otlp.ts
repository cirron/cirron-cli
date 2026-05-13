// src/utils/export/otlp.ts
//
// OpenTelemetry Protocol (OTLP) JSON encoding, per the OTLP/JSON spec.
// Produces a file that can be POSTed to an OTEL collector or imported
// directly into Jaeger / Tempo / Honeycomb — making the "no lock-in"
// promise concrete.
//
// Key encoding rules we follow:
//   - `traceId` is 32 hex chars, `spanId` and `parentSpanId` are 16.
//   - 64-bit time fields (`startTimeUnixNano`, `endTimeUnixNano`,
//     `timeUnixNano`) are strings, not numbers.
//   - Attributes are `{ key, value: AnyValue }` arrays.

import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type { Session, SpoolMark, SpoolSpan } from "../session";

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: { key: string; value: AnyValue }[] } };

function anyValue(v: unknown): AnyValue {
  if (typeof v === "string") {
    return { stringValue: v };
  }
  if (typeof v === "boolean") {
    return { boolValue: v };
  }
  if (typeof v === "bigint") {
    return { intValue: v.toString() };
  }
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
      return { intValue: v.toString() };
    }
    return { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(anyValue) } };
  }
  if (v && typeof v === "object") {
    return {
      kvlistValue: {
        values: Object.entries(v as Record<string, unknown>).map(
          ([k, inner]) => ({
            key: k,
            value: anyValue(inner),
          })
        ),
      },
    };
  }
  return { stringValue: String(v) };
}

function attributes(
  record: Record<string, unknown>
): { key: string; value: AnyValue }[] {
  return Object.entries(record).map(([k, v]) => ({
    key: k,
    value: anyValue(v),
  }));
}

// Coerce an opaque id (uuid or arbitrary string) to N hex chars. We hash
// the input with SHA-256 and truncate — collision-safe for in-run use.
function toHex(id: string, bytes: number): string {
  const clean = id.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (clean.length >= bytes * 2) {
    return clean.slice(0, bytes * 2);
  }
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  return hash.slice(0, bytes * 2);
}

interface OtlpEvent {
  attributes: { key: string; value: AnyValue }[];
  name: string;
  timeUnixNano: string;
}

interface OtlpSpan {
  attributes: { key: string; value: AnyValue }[];
  endTimeUnixNano: string;
  events: OtlpEvent[];
  kind: number;
  name: string;
  parentSpanId?: string;
  spanId: string;
  startTimeUnixNano: string;
  status: { code: number };
  traceId: string;
}

function encodeSpan(
  span: SpoolSpan,
  traceId: string,
  marks: SpoolMark[]
): OtlpSpan {
  const endNs = span.endNs ?? BigInt(Date.now()) * 1_000_000n;
  const hasError = Boolean(span.attrs["error"]);
  const result: OtlpSpan = {
    traceId,
    spanId: toHex(span.id, 8),
    name: span.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: span.startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: attributes({
      ...span.attrs,
      ...(span.index === null ? {} : { "cirron.index": span.index }),
      "cirron.rank": span.rank,
      ...(span.pid === null ? {} : { "process.pid": span.pid }),
    }),
    events: marks.map((mark) => ({
      timeUnixNano: mark.tsNs.toString(),
      name: mark.name,
      attributes: [
        { key: "value", value: anyValue(mark.value) },
        { key: "kind", value: { stringValue: mark.kind } },
      ],
    })),
    // Per OTLP: default to UNSET (0); ERROR (2) when the span attr signals
    // an error. We don't claim OK (1) proactively because the profiler
    // doesn't model success/failure semantics — letting the backend keep
    // spans "unset" reflects reality and avoids painting everything green.
    status: { code: hasError ? 2 : 0 },
  };
  if (span.parentId !== null) {
    result.parentSpanId = toHex(span.parentId, 8);
  }
  return result;
}

export async function exportOtlp(
  sessions: Session[],
  outputPath: string
): Promise<void> {
  const resourceSpans: unknown[] = [];

  for (const session of sessions) {
    const traceId = toHex(session.id, 16);
    const marksBySpan = new Map<string, SpoolMark[]>();
    for (const mark of session.marks) {
      let arr = marksBySpan.get(mark.spanId);
      if (!arr) {
        arr = [];
        marksBySpan.set(mark.spanId, arr);
      }
      arr.push(mark);
    }

    const spans: OtlpSpan[] = [];
    for (const span of session.spans.values()) {
      spans.push(encodeSpan(span, traceId, marksBySpan.get(span.id) ?? []));
    }

    resourceSpans.push({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "cirron" } },
          {
            key: "sdk.version",
            value: { stringValue: session.sdkVersion || "unknown" },
          },
          { key: "cirron.session.id", value: { stringValue: session.id } },
        ],
      },
      scopeSpans: [
        {
          scope: {
            name: "cirron",
            version: session.sdkVersion || "unknown",
          },
          spans,
        },
      ],
    });
  }

  await fs.ensureDir(path.dirname(path.resolve(outputPath)));
  await fs.writeFile(
    outputPath,
    JSON.stringify({ resourceSpans }, null, 2),
    "utf-8"
  );
}
