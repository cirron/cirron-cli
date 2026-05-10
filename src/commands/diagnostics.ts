import chalk from "chalk";
import ora from "ora";
import type { CirronConfig, GlobalSettings, ProjectSettings } from "../types";
import { CirronApi } from "../utils/api";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import { settingsManager } from "../utils/settings";

interface DiagnosticsOptions {
  json?: boolean;
  verbose?: boolean;
}

interface DiagnosticResult {
  details?: any;
  message: string;
  status: "ok" | "warning" | "error";
}

interface DiagnosticsReport {
  configuration: {
    apiUrl: string;
    tokenStatus: DiagnosticResult;
    timeout: number;
    retries: number;
    configPath: string;
    configExists: boolean;
  };
  connectivity: {
    status: DiagnosticResult;
    mode: "online" | "offline";
    details?: any;
  };
  errors: string[];
  settings: {
    global: {
      status: DiagnosticResult;
      settings?: GlobalSettings;
    };
    project: {
      status: DiagnosticResult;
      settings?: ProjectSettings;
    };
    effective: any;
  };
  validation: {
    config: DiagnosticResult;
    settings: DiagnosticResult;
    versions: DiagnosticResult;
  };
  warnings: string[];
}

export async function diagnosticsCommand(
  options: DiagnosticsOptions
): Promise<void> {
  try {
    const report = await generateDiagnosticsReport();

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      displayHumanReadableReport(report, options.verbose);
    }

    // Exit with non-zero code if errors exist
    if (report.errors.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error("Diagnostics command failed:", error);
    process.exit(1);
  }
}

async function generateDiagnosticsReport(): Promise<DiagnosticsReport> {
  const config = new ConfigManager();
  const currentConfig = config.load();

  const report: DiagnosticsReport = {
    configuration: await analyzeConfiguration(config, currentConfig),
    settings: analyzeSettings(),
    connectivity: await testConnectivity(currentConfig),
    validation: await validateConfigurations(config, currentConfig),
    warnings: [],
    errors: [],
  };

  // Collect warnings and errors
  collectIssues(report);

  return report;
}

async function analyzeConfiguration(
  config: ConfigManager,
  currentConfig: CirronConfig
) {
  const tokenStatus = analyzeTokenStatus(currentConfig);

  return {
    apiUrl: currentConfig.apiUrl,
    tokenStatus,
    timeout: currentConfig.timeout,
    retries: currentConfig.retries,
    configPath: config.getConfigPath(),
    configExists: config.exists(),
  };
}

