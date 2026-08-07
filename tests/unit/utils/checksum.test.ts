import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFileChecksum } from "../../../src/utils/checksum";
import { makeTmpDir } from "../../helpers/tmpdir";

describe("computeFileChecksum", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-checksum-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns sha256 hex for file content", async () => {
    const fp = path.join(tmp.dir, "x.bin");
    fs.writeFileSync(fp, "hello world");
    expect(await computeFileChecksum(fp)).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
  });

  it("hashes an empty file to the sha256 empty digest", async () => {
    const fp = path.join(tmp.dir, "empty.bin");
    fs.writeFileSync(fp, "");
    expect(await computeFileChecksum(fp)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("streams content larger than one chunk", async () => {
    const fp = path.join(tmp.dir, "big.bin");
    const payload = Buffer.alloc(256 * 1024, 9);
    fs.writeFileSync(fp, payload);
    const expected = await import("node:crypto").then((c) =>
      c.createHash("sha256").update(payload).digest("hex")
    );
    expect(await computeFileChecksum(fp)).toBe(expected);
  });

  it("rejects when the file does not exist", async () => {
    await expect(
      computeFileChecksum(path.join(tmp.dir, "missing.bin"))
    ).rejects.toThrow();
  });
});
