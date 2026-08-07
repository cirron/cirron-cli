#!/usr/bin/env node
/**
 * Verify that this repo's wire-contract fixtures and the platform's copies are
 * byte-identical.
 *
 * The fixtures in tests/contracts/ are the shared source of truth: this repo
 * asserts its API client against them, and the platform repo asserts its route
 * handlers against the same files. That only works if the two copies stay in
 * sync, so changing the contract means updating the fixture in one repo,
 * running its suite, copying to the other, and running that one. This script
 * is what makes the copy step non-optional.
 *
 * Set CIRRON_PLATFORM_DIR to point at the platform checkout. When it isn't
 * there, the check reports that and exits 0, so CI in this repo runs
 * standalone.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = join(repoRoot, "tests", "contracts");
const platformRoot =
  process.env.CIRRON_PLATFORM_DIR ??
  resolve(repoRoot, "..", "..", "Repos", "cirron");
const platformDir = join(
  platformRoot,
  "apps",
  "app",
  "__tests__",
  "contracts",
  "cli"
);

function fixtures(dir) {
  const map = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, file)))
      .digest("hex");
    map.set(file, digest);
  }
  return map;
}

if (!existsSync(platformDir)) {
  console.log(
    `platform contracts dir not found (${platformDir}) - skipping sync check`
  );
  process.exit(0);
}

const local = fixtures(localDir);
const platform = fixtures(platformDir);

const missing = [...local.keys()].filter((name) => !platform.has(name));
const extra = [...platform.keys()].filter((name) => !local.has(name));
const differing = [...local.entries()]
  .filter(
    ([name, digest]) => platform.has(name) && platform.get(name) !== digest
  )
  .map(([name]) => name);

for (const name of missing) {
  console.error(`missing on the platform side: ${name}`);
}
for (const name of extra) {
  console.error(`present only on the platform side: ${name}`);
}
for (const name of differing) {
  console.error(`contents differ: ${name}`);
}

const problems = missing.length + extra.length + differing.length;
if (problems > 0) {
  console.error(
    `\n${problems} fixture(s) out of sync between ${localDir} and ${platformDir}`
  );
  process.exit(1);
}

console.log(`${local.size} contract fixtures in sync with the platform`);