function analyzeTokenStatus(config: CirronConfig): DiagnosticResult {
  // Check JWT auth first
  if (config.auth?.accessToken) {
    const expiresAt = config.auth.expiresAt
      ? new Date(config.auth.expiresAt)
      : null;
    const now = new Date();

    if (expiresAt && expiresAt > now) {
      const daysUntilExpiry = Math.ceil(
        (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysUntilExpiry <= 7) {
        return {
          status: "warning",
          message: `Token expires in ${daysUntilExpiry} days`,
          details: {
            type: "jwt",
            expiresAt: expiresAt.toISOString(),
            hasRefreshToken: !!config.auth.refreshToken,
          },
        };
      }

      return {
        status: "ok",
        message: "Authenticated with JWT token",
        details: {
          type: "jwt",
          expiresAt: expiresAt.toISOString(),
          hasRefreshToken: !!config.auth.refreshToken,
        },
      };
    }
    if (expiresAt) {
      return {
        status: "error",
        message: "JWT token has expired",
        details: {
          type: "jwt",
          expiresAt: expiresAt.toISOString(),
          hasRefreshToken: !!config.auth.refreshToken,
        },
      };
    }
  }

  // Check legacy token
  if (config.token) {
    return {
      status: "ok",
      message: "Authenticated with legacy token",
      details: {
        type: "legacy",
        tokenPrefix: config.token.substring(0, 8) + "...",
      },
    };
  }

  return {
    status: "warning",
    message: "Not authenticated",
    details: { type: "none" },
  };
}

function analyzeSettings() {
  const globalSettings = settingsManager.loadGlobalSettings();
  const projectSettings = settingsManager.loadProjectSettings();

  // Create effective settings by merging global and project
  const effectiveSettings = createEffectiveSettings(
    globalSettings,
    projectSettings || undefined
  );

  const projectResult: {
    status: DiagnosticResult;
    settings?: ProjectSettings;
  } = {
    status: projectSettings
      ? {
          status: "ok" as const,
          message: "Project settings loaded successfully",
        }
      : {
          status: "warning" as const,
          message: "No project settings found (not in a project directory)",
        },
  };

  if (projectSettings) {
    projectResult.settings = projectSettings;
  }

  return {
    global: {
      status: {
        status: "ok" as const,
        message: "Global settings loaded successfully",
      },
      settings: globalSettings,
    },
    project: projectResult,
    effective: effectiveSettings,
  };
}

function createEffectiveSettings(
  global: GlobalSettings,
  project?: ProjectSettings
) {
  // Merge global and project settings, with project taking precedence
  const effective: any = {
    api: global.api,
    general: global.general,
    ui: global.ui,
    development: global.development,
    cloud: global.cloud,
  };

  if (project) {
    // Project settings override global where applicable
    effective.build = project.build;
    effective.test = project.test;
    effective.deployment = project.deployment;

    // Override global settings with project equivalents
    effective.general = { ...effective.general, ...project.general };
  }

  return effective;
}

async function testConnectivity(config: CirronConfig): Promise<any> {
  const spinner = ora("Testing API connectivity...").start();

  // Temporarily suppress console warnings during API test
  const originalWarn = console.warn;
  console.warn = () => {}; // Suppress warnings during diagnostics

  try {
    // Set a shorter timeout for diagnostics to avoid hanging
    const diagConfig = { ...config, timeout: 10_000 }; // 10 second timeout
    const diagApi = new CirronApi(diagConfig);

    const authInfo = await diagApi.verifyAuth();

    spinner.stop();

    if (authInfo.valid) {
      return {
        status: {
          status: "ok" as const,
          message: "API connection successful",
        },
        mode: "online" as const,
        details: {
          apiUrl: config.apiUrl,
          authenticated: true,
          user: authInfo.user,
          organization: authInfo.organization,
        },
      };
    }
    return {
      status: {
        status: "warning" as const,
        message: "API reachable but authentication failed",
      },
      mode: "offline" as const,
      details: {
        apiUrl: config.apiUrl,
        authenticated: false,
      },
    };
  } catch (error) {
    spinner.stop();

    // Check if it's a token refresh error (indicating expired/invalid token)
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const isAuthError =
      errorMessage.includes("refresh token") ||
      errorMessage.includes("token") ||
      errorMessage.includes("401") ||
      errorMessage.includes("403");

    return {
      status: {
        status: isAuthError ? "warning" : "warning",
        message: isAuthError
          ? "Authentication token invalid or expired"
          : "API connection failed - running in local-only mode",
      },
      mode: "offline" as const,
      details: {
        apiUrl: config.apiUrl,
        error: errorMessage,
        authRelated: isAuthError,
      },
    };
  } finally {
    // Restore original console.warn
    console.warn = originalWarn;
  }
}

async function validateConfigurations(
  _config: ConfigManager,
  currentConfig: CirronConfig
) {
  const validation = {
    config: validateConfig(currentConfig),
    settings: validateSettings(),
    versions: validateVersions(currentConfig),
  };

  return validation;
}

function validateConfig(config: CirronConfig): DiagnosticResult {
  const issues: string[] = [];

  // Validate API URL
  try {
    new URL(config.apiUrl);
  } catch {
    issues.push("Invalid API URL format");
  }

  // Validate timeout
  if (config.timeout < 1000 || config.timeout > 300_000) {
    issues.push("Timeout should be between 1000 and 300000ms");
  }

  // Validate retries
  if (config.retries < 0 || config.retries > 10) {
    issues.push("Retries should be between 0 and 10");
  }

  if (issues.length > 0) {
    return {
      status: "warning",
      message: `Configuration has ${issues.length} issue(s)`,
      details: issues,
    };
  }

  return {
    status: "ok",
    message: "Configuration is valid",
  };
}

function validateSettings(): DiagnosticResult {
  try {
    // Load settings to validate they can be parsed
    settingsManager.loadGlobalSettings();
    settingsManager.loadProjectSettings();

    // Basic validation - if we can load them, they're likely valid
    // More detailed validation would require schema validation
    return {
      status: "ok",
      message: "Settings files are valid",
    };
  } catch (error) {
    return {
      status: "error",
      message: "Settings validation failed",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function validateVersions(config: CirronConfig): DiagnosticResult {
  const issues: string[] = [];

  // Check for version mismatches
  if (config.version && config.version !== 1) {
    issues.push(
      `Config version ${config.version} may not be compatible (expected: 1)`
    );
  }

  if (issues.length > 0) {
    return {
      status: "warning",
      message: "Version compatibility issues found",
      details: issues,
    };
  }

  return {
    status: "ok",
    message: "No version mismatches detected",
  };
}

function collectIssues(report: DiagnosticsReport): void {
  // Collect all warnings and errors from the report
  const checkResult = (result: DiagnosticResult, context: string) => {
    if (result.status === "warning") {
      report.warnings.push(`${context}: ${result.message}`);
    } else if (result.status === "error") {
      report.errors.push(`${context}: ${result.message}`);
    }
  };

  checkResult(report.configuration.tokenStatus, "Authentication");
  checkResult(report.settings.global.status, "Global Settings");
  checkResult(report.settings.project.status, "Project Settings");
  checkResult(report.connectivity.status, "API Connectivity");
  checkResult(report.validation.config, "Configuration Validation");
  checkResult(report.validation.settings, "Settings Validation");
  checkResult(report.validation.versions, "Version Compatibility");
}

function displayHumanReadableReport(
  report: DiagnosticsReport,
  verbose = false
): void {
  console.log();
  logger.info(chalk.bold("Cirron CLI Diagnostics Report"));
  console.log();

  // Configuration Section
  displaySection("Configuration", [
    { label: "API URL", value: report.configuration.apiUrl, status: "ok" },
    {
      label: "Authentication",
      value: report.configuration.tokenStatus.message,
      status: report.configuration.tokenStatus.status,
    },
    {
      label: "Timeout",
      value: `${report.configuration.timeout}ms`,
      status: "ok",
    },
    {
      label: "Retries",
      value: report.configuration.retries.toString(),
      status: "ok",
    },
    {
      label: "Config File",
      value: report.configuration.configExists ? "Found" : "Not Found",
      status: report.configuration.configExists ? "ok" : "warning",
    },
  ]);

  // Settings Section
  displaySection("Settings", [
    {
      label: "Global Settings",
      value: report.settings.global.status.message,
      status: report.settings.global.status.status,
    },
    {
      label: "Project Settings",
      value: report.settings.project.status.message,
      status: report.settings.project.status.status,
    },
  ]);

  // Connectivity Section
  displaySection("Connectivity", [
    {
      label: "Mode",
      value: report.connectivity.mode === "online" ? "Online" : "Local-only",
      status: report.connectivity.status.status,
    },
    {
      label: "API Status",
      value: report.connectivity.status.message,
      status: report.connectivity.status.status,
    },
  ]);

  // Validation Section
  displaySection("Validation", [
    {
      label: "Configuration",
      value: report.validation.config.message,
      status: report.validation.config.status,
    },
    {
      label: "Settings",
      value: report.validation.settings.message,
      status: report.validation.settings.status,
    },
    {
      label: "Versions",
      value: report.validation.versions.message,
      status: report.validation.versions.status,
    },
  ]);

  // Summary
  displaySummary(report);

  // Verbose output
  if (verbose) {
    displayVerboseInfo(report);
  }
}

function displaySection(
  title: string,
  items: Array<{ label: string; value: string; status: string }>
): void {
  logger.info(chalk.cyan(`${title}:`));

  items.forEach((item) => {
    const statusIndicator = getStatusIndicator(item.status);
    logger.info(`  ${item.label.padEnd(20)} ${statusIndicator} ${item.value}`);
  });

  console.log();
}

function displaySummary(report: DiagnosticsReport): void {
  if (report.errors.length > 0 || report.warnings.length > 0) {
    logger.info(chalk.cyan("Issues Summary:"));

    if (report.errors.length > 0) {
      logger.info(chalk.red(`  Errors (${report.errors.length}):`));
      report.errors.forEach((error) => {
        logger.info(`    - ${error}`);
      });
    }

    if (report.warnings.length > 0) {
      logger.info(chalk.yellow(`  Warnings (${report.warnings.length}):`));
      report.warnings.forEach((warning) => {
        logger.info(`    - ${warning}`);
      });
    }

    console.log();
  } else {
    logger.info(chalk.green("All diagnostics passed successfully"));
    console.log();
  }
}

function displayVerboseInfo(report: DiagnosticsReport): void {
  console.log(); // Add spacing
  logger.info(chalk.cyan("Detailed Information:"));

  if (report.configuration.tokenStatus.details) {
    logger.info("  Token Details:");
    logger.info(`    Type: ${report.configuration.tokenStatus.details.type}`);
    if (report.configuration.tokenStatus.details.expiresAt) {
      logger.info(
        `    Expires: ${new Date(report.configuration.tokenStatus.details.expiresAt).toLocaleString()}`
      );
    }
    if (
      report.configuration.tokenStatus.details.hasRefreshToken !== undefined
    ) {
      logger.info(
        `    Has Refresh Token: ${report.configuration.tokenStatus.details.hasRefreshToken ? "Yes" : "No"}`
      );
    }
  }

  if (report.connectivity.details) {
    logger.info("  Connectivity Details:");
    if (report.connectivity.details.user) {
      logger.info(`    User: ${report.connectivity.details.user.email}`);
    }
    if (report.connectivity.details.organization) {
      logger.info(
        `    Organization: ${report.connectivity.details.organization.name}`
      );
    }
  }

  logger.info("  Configuration Path:");
  logger.info(`    ${report.configuration.configPath}`);

  console.log();
}

function getStatusIndicator(status: string): string {
  switch (status) {
    case "ok":
      return chalk.green("[OK]");
    case "warning":
      return chalk.yellow("[WARNING]");
    case "error":
      return chalk.red("[ERROR]");
    default:
      return chalk.gray("[UNKNOWN]");
  }
}
