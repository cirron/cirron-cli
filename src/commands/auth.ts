import chalk from "chalk";
import open from "open";
import ora from "ora";
import type { CirronConfig, DeviceTokenResponse } from "../types";
import { CirronApi } from "../utils/api";
import {
  handlePlatformError,
  PlatformBadRequestError,
  PlatformRateLimitError,
} from "../utils/api-errors";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";

interface LoginOptions {
  token?: string;
  url?: string;
}

/** Entry point for `cirron auth login`: device flow by default, or a direct token with `--token`. */
export async function loginCommand(options: LoginOptions): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    // Update API URL if provided
    if (options.url) {
      currentConfig.apiUrl = options.url;
    }

    // --token is the non-interactive path for CI/CD workflows.
    if (options.token) {
      return legacyTokenLogin(options, currentConfig, config);
    }

    // Default to device flow
    return deviceFlowLogin(currentConfig, config);
  } catch (error) {
    handlePlatformError(error);
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }

    process.exit(1);
  }
}

async function legacyTokenLogin(
  options: LoginOptions,
  currentConfig: CirronConfig,
  config: ConfigManager
): Promise<void> {
  const spinner = ora("Verifying token...").start();

  try {
    // Verify token with API
    const api = new CirronApi({
      apiUrl: currentConfig.apiUrl,
      token: options.token!,
      defaultEnv: currentConfig.defaultEnv,
      timeout: currentConfig.timeout,
      retries: currentConfig.retries,
    });

    const authInfo = await api.verifyAuth();

    if (!authInfo.valid) {
      throw new Error("Invalid token");
    }

    currentConfig.token = options.token!;
    config.save(currentConfig);

    spinner.succeed(chalk.green("Successfully authenticated!"));

    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
      if (authInfo.user.name) {
        logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
      }
    }

    logger.info(`API URL: ${chalk.cyan(currentConfig.apiUrl)}`);
  } catch (error) {
    spinner.fail(chalk.red("Authentication failed"));
    throw error;
  }
}

async function deviceFlowLogin(
  currentConfig: CirronConfig,
  config: ConfigManager
): Promise<void> {
  const spinner = ora("Starting device authorization...").start();

  try {
    const api = new CirronApi(currentConfig);

    // 1. Request device code
    const deviceAuth = await api.requestDeviceCode();

    // The server's window starts now, not when polling does, so the time the
    // user spends reading the code and opening the browser counts against it.
    const authorizationDeadline =
      Date.now() +
      (deviceAuth.expiresIn || DEFAULT_AUTHORIZATION_WINDOW_SECONDS) * 1000;

    spinner.succeed("Device code received");

    // 2. Display user code and instructions
    console.log();
    console.log(
      chalk.bold("First copy your one-time code: ") +
        chalk.cyan(deviceAuth.userCode)
    );
    console.log();
    console.log(
      `Press ${chalk.bold("Enter")} to open ${deviceAuth.verificationUrl} in your browser...`
    );

    // Wait for user to press Enter
    await new Promise((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(undefined);
      });
    });

    // 3. Open browser (fix URL if server returns null)
    const baseUrl = currentConfig.apiUrl.replace("/api", "").replace(/\/$/, ""); // Remove trailing slash
    const verificationUrl = deviceAuth.verificationUrl.startsWith("null/")
      ? deviceAuth.verificationUrl.replace("null/", `${baseUrl}/`)
      : deviceAuth.verificationUrl;

    console.log(`\nOpening ${verificationUrl} in your browser...`);
    await open(verificationUrl);

    // 4. Poll for authorization
    spinner.start("Waiting for authorization...");
    const result = await pollForAuthorization(
      api,
      deviceAuth.deviceCode,
      deviceAuth.interval,
      authorizationDeadline
    );

    // 5. Store tokens and verify
    await saveTokens(result, currentConfig, config);

    spinner.succeed(chalk.green("Authentication complete!"));

    // Show user info
    const authInfo = await api.verifyAuth();
    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
      if (authInfo.user.name) {
        logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
      }
    }
  } catch (error) {
    spinner.fail(chalk.red("Authentication failed"));
    throw error;
  }
}

/** Fallback window if the server omits `expiresIn` (RFC 8628 `expires_in`). */
const DEFAULT_AUTHORIZATION_WINDOW_SECONDS = 600;

/** Consecutive transport failures tolerated before giving up. */
const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 5;

/** Upper bound on how long we honor a server's Retry-After, in seconds. */
const MAX_RATE_LIMIT_BACKOFF_SECONDS = 30;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll the device endpoint until the user authorizes, the code expires, or the
 * window closes.
 *
 * The platform implements RFC 8628: while the user hasn't approved yet it
 * answers HTTP 400 with `{ error: "authorization_pending" }`, which the
 * transport turns into a PlatformBadRequestError whose message is the bare
 * error code. Pending is the normal case for most of the window, so it must
 * not consume any error budget. Only genuine transport failures do.
 */
