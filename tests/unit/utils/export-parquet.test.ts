import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportParquet } from "../../../src/utils/export/parquet";
import type { Session, SpoolSpan } from "../../../src/utils/session";
import { makeTmpDir } from "../../helpers/tmpdir";

interface ParquetReaderModule {
  ParquetReader: {
    openFile: (file: string) => Promise<{
      getRowCount: () => number | bigint;
      close: () => Promise<void>;
    }>;
  };
}

function makeSpan(overrides: Partial<SpoolSpan> = {}): SpoolSpan {
  return {
    id: "span-root",
    name: "cirron.session",
    parentId: null,
    startNs: 1_000_000_000n,
    endNs: 2_000_000_000n,
    cpuNs: null,
    gpuNs: null,
    memoryPeakBytes: null,
    pid: 1,
    rank: 0,
    threadId: null,
    index: null,
    attrs: {},
    markIds: [],
    ...overrides,
  };
}

function makeSession(): Session {
  const root = makeSpan();
  const child = makeSpan({
    id: "span-child",
    name: "train_step",
    parentId: "span-root",
    startNs: 1_100_000_000n,
    endNs: 1_900_000_000n,
  });
  return {
    id: "sess-aaaaaaaa1111",
    sdkVersion: "0.1.0",
    schemaVersion: 1,
    startedNs: 1_000_000_000n,
    endedNs: 2_000_000_000n,
    isLive: false,
    spans: new Map([
      [root.id, root],
      [child.id, child],
    ]),
    childrenOf: new Map([[root.id, [child.id]]]),
    marks: [],
    snapshots: [
      {
        id: "snap-1",
        spanId: "span-child",
        tensorName: "weight",
        dtype: "float32",
        shape: [4],
        mode: "stats",
        blobUri: null,
        tsNs: 1_500_000_000n,
        stats: { mean: 0.5, std: 0.1, min: 0, max: 1, norm: 1.2 },
        attrs: {},
      },
    ],
    root,
    batchFiles: [],
    totalBytes: 0,
  };
}

// Runs the real @dsnp/parquetjs (no mocks) so a broken release of it fails here.
describe("exportParquet", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-parquet-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("writes spans and snapshots files that read back with the right row counts", async () => {
    const counts = await exportParquet([makeSession()], tmp.dir);
    expect(counts).toEqual({ spans: 2, marks: 0, snapshots: 1 });

    const parquet = require("@dsnp/parquetjs") as ParquetReaderModule;
    for (const [file, rows] of [
      ["spans.parquet", 2],
      ["marks.parquet", 0],
      ["snapshots.parquet", 1],
    ] as const) {
      const reader = await parquet.ParquetReader.openFile(
        path.join(tmp.dir, file)
      );
      expect(Number(reader.getRowCount())).toBe(rows);
      await reader.close();
    }
  });
});
