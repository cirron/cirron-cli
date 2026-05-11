#!/usr/bin/env node

import { Command } from "commander";
import {
  authCommand,
  loginCommand,
  logoutCommand,
  refreshCommand,
} from "./commands/auth";
import { buildCommand } from "./commands/build";
import { compileCommand } from "./commands/compile";
import { configCommand } from "./commands/config";
import { deployCommand } from "./commands/deploy";
import { diagnosticsCommand } from "./commands/diagnostics";
import { doctorCommand } from "./commands/doctor";
import { hardwareCommand } from "./commands/hardware";
import { infoCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { lintCommand } from "./commands/lint";
import { listCommand } from "./commands/list";
import {
  planBuildCommand,
  planCompileCommand,
  planDiffCommand,
  planSaveCommand,
} from "./commands/plan";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { replayCommand } from "./commands/replay";
import {
  runCancelCommand,
  runInferenceCommand,
  runJobCommand,
  runListCommand,
  runLogsCommand,
  runPipelineCommand,
  runStatusCommand,
  runSweepCommand,
} from "./commands/run";
import {
  spoolClearCommand,
  spoolFlushCommand,
  spoolInspectCommand,
} from "./commands/spool";
import { syncCommand } from "./commands/sync";
import { testCommand } from "./commands/test";
import {
  tracesClearCommand,
  tracesExportCommand,
  tracesListCommand,
  tracesSnapshotCommand,
  tracesSnapshotsCommand,
  tracesViewCommand,
} from "./commands/traces";
import { handlePlatformError } from "./utils/api-errors";
import { logger } from "./utils/logger";
import { CLI_VERSION } from "./utils/version";

const program = new Command();

// Global error handling — platform errors get a clean single-line message,
// anything else falls back to a generic dump for visibility.
process.on("uncaughtException", (error) => {
  if (handlePlatformError(error)) {
    return;
  }
  logger.error("Uncaught exception:", error.message);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  if (handlePlatformError(error)) {
    return;
  }
  logger.error("Unhandled rejection:", error);
  process.exit(1);
});

program
  .name("cirron")
  .description("Cirron CLI - Build, deploy, and manage your projects with ease")
  .version(CLI_VERSION)
  .option("-v, --verbose", "Enable verbose logging")
  .option("--config <path>", "Path to config file")
  .hook("preAction", (thisCommand) => {
    const options = thisCommand.opts();
    if (options["verbose"]) {
      process.env["CIRRON_VERBOSE"] = "true";
    }
  });

// Auth commands
const authCmd = program.command("auth").description("Authentication commands");

authCmd
  .command("login")
  .description("Login to Cirron")
  .option("-t, --token <token>", "API token")
  .option("-u, --url <url>", "API URL (default: https://app.cirron.com)")
  .action(loginCommand);

authCmd
  .command("logout")
  .description("Logout from Cirron")
  .action(logoutCommand);

authCmd
  .command("status")
  .description("Show authentication status")
  .action(authCommand);

authCmd
  .command("refresh")
  .description("Refresh authentication token")
  .action(refreshCommand);

// Init command
program
  .command("init")
  .description("Initialize a new Cirron project")
  .argument("[name]", "Project name")
  .option(
    "-t, --template <template>",
    "Project template (pytorch, tensorflow, sklearn, pytorch-train, tensorflow-train, sklearn-pipeline, custom)"
  )
  .option("-f, --force", "Force initialization in non-empty directory")
  .option("--no-install", "Skip package installation")
  .option("--git", "Initialize git repository")
  .action(initCommand);

// Register command
program
  .command("register")
  .description("Register an existing project with Cirron")
  .option("-n, --name <name>", "Override project name from config")
  .option("--repo <repository>", "Associate with a connected repository")
  .option("-p, --path <path>", "Path scope within repository (for monorepos)")
  .option(
    "-d, --dir <directory>",
    "Project directory to load config from (default: current directory)"
  )
  .option("--dry-run", "Show registration payload without calling API")
  .action(async (options) => {
    try {
      const { registerCommand } = await import("./commands/register");
      await registerCommand(options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load register command:", error);
      process.exit(1);
    }
  });

// Test command
program
  .command("test")
  .description("Run tests for your ML project")
  .option("--env", "Test environment setup (Python, CUDA, etc.)")
  .option("--build", "Test container build")
  .option("--requirements", "Test Python requirements")
  .option("--unit", "Run unit tests")
  .option("--lint", "Run code quality checks")
  .option("--model", "Test model loading and instantiation")
  .option("--data", "Test data loading")
  .option("--inference", "Test model inference")
  .option("-v, --val", "Run validation tests on model accuracy")
  .option("-p, --path <path>", "Path to validation data (file or folder)")
  .option(
    "-e, --endpoint <url>",
    "Test deployment endpoint for speed, accuracy, and latency"
  )
  .option("--pipeline", "Test entire ML pipeline end-to-end")
  .option("-w, --watch", "Watch for changes and re-run tests")
  .option("--json", "Output results in JSON format")
  .option(
    "--strict",
    "Enable strict mode - fail fast on any errors (useful for CI)"
  )
  .option(
    "-i, --interactive",
    "Enable interactive mode with step-by-step confirmations"
  )
  .action(testCommand);

// Compile command
program
  .command("compile")
  .description("Compile the model (build the model locally)")
  .option("-a, --arch <architecture>", "Select a specific architecture")
  .option("--index <file>", "Path to index/manifest file")
  .option("--validate", "Run data/model integrity checks")
  .option(
    "--strict",
    "Enable strict mode - fail fast on any errors (useful for CI)"
  )
  .option(
    "-i, --interactive",
    "Enable interactive mode with step-by-step confirmations"
  )
  .action(compileCommand);

// Build command
program
  .command("build")
  .description("Build your ML project (full build with container)")
  .option("-e, --env <environment>", "Environment to build for", "development")
  .option(
    "-w, --watch",
    "Watch for changes and rebuild (traditional projects only)"
  )
  .option("-t, --tag <tag>", "Container image tag")
  .option("--clean", "Clean build (no cache)")
  .option("--push", "Push image to registry after build")
  .option("--analyze", "Analyze build output")
  .option("-a, --arch <architecture>", "Select a specific architecture")
  .option("--index <file>", "Path to index/manifest file")
  .option("--validate", "Run data/model integrity checks")
  .option(
    "--strict",
    "Enable strict mode - fail fast on any errors (useful for CI)"
  )
  .option("-f, --force", "Force build despite validation errors and warnings")
  .option(
    "-i, --interactive",
    "Enable interactive mode with step-by-step confirmations"
  )
  .action(buildCommand);

// Deploy command
program
  .command("deploy")
  .description("Deploy your Cirron project")
  .option("-e, --env <environment>", "Environment to deploy to", "production")
  .option("-f, --force", "Force deployment without confirmation")
  .option("--no-build", "Skip build step")
  .option("--rollback", "Rollback to previous deployment")
  .option("-m, --message <message>", "Deployment message")
  .action(deployCommand);

// Config command (merged: CLI config + settings + hardware subcommand)
const configCmd = program
  .command("config")
  .description("Manage CLI, global, and project configuration")
  .enablePositionalOptions()
  .option("--scope <scope>", "Configuration scope (cli, global, project)")
  .option("-l, --list", "List configuration")
  .option("-g, --get <key>", "Get configuration value")
  .option("-s, --set <key=value>", "Set configuration value")
  .option("-d, --delete <key>", "Delete configuration key")
  .option("--reset", "Reset configuration to defaults")
  .option("-e, --edit", "Interactive configuration editor")
  .option("--explain <key>", "Show setting resolution chain")
  .option("--export <file>", "Export configuration to file")
  .option("--import <file>", "Import configuration from file")
  .option("-t, --template <name>", "Apply settings template")
  .option("--verbose", "Verbose output")
  .option("--json", "Output in JSON format")
  .action(configCommand);

// Hardware subcommand of config
configCmd
  .command("hardware")
  .description("Manage hardware configuration for ML models")
  .option("--detect", "Detect current device hardware")
  .option("--configure", "Configure hardware interactively")
  .option("--list", "List available hardware profiles")
  .option("--profile <name>", "Use specific hardware profile")
  .option("--save [filename]", "Save hardware configuration to file")
  .option("--from <path>", "Load hardware configuration from file")
  .option("--current", "Use current device specifications")
  .option("--json", "Output in JSON format")
  .option("--verbose", "Show detailed information")
  .action(hardwareCommand);

// Info command (with diagnostics and hardware flags)
program
  .command("info")
  .description("Show model information, diagnostics, and hardware details")
  .option("--update <type>", "Update specific information (metadata)")
  .option("--dry-run", "Preview changes without applying them")
  .option(
    "--diagnostics",
    "Run diagnostic checks on configuration and connectivity"
  )
  .option("--hardware", "Show hardware information")
  .option("--json", "Output in JSON format")
  .option("--detailed", "Show detailed information")
  .action(async (options) => {
    if (options.diagnostics) {
      return diagnosticsCommand({
        json: options.json,
        verbose: options.detailed,
      });
    }
    if (options.hardware) {
      return hardwareCommand({
        detect: true,
        json: options.json,
        verbose: options.detailed,
      });
    }
    return infoCommand(options);
  });

// Doctor command
program
  .command("doctor")
  .description(
    "Diagnose the local Cirron SDK environment: installed extras, config, spool, platform connectivity"
  )
  .option("--json", "Output diagnostic report as JSON")
  .option("--venv <path>", "Override the Python environment to inspect")
  .option("--no-color", "Disable colored output")
  .option("--strict", "Exit non-zero when no Python environment is detected")
  .action((options) =>
    doctorCommand({ ...options, noColor: options.color === false })
  );

// Lint command
program
  .command("lint")
  .description("Run linting checks for config and project health")
  .option("--config", "Lint project configuration only")
  .option("--structure", "Check project structure only")
  .option("--dependencies", "Validate dependencies only")
  .option("--code", "Run code quality checks only")
  .option("--all", "Run all lint checks (default)")
  .option("--fix", "Automatically fix issues where possible")
  .option("--verbose", "Show detailed output with suggestions")
  .option("--json", "Output results in JSON format")
  .option(
    "--strict",
    "Enable strict mode - fail fast on any errors (useful for CI)"
  )
  .action(lintCommand);

// Plan commands
const planCmd = program
  .command("plan")
  .description("Preview and plan project operations")
  .action(() => {
    planCmd.outputHelp();
  });

planCmd
  .command("compile")
  .description("Preview model compilation with artifact paths and dependencies")
  .option("-a, --arch <architecture>", "Select a specific architecture")
  .option("--index <file>", "Path to index/manifest file")
  .option("--validate", "Run validation checks during planning")
  .option("--save [filename]", "Save plan to file")
  .option("--verbose", "Show detailed planning information")
  .option("--json", "Output plan in JSON format")
  .option(
    "-i, --interactive",
    "Enable interactive mode with step-by-step confirmations"
  )
  .action(planCompileCommand);

planCmd
  .command("build")
  .description("Preview build artifacts, model shape, and resource usage")
  .option("-a, --arch <architecture>", "Select a specific architecture")
  .option("--index <file>", "Path to index/manifest file")
  .option("--validate", "Run validation checks during planning")
  .option("--save [filename]", "Save plan to file")
  .option("--verbose", "Show detailed planning information")
  .option("--json", "Output plan in JSON format")
  .option(
    "-i, --interactive",
    "Enable interactive mode with step-by-step confirmations"
  )
  .action(planBuildCommand);

planCmd
  .command("diff <planA> <planB>")
  .description("Compare two plan files to detect changes and impacts")
  .option("--save [filename]", "Save comparison to file")
  .option("--verbose", "Show detailed diff information")
  .option("--json", "Output comparison in JSON format")
  .action(planDiffCommand);

planCmd
  .command("save [type]")
  .description("Save plans to disk for later comparison and auditing")
  .option("--all", "Save all plan types (compile, build)")
  .option("--name <filename>", "Custom filename for the saved plan")
  .option("--description <desc>", "Description for the saved plan")
  .option("--tags <tags>", "Comma-separated tags for the saved plan")
  .option("--list", "List all saved plans")
  .option(
    "--cleanup [days]",
    "Remove plans older than specified days (default: 30)"
  )
  .option("--verbose", "Show detailed save information")
  .option("--json", "Output plan in JSON format")
  .action(planSaveCommand);

// Replay (moved under plan)
planCmd
  .command("replay")
  .description("Execute saved plan from file")
  .requiredOption("--plan <file>", "Plan file to replay")
  .option("--validate", "Validate environment compatibility (default: true)")
  .option("--dry-run", "Show what would be executed without running")
  .option("--verbose", "Show detailed execution information")
  .option("--force", "Force execution despite compatibility warnings")
  .action(replayCommand);

// Run commands (stubs)
const runCmd = program
  .command("run")
  .description("Training runs, pipeline executions, and job management");

runCmd
  .command("pipeline [name]")
  .description("Trigger a pipeline run")
  .option("-c, --config <file>", "Pipeline config file (YAML/JSON)")
  .option("--gpu <type>", "GPU type override")
  .option("--priority <level>", "Job priority (low, normal, high, critical)")
  .option("--tag <tags>", "Comma-separated run tags")
  .option("--dry-run", "Show what would execute without running")
  .option("--watch", "Stream output and wait for completion")
  .action(runPipelineCommand);

runCmd
  .command("job")
  .description("Execute a single-task job")
  .option("-c, --config <file>", "Job config file")
  .option("--gpu <type>", "GPU type override")
  .option("--priority <level>", "Job priority")
  .option("--dry-run", "Show what would execute without running")
  .action(runJobCommand);

runCmd
  .command("inference [deployment]")
  .description("Trigger batch inference")
  .option("-i, --input <path>", "Input data path")
  .option("-o, --output <path>", "Output path")
  .option("--model <name>", "Model name/version to use")
  .option("--batch-size <n>", "Batch size override")
  .option("--watch", "Stream output")
  .action(runInferenceCommand);

runCmd
  .command("sweep")
  .description("Trigger hyperparameter sweep")
  .option("-c, --config <file>", "Sweep config file")
  .option("--trials <n>", "Number of trials")
  .option("--parallel <n>", "Max parallel trials")
  .option("--strategy <type>", "Search strategy (grid, random, bayesian)")
  .option("--watch", "Stream output")
  .action(runSweepCommand);

runCmd
  .command("list")
  .description("List all runs and jobs")
  .option(
    "--status <status>",
    "Filter by status (running, completed, failed, cancelled)"
  )
  .option("--last <n>", "Show last N runs")
  .option("--pipeline <name>", "Filter by pipeline")
  .option("--json", "Output in JSON format")
  .action(runListCommand);

runCmd
  .command("status <runId>")
  .description("Get run status")
  .option("--json", "Output in JSON format")
  .option("--watch", "Poll for updates")
  .action(runStatusCommand);

runCmd
  .command("cancel <runId>")
  .description("Cancel a running job")
  .option("--force", "Force cancel without confirmation")
  .action(runCancelCommand);

runCmd
  .command("logs <runId>")
  .description("Stream run logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <number>", "Number of lines to show")
  .action(runLogsCommand);

// Push command
program
  .command("push [resource] [name]")
  .description("Push artifacts to registry (model, image, build, runtime)")
  .option("-t, --tag <tag>", "Version tag")
  .option("-m, --message <message>", "Push message for audit log")
  .option("--all", "Push all files defined in cirron.json")
  .option("--ignore <patterns>", "Glob patterns to exclude")
  .option("--registry <url>", "Override registry URL")
  .option("-f, --force", "Overwrite existing version / skip dedupe")
  .option("--dry-run", "Show what would be pushed")
  .option("--json", "Output in JSON format")
  .action(pushCommand);

// Pull command
program
  .command("pull [resource] [name]")
  .description("Pull artifacts from registry (model, image, build, runtime)")
  .option("-t, --tag <tag>", "Version tag (default: latest)")
  .option("-o, --output <path>", "Output directory")
  .option("--all", "Pull all resources for current project")
  .option("--type <type>", "Filter --all by resource type")
  .option("--ignore <patterns>", "Glob patterns to exclude")
  .option("--registry <url>", "Override registry URL")
  .option("-f, --force", "Overwrite local files without prompting")
  .option("-i, --interactive", "Guided pull flow")
  .option("--json", "Output in JSON format")
  .option("--dry-run", "Show what would be pulled")
  .action(pullCommand);

// Sync command (stub)
program
  .command("sync [path]")
  .description("Bidirectional state sync with conflict resolution")
  .option("--dry-run", "Show what would change without writing")
  .option("--push-only", "Only push local changes")
  .option("--pull-only", "Only pull remote changes")
  .option(
    "--conflicts <strategy>",
    "Conflict resolution strategy (keep-both, local-wins, remote-wins, prompt)"
  )
  .option(
    "-f, --force",
    "Skip conflict resolution (requires --push-only or --pull-only)"
  )
  .option("--exclude <patterns>", "Comma-separated glob patterns to exclude")
  .option("--verbose", "Show detailed sync information")
  .option("--json", "Output in JSON format")
  .action(syncCommand);

// List command (with runs and pipelines support)
program
  .command("list <resource>")
  .description(
    "List resources (deployments, builds, models, images, registry, runs, pipelines)"
  )
  .option("--json", "Output in JSON format")
  .option("-l, --limit <number>", "Number of items to show", "20")
  .option("-f, --filter <filter>", "Filter resources")
  .option("--all", "Show all items (no limit)")
  .action(async (resource: string, options: any) => {
    if (resource === "runs") {
      return runListCommand(options);
    }
    if (resource === "pipelines") {
      logger.info("This command is not yet implemented.");
      return;
    }
    return listCommand(resource, options);
  });

// Status command
program
  .command("status")
  .description("Show project status")
  .option("-r, --remote", "Include remote status")
  .action(async (options) => {
    try {
      const { statusCommand } = await import("./commands/status");
      await statusCommand(options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load status command:", error);
      process.exit(1);
    }
  });

// Logs command
program
  .command("logs")
  .description("View deployment logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <number>", "Number of lines to show", "100")
  .option("--env <environment>", "Environment to get logs from", "production")
  .action(async (options) => {
    try {
      const { logsCommand } = await import("./commands/logs");
      await logsCommand(options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load logs command:", error);
      process.exit(1);
    }
  });

// Env command
const envCmd = program
  .command("env")
  .description("Manage environment variables");

envCmd
  .command("list")
  .description("List environment variables")
  .option("--env <environment>", "Environment", "production")
  .action(async (options) => {
    try {
      const { envListCommand } = await import("./commands/env");
      await envListCommand(options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load env list command:", error);
      process.exit(1);
    }
  });

envCmd
  .command("set")
  .description("Set environment variable")
  .argument("<key>", "Variable name")
  .argument("<value>", "Variable value")
  .option("--env <environment>", "Environment", "production")
  .action(async (key, value, options) => {
    try {
      const { envSetCommand } = await import("./commands/env");
      await envSetCommand(key, value, options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load env set command:", error);
      process.exit(1);
    }
  });

envCmd
  .command("delete")
  .description("Delete environment variable")
  .argument("<key>", "Variable name")
  .option("--env <environment>", "Environment", "production")
  .action(async (key, options) => {
    try {
      const { envDeleteCommand } = await import("./commands/env");
      await envDeleteCommand(key, options);
    } catch (error) {
      handlePlatformError(error);
      logger.error("Failed to load env delete command:", error);
      process.exit(1);
    }
  });

// Spool command
const spoolCmd = program
  .command("spool")
  .description("Manage local SDK spool (./.cirron/spool/)");

spoolCmd
  .command("inspect")
  .description("Show spool file count, size, oldest/newest timestamps")
  .option("--dir <path>", "Override spool directory (default: ./.cirron/spool)")
  .option("--json", "Output in JSON format")
  .action(spoolInspectCommand);

spoolCmd
  .command("flush")
  .description("Upload spool batches to the platform and delete on success")
  .option("--dir <path>", "Override spool directory (default: ./.cirron/spool)")
  .action(spoolFlushCommand);

spoolCmd
  .command("clear")
  .description("Delete all spool files (prompts for confirmation)")
  .option("--dir <path>", "Override spool directory (default: ./.cirron/spool)")
  .option("--force", "Skip confirmation prompt")
  .action(spoolClearCommand);

// Traces command group (SDK-51) — semantic view of local spool sessions,
// plus export to Parquet / OpenTelemetry / CSV / JSON. Reads the same
// files as `cirron spool` but reconstructs the scope tree and handles
// snapshot directories. See features/sdk-launch-stories.md SDK-51.
const tracesCmd = program
  .command("traces")
  .description("View and export local trace sessions");

tracesCmd
  .command("view")
  .description("Render the scope tree as a text flamegraph")
  .option("--last <n>", "Show the N most recent sessions (default: 1)")
  .option("--name <substr>", "Filter to spans whose name contains substring")
  .option(
    "--session <id>",
    "Show a specific session by id (prefix match allowed)"
  )
  .option("--depth <n>", "Collapse the tree below this depth")
  .option(
    "--min-wall <dur>",
    "Hide spans shorter than duration (e.g. 1ms, 500us)"
  )
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .option("--no-color", "Disable ANSI color output")
  .option("--json", "Emit tree as JSON instead of text")
  .action(tracesViewCommand);

tracesCmd
  .command("list")
  .description("List sessions in the local spool with counts and sizes")
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .option("--json", "Output in JSON format")
  .action(tracesListCommand);

tracesCmd
  .command("export")
  .description("Export local traces to parquet, otel, csv, or json")
  .requiredOption(
    "--format <fmt>",
    "Output format: parquet | otel | csv | json"
  )
  .option("--output <path>", "Output file (or directory for --format parquet)")
  .option("--session <id>", "Export a specific session (prefix match allowed)")
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .action(tracesExportCommand);

tracesCmd
  .command("clear")
  .description("Delete sessions and their snapshot dirs")
  .option("--before <iso-date>", "Delete sessions started before this ISO date")
  .option("--keep <n>", "Keep the N most recent (non-live) sessions")
  .option("--yes", "Skip confirmation prompt")
  .option("--no-prune-orphans", "Do not sweep orphan snapshot directories")
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .action(tracesClearCommand);

tracesCmd
  .command("snapshots [spanId]")
  .description("List weight/gradient snapshots grouped by span")
  .option("--session <id>", "Scope to a session id (prefix match allowed)")
  .option("--span <id>", "Scope to a span id (prefix match allowed)")
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .option("--json", "Output in JSON format")
  .action(tracesSnapshotsCommand);

tracesCmd
  .command("snapshot <spanId> [tensorName]")
  .description(
    "Inspect snapshots for a span: stats, histogram, safetensors header, optional tensor preview/export"
  )
  .option(
    "--spool <dir>",
    "Override spool directory (default: ./.cirron/spool)"
  )
  .option(
    "--file <path>",
    "Override which safetensors file to read (default: weights + gradients under the span dir)"
  )
  .option("--preview <n>", "Print the first N values of the selected tensor")
  .option("--tail <n>", "Print the last N values of the selected tensor")
  .option(
    "--export <path>",
    "Copy the safetensors blob(s) to this file or directory"
  )
  .option("--json", "Output in JSON format")
  .option("--no-color", "Disable ANSI color output")
  .action(tracesSnapshotCommand);

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
