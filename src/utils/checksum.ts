import crypto from "node:crypto";
import fs from "fs-extra";

/**
 * SHA-256 of a file's contents, as lowercase hex.
 *
 * Streamed rather than buffered: artifacts are routinely multi-gigabyte, and
 * the registry addresses everything by this digest.
 */
export async function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