async function pollForAuthorization(
  api: CirronApi,
  deviceCode: string,
  interval: number,
  deadline: number
): Promise<DeviceTokenResponse> {
  let consecutiveTransportErrors = 0;
  // Reset to `interval` each iteration; a 429 replaces it for one round so the
  // Retry-After delay isn't added on top of the normal poll interval.
  let delaySeconds = interval;

  while (Date.now() < deadline) {
    // Never sleep past the window. Otherwise the last iteration overshoots by
    // a full interval, or by a 429's Retry-After, before giving up.
    await sleep(Math.min(delaySeconds * 1000, deadline - Date.now()));
    delaySeconds = interval;

    try {
      const response = await api.pollDeviceAuthorization(deviceCode);

      if (response.accessToken && response.refreshToken) {
        return {
          access_token: response.accessToken,
          refresh_token: response.refreshToken,
          expires_in: response.expiresIn || 604_800,
          token_type: response.tokenType || "bearer",
        };
      }

      // A 200 without tokens isn't a shape the platform sends; treat it the
      // same as pending rather than failing the login over it.
      consecutiveTransportErrors = 0;
    } catch (error) {
      if (error instanceof PlatformRateLimitError) {
        delaySeconds = Math.min(
          Math.max(error.retryAfterSeconds ?? interval, interval),
          MAX_RATE_LIMIT_BACKOFF_SECONDS
        );
        continue;
      }

      if (error instanceof PlatformBadRequestError) {
        if (error.message === "authorization_pending") {
          consecutiveTransportErrors = 0;
          continue;
        }

        if (error.message === "access_denied") {
          throw new Error("Authorization was denied.");
        }

        // expired_token, or invalid_request once the server has dropped the
        // record (which is also what a denial looks like from here).
        throw new Error(
          "Authorization expired. Run cirron auth login to start again."
        );
      }

      consecutiveTransportErrors++;
      if (consecutiveTransportErrors > MAX_CONSECUTIVE_TRANSPORT_ERRORS) {
        throw error;
      }
    }
  }

  // Same outcome the user sees for an expired code, so give the same next step.
  throw new Error(
    "Authorization timed out. Run cirron auth login to try again."
  );
}

async function saveTokens(
  tokens: DeviceTokenResponse,
  currentConfig: CirronConfig,
  config: ConfigManager
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  currentConfig.auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  };

  config.save(currentConfig);
}

/** Entry point for `cirron auth logout`: clears stored credentials. */
export async function logoutCommand(): Promise<void> {
  const spinner = ora("Logging out...").start();

  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!(currentConfig.token || currentConfig.auth?.accessToken)) {
      spinner.info(chalk.yellow("Not currently logged in"));
      return;
    }

    delete currentConfig.token;
    delete currentConfig.auth;
    config.save(currentConfig);

    spinner.succeed(chalk.green("Successfully logged out"));
  } catch (error) {
    spinner.fail(chalk.red("Logout failed"));
    handlePlatformError(error);
    logger.error("Error during logout:", error);
    process.exit(1);
  }
}

/** Entry point for `cirron auth status`: reports who the stored credentials belong to. */
export async function authCommand(): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!(currentConfig.token || currentConfig.auth?.accessToken)) {
      logger.info(chalk.yellow("Not authenticated"));
      logger.info(`Run ${chalk.cyan("cirron auth login")} to authenticate`);
      return;
    }

    const spinner = ora("Checking authentication status...").start();

    try {
      const api = new CirronApi(currentConfig);
      const authInfo = await api.verifyAuth();

      if (authInfo.valid && authInfo.user) {
        spinner.succeed(chalk.green("Authenticated"));
        logger.info(`User: ${chalk.cyan(authInfo.user.email)}`);
        if (authInfo.user.name) {
          logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
        }

        // Show organization info if available
        if (authInfo.organization) {
          logger.info(
            `Organization: ${chalk.cyan(authInfo.organization.name)}`
          );
        }

        logger.info(`API URL: ${chalk.cyan(currentConfig.apiUrl)}`);

        // Show token expiration from token object
        if (authInfo.token?.expiresAt) {
          const expiryDate = new Date(authInfo.token.expiresAt);
          const now = new Date();
          const daysUntilExpiry = Math.ceil(
            (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );

          if (daysUntilExpiry <= 7) {
            logger.warn(`Token expires in ${daysUntilExpiry} days`);
          } else {
            logger.info(
              `Token expires: ${chalk.cyan(expiryDate.toLocaleDateString())}`
            );
          }
        }

        // Show token scopes if available
        if (authInfo.token?.scopes) {
          logger.info(
            `Scopes: ${chalk.cyan(authInfo.token.scopes.join(", "))}`
          );
        }
      } else {
        spinner.fail(chalk.red("Token is invalid or expired"));
        logger.info(
          `Run ${chalk.cyan("cirron auth login")} to re-authenticate`
        );
      }
    } catch (error) {
      spinner.fail(chalk.red("Failed to verify authentication"));
      handlePlatformError(error);
      logger.error("Error verifying token:", error);
      logger.info(`Run ${chalk.cyan("cirron auth login")} to re-authenticate`);
    }
  } catch (error) {
    handlePlatformError(error);
    logger.error("Error checking authentication status:", error);
    process.exit(1);
  }
}

/** Entry point for `cirron auth refresh`: exchanges the refresh token for a new access token. */
export async function refreshCommand(): Promise<void> {
  const spinner = ora("Refreshing authentication...").start();

  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!currentConfig.auth?.refreshToken) {
      spinner.fail(chalk.red("No refresh token available"));
      logger.error(
        `Please log in again with: ${chalk.cyan("cirron auth login")}`
      );
      process.exit(1);
    }

    const api = new CirronApi(currentConfig);
    const newTokens = await api.refreshToken(currentConfig.auth.refreshToken);

    await saveTokens(newTokens, currentConfig, config);

    spinner.succeed(chalk.green("Authentication refreshed!"));

    // Show updated auth info
    const authInfo = await api.verifyAuth();
    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to refresh token"));
    handlePlatformError(error);

    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }

    logger.info(`Please log in again with: ${chalk.cyan("cirron auth login")}`);
    process.exit(1);
  }
}
