import path from "node:path";
import fs from "fs-extra";

/**
 * Shared scaffolding shared across all templates. Matches the
 * cirron-sample-models reference layout: an `artifacts/` directory
 * (with a .gitkeep so it survives commit) is the only file the common
 * helper writes. Each template writes its own `cirron.yaml`,
 * `requirements.txt`, `train.py`, and `serve.py`.
 */
export async function createCommonMLFiles(
  projectPath: string,
  _projectName: string,
  _options: {
    framework: string;
    modelType: string;
    includeSampleData: boolean;
    includeNotebook: boolean;
  }
): Promise<void> {
  const artifactsDir = path.join(projectPath, "artifacts");
  await fs.ensureDir(artifactsDir);
  await fs.writeFile(path.join(artifactsDir, ".gitkeep"), "");
}
