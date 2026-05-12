import chalk from "chalk";
import type { ProjectConfig, WorkspaceConfig } from "../types";
import { logger } from "../utils/logger";
import {
  type DiscoveredModel,
  detectMode,
  discoverModels,
  filterModels,
} from "../utils/workspace";

interface ValidateOptions {
  dir?: string;
  json?: boolean;
  model?: string[];
}

interface ConfigIssues {
  errors: string[];
  warnings: string[];
}

interface ModelReport {
  errors: string[];
  name: string;
  ok: boolean;
  path: string;
  warnings: string[];
}

const KNOWN_FRAMEWORKS = [
  "pytorch",
  "tensorflow",
  "sklearn",
  "onnx",
  "custom",
];

function validateModelConfig(config: ProjectConfig): ConfigIssues {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of ["name", "version", "framework"] as const) {
    if (!config[field]) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (config.framework && !KNOWN_FRAMEWORKS.includes(config.framework)) {
    errors.push(
      `unknown framework "${config.framework}" (expected one of: ${KNOWN_FRAMEWORKS.join(", ")})`
    );
  }

  if (config.version && !/^\d+\.\d+\.\d+/.test(config.version)) {
    warnings.push(
      `version "${config.version}" should follow semantic versioning (e.g. 1.0.0)`
    );
  }

  return { errors, warnings };
}

function validateRootConfig(workspace: WorkspaceConfig): string[] {
  const errors: string[] = [];
  const ws = workspace.workspace;

  if (typeof ws.name !== "string" || ws.name.trim() === "") {
    errors.push("workspace.name must be a non-empty string");
  }
  if (!Array.isArray(ws.models) || ws.models.length === 0) {
    errors.push("workspace.models must be a non-empty array");
  } else {
    ws.models.forEach((entry, i) => {
      if (!entry || typeof entry.path !== "string" || entry.path.trim() === "") {
        errors.push(`workspace.models[${i}] must have a non-empty "path"`);
      }
    });
  }

  return errors;
}

function printModelReport(report: ModelReport): void {
  const label = `${report.name} (${report.path})`;
  if (report.ok) {
    logger.info(`${chalk.green("PASS")} ${label}`);
  } else {
    logger.info(`${chalk.red("FAIL")} ${label}`);
  }
  for (const err of report.errors) {
    logger.info(`  ${chalk.red("error")}  ${err}`);
  }
  for (const warn of report.warnings) {
    logger.info(`  ${chalk.yellow("warn")}   ${warn}`);
  }
}

function reportFor(model: DiscoveredModel): ModelReport {
  const { errors, warnings } = validateModelConfig(model.config);
  return {
    name: model.name,
    path: model.path,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

async function runSingleMode(
  config: ProjectConfig,
  options: ValidateOptions
): Promise<void> {
  if (options.model && options.model.length > 0) {
    const requested = options.model.filter((m) => m !== config.name);
    if (requested.length > 0 || !options.model.includes(config.name)) {
      const msg = `--model ${options.model.join(", ")} did not match this project (${config.name})`;
      if (options.json) {
        logger.json({ name: config.name, ok: false, errors: [msg], warnings: [] });
      } else {
        logger.error(msg);
      }
      process.exit(1);
    }
  }

  const { errors, warnings } = validateModelConfig(config);
  const ok = errors.length === 0;

  if (options.json) {
    logger.json({ name: config.name, ok, errors, warnings });
  } else {
    printModelReport({ name: config.name, path: ".", ok, errors, warnings });
    logger.info(ok ? chalk.green("Configuration is valid.") : chalk.red("Configuration is invalid."));
  }

  if (!ok) {
    process.exit(1);
  }
}

async function runMonorepoMode(
  workspace: WorkspaceConfig,
  rootDir: string,
  options: ValidateOptions
): Promise<void> {
  const rootErrors = validateRootConfig(workspace);
  const { resolved, missing } = discoverModels(workspace, rootDir);

  let models = resolved;
  let unmatched: string[] = [];
  if (options.model && options.model.length > 0) {
    const filtered = filterModels(resolved, options.model);
    models = filtered.matched;
    unmatched = filtered.unmatched;
  }

  const reports = models.map(reportFor);
  const ok =
    rootErrors.length === 0 &&
    missing.length === 0 &&
    unmatched.length === 0 &&
    reports.every((r) => r.ok);

  if (options.json) {
    logger.json({
      workspace: workspace.workspace.name,
      ok,
      rootErrors,
      missing,
      unmatched,
      models: reports,
    });
  } else {
    logger.info(chalk.bold(`Workspace: ${workspace.workspace.name}`));
    for (const err of rootErrors) {
      logger.info(`  ${chalk.red("error")}  ${err}`);
    }
    for (const m of missing) {
      logger.info(`  ${chalk.red("error")}  model path not found or has no cirron config: ${m}`);
    }
    for (const u of unmatched) {
      logger.info(`  ${chalk.red("error")}  --model "${u}" did not match any model in the workspace`);
    }
    if (reports.length === 0 && missing.length === 0 && rootErrors.length === 0) {
      logger.info("  no models to validate");
    }
    for (const report of reports) {
      printModelReport(report);
    }
    const passed = reports.filter((r) => r.ok).length;
    logger.info("");
    logger.info(
      ok
        ? chalk.green(`All ${passed} model(s) valid.`)
        : chalk.red(`${passed}/${reports.length} model(s) valid; workspace validation failed.`)
    );
  }

  if (!ok) {
    process.exit(1);
  }
}

export async function validateCommand(
  options: ValidateOptions = {}
): Promise<void> {
  const detected = detectMode(options.dir);

  if (detected.mode === "none") {
    logger.error(
      "No cirron config found (cirron.yaml, cirron.yml, or cirron.json)"
    );
    logger.info(`Run ${chalk.cyan("cirron init")} to create a new project.`);
    process.exit(1);
    return;
  }

  if (detected.mode === "single") {
    await runSingleMode(detected.project.config, options);
    return;
  }

  await runMonorepoMode(
    detected.workspace.config,
    detected.workspace.configPath.replace(/[\\/][^\\/]+$/, "") || detected.rootDir,
    options
  );
}
