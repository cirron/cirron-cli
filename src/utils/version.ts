// src/utils/version.ts
import fs from "fs";
import path from "path";

function loadVersion(): string {
  try {
    const pkgPath = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "package.json"
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = loadVersion();
export const USER_AGENT = `cirron-cli/${CLI_VERSION}`;
