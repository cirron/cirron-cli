import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tracesClearCommand,
  tracesExportCommand,
  tracesListCommand,
  tracesSnapshotCommand,
  tracesSnapshotsCommand,
  tracesViewCommand,
} from "../../src/commands/traces";
// Namespace imports needed so vi.spyOn can stub these module exports.
// biome-ignore lint/performance/noNamespaceImport: required for vi.spyOn
import * as csvMod from "../../src/utils/export/csv";
// biome-ignore lint/performance/noNamespaceImport: required for vi.spyOn
import * as jsonMod from "../../src/utils/export/json";
// biome-ignore lint/performance/noNamespaceImport: required for vi.spyOn
import * as otlpMod from "../../src/utils/export/otlp";
// biome-ignore lint/performance/noNamespaceImport: required for vi.spyOn
import * as parquetMod from "../../src/utils/export/parquet";
import type {
  Session,
  SpoolSnapshot,
  SpoolSpan,
} from "../../src/utils/session";
// biome-ignore lint/performance/noNamespaceImport: required for vi.spyOn
import * as sessionMod from "../../src/utils/session";
import { stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * traces.ts is platform-free: it reads the local spool dir via loadSessions.
 * We mock loadSessions to inject curated Session shapes and exercise each
 * subcommand's filter / render / export / clear branches.
 */
describe("traces commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

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

  function makeSession(
    overrides: Partial<Session> = {},
    snapshots: SpoolSnapshot[] = []
  ): Session {
    const root = makeSpan();
    const child = makeSpan({
      id: "span-child",
      name: "train_step",
      parentId: "span-root",
      startNs: 1_100_000_000n,
      endNs: 1_900_000_000n,
    });
    const spans = new Map<string, SpoolSpan>([
      [root.id, root],
      [child.id, child],
    ]);
    const childrenOf = new Map<string, string[]>([[root.id, [child.id]]]);
    return {
      id: "sess-aaaaaaaa1111",
      sdkVersion: "0.1.0",
      schemaVersion: 1,
      startedNs: 1_000_000_000n,
      endedNs: 2_000_000_000n,
      isLive: false,
      spans,
      childrenOf,
      marks: [],
      snapshots,
      root,
      batchFiles: ["/tmp/spool/batch-1.json"],
      totalBytes: 4096,
      ...overrides,
    };
  }

  function makeSnapshot(overrides: Partial<SpoolSnapshot> = {}): SpoolSnapshot {
    return {
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
      ...overrides,
    };
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-traces-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.exitCode = 0;
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
    process.exitCode = 0;
  });

  describe("tracesViewCommand", () => {
    it("prints 'no traces' when spool is empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesViewCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces found/);
    });

    it("rejects malformed --min-wall", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesViewCommand({ minWall: "bogus" });
      expect(process.exitCode).toBe(2);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Invalid --min-wall/
      );
    });

    it("session-id mismatch sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesViewCommand({ session: "no-such-prefix" });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/No session found/);
    });

    it("--json with session prefix returns single object", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesViewCommand({ json: true, session: "sess-aaa" });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"session_id"')
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      const parsed = JSON.parse(jsonArg ?? "{}");
      expect(parsed.session_id).toBe("sess-aaaaaaaa1111");
      expect(parsed.tree.children).toHaveLength(1);
    });

    it("--json without session emits array when multiple sessions", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({ id: "sess-aaaaaaaa1111" }),
        makeSession({ id: "sess-bbbbbbbb2222" }),
      ]);
      await tracesViewCommand({ json: true, last: "2" });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.trim().startsWith("[")
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "[]")).toHaveLength(2);
    });

    it("text mode renders the session tree", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesViewCommand({ noColor: true });
      // renderSessionTree output includes the span name
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /cirron\.session|train_step/
      );
    });
  });

  describe("tracesListCommand", () => {
    it("prints 'no traces' when empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesListCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces found/);
    });

    it("emits empty JSON object when --json and empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesListCommand({ json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"sessions"')
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "{}").sessions).toEqual([]);
    });

    it("renders table when sessions exist", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({ id: "sess-aaaaaaaa1111" }),
        makeSession({ id: "sess-bbbbbbbb2222", isLive: true, endedNs: null }),
      ]);
      await tracesListCommand({});
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Spool:|SESSION/);
      expect(out).toMatch(/sess-aa|sess-bb/);
    });

    it("--json emits array of sessions", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesListCommand({ json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"sessions"')
        ) as string | undefined;
      const parsed = JSON.parse(jsonArg ?? "{}");
      expect(parsed.sessions).toHaveLength(1);
      expect(parsed.sessions[0].id).toBe("sess-aaaaaaaa1111");
    });
  });

  describe("tracesExportCommand", () => {
    it("'no traces' on empty spool", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesExportCommand({ format: "json" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces found/);
    });

    it("session filter not found sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesExportCommand({ format: "json", session: "no-match" });
      expect(process.exitCode).toBe(1);
    });

    it("unknown format sets exitCode 2", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesExportCommand({ format: "xml" });
      expect(process.exitCode).toBe(2);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Unknown --format/);
    });

    it("delegates to exportJson", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      const spy = vi
        .spyOn(jsonMod, "exportJson")
        .mockResolvedValue(undefined as never);
      await tracesExportCommand({ format: "json", output: "out.json" });
      expect(spy).toHaveBeenCalledWith(expect.any(Array), "out.json");
    });

    it("delegates to exportCsv", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      const spy = vi
        .spyOn(csvMod, "exportCsv")
        .mockResolvedValue(undefined as never);
      await tracesExportCommand({ format: "csv" });
      expect(spy).toHaveBeenCalled();
    });

    it("delegates to exportParquet", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      const spy = vi
        .spyOn(parquetMod, "exportParquet")
        .mockResolvedValue({ spans: 2, marks: 0, snapshots: 0 } as never);
      await tracesExportCommand({ format: "parquet" });
      expect(spy).toHaveBeenCalled();
    });

    it("delegates to exportOtlp (via 'otel' alias)", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      const spy = vi
        .spyOn(otlpMod, "exportOtlp")
        .mockResolvedValue(undefined as never);
      await tracesExportCommand({ format: "otel" });
      expect(spy).toHaveBeenCalled();
    });

    it("export error sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      vi.spyOn(jsonMod, "exportJson").mockRejectedValue(new Error("disk full"));
      await tracesExportCommand({ format: "json" });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Export failed/);
    });
  });

  describe("tracesClearCommand", () => {
    it("prints 'no traces' on empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesClearCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces to clear/);
    });

    it("rejects invalid --before date", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesClearCommand({ before: "totally-not-a-date" });
      expect(process.exitCode).toBe(2);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Invalid --before/);
    });

    it("'nothing to delete' when --keep covers all eligible", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesClearCommand({ keep: "10", yes: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Nothing to delete/);
    });

    it("aborts when user declines confirmation", async () => {
      const batchFile = path.join(tmp.dir, "batch-1.json");
      fs.writeFileSync(batchFile, "{}");
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({ batchFiles: [batchFile] }),
      ]);
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        confirm: false,
      } as never);

      await tracesClearCommand({});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Cancelled/);
      expect(fs.existsSync(batchFile)).toBe(true);
    });

    it("--yes deletes batch files (no prompt)", async () => {
      const batchFile = path.join(tmp.dir, "batch-1.json");
      fs.writeFileSync(batchFile, "{}");
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({ batchFiles: [batchFile] }),
      ]);
      const promptSpy = vi.spyOn(inquirer, "prompt");

      await tracesClearCommand({ yes: true });

      expect(promptSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(batchFile)).toBe(false);
    });
  });

  describe("tracesSnapshotsCommand", () => {
    it("prints 'no traces' on empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesSnapshotsCommand(undefined, {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces found/);
    });

    it("session not found sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesSnapshotsCommand(undefined, { session: "nope" });
      expect(process.exitCode).toBe(1);
    });

    it("'no snapshots found' when sessions have none", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesSnapshotsCommand(undefined, {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No snapshots found/);
    });

    it("--json with snapshots emits structured array", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [makeSnapshot()]),
      ]);
      await tracesSnapshotsCommand(undefined, { json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"snapshots"')
        ) as string | undefined;
      const parsed = JSON.parse(jsonArg ?? "{}");
      expect(parsed.snapshots).toHaveLength(1);
      expect(parsed.snapshots[0].tensor_count).toBe(1);
    });

    it("renders table when snapshots present", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [makeSnapshot()]),
      ]);
      await tracesSnapshotsCommand(undefined, {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /SESSION|SPAN|TENSORS/
      );
    });

    it("positional spanArg behaves like --span", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [makeSnapshot()]),
      ]);
      await tracesSnapshotsCommand("span-child", {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/span-chi/);
    });
  });

  describe("tracesSnapshotCommand", () => {
    it("prints 'no traces' on empty", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([]);
      await tracesSnapshotCommand("span-x", undefined, {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No traces found/);
    });

    it("'no snapshots for span' sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([makeSession()]);
      await tracesSnapshotCommand("span-missing", undefined, {});
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /No snapshots found/
      );
    });

    it("summary view renders stats table", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [makeSnapshot()]),
      ]);
      await tracesSnapshotCommand("span-child", undefined, { noColor: true });
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Records|Span|TENSOR|weight/);
    });

    it("targeted tensor that doesn't exist sets exitCode 1", async () => {
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [makeSnapshot()]),
      ]);
      await tracesSnapshotCommand("span-child", "nonexistent-tensor", {
        noColor: true,
      });
      expect(process.exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /No snapshot record/
      );
    });

    it("targeted tensor renders stats + histogram", async () => {
      const snap = makeSnapshot({
        stats: {
          mean: 0.5,
          std: 0.1,
          min: 0,
          max: 1,
          norm: 1.2,
          histogram: { bins: [0, 0.5, 1], counts: [3, 5, 2] },
        },
      });
      vi.spyOn(sessionMod, "loadSessions").mockResolvedValue([
        makeSession({}, [snap]),
      ]);

      await tracesSnapshotCommand("span-child", "weight", { noColor: true });

      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/mean|histogram/);
    });
  });
});
