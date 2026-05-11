import { logger } from "./logger";

/**
 * Base class for all errors surfaced from the Cirron platform / API client.
 *
 * Each subclass carries:
 *   - userMessage: a clean, single-line message safe to show end users
 *   - exitCode:    the process exit code for CLI commands to use
 *
 * Cause (the original Error) is retained on `.cause` for verbose / debug output.
 */
export abstract class PlatformError extends Error {
  abstract readonly userMessage: string;
  abstract readonly exitCode: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * The Cirron platform is unreachable: network down, DNS failure, refused
 * connection, request timeout/abort. Exit code 3.
 *
 * During the v0.1.0 preview, this is the expected error for anyone running a
 * platform-gated command without backend access.
 */
export class PlatformUnavailableError extends PlatformError {
  readonly exitCode = 3;
  readonly userMessage =
    "Cirron platform is unavailable — currently in private preview. Local commands (init, compile, build, config, doctor, env, hardware, status) work without it.\n Are you or your team interested in early access to the platform? Join the waitlist at https://cirron.com/waitlist.";
  // TODO update this message when public endpoint is live
  // "Could not reach the Cirron platform. Check your network connection or run 'cirron config get apiUrl' to verify the endpoint.";
}

/**
 * No credentials, expired credentials, or rejected credentials (401/403).
 * Exit code 2.
 */
export class NotAuthenticatedError extends PlatformError {
  readonly exitCode = 2;
  readonly userMessage =
    "Not signed in. Run 'cirron auth login' to authenticate.";
}

/**
 * The server returned a 4xx (other than 401/403). Usually a request the user
 * can fix. Exit code 1; surfaces the server-provided message.
 */
export class PlatformBadRequestError extends PlatformError {
  readonly exitCode = 1;
  readonly status: number;
  readonly userMessage: string;

  constructor(
    status: number,
    serverMessage: string,
    options?: { cause?: unknown }
  ) {
    super(serverMessage, options);
    this.status = status;
    this.userMessage = serverMessage;
  }
}

/**
 * Server-side failure (5xx). Exit code 1. The user can retry; on their side
 * nothing is actionable.
 */
export class PlatformServerError extends PlatformError {
  readonly exitCode = 1;
  readonly status: number;
  readonly userMessage: string;

  constructor(
    status: number,
    serverMessage: string,
    options?: { cause?: unknown }
  ) {
    super(serverMessage, options);
    this.status = status;
    this.userMessage = `Cirron platform error (${status}): ${serverMessage}. Please try again later.`;
  }
}

/**
 * Convert a thrown error from `fetch` / `node-fetch` into a typed PlatformError.
 * Network-level failures (DNS, refused, abort, timeout) become
 * PlatformUnavailableError; anything unrecognized is returned unchanged for the
 * caller to handle.
 */
export function classifyFetchError(error: unknown): PlatformError | unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const code = (error as NodeJS.ErrnoException).code;
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
  ]);

  if (code && networkCodes.has(code)) {
    return new PlatformUnavailableError(error.message, { cause: error });
  }

  // AbortError (from our timeout) or fetch-level network failure
  if (
    error.name === "AbortError" ||
    error.name === "FetchError" ||
    /network|fetch failed|request to .* failed/i.test(error.message)
  ) {
    return new PlatformUnavailableError(error.message, { cause: error });
  }

  return error;
}

/**
 * Map an HTTP status + server body into a typed PlatformError.
 * 401/403 → NotAuthenticatedError
 * 4xx     → PlatformBadRequestError
 * 5xx     → PlatformServerError
 */
export function classifyHttpError(
  status: number,
  serverMessage: string
): PlatformError {
  if (status === 401 || status === 403) {
    return new NotAuthenticatedError(serverMessage);
  }
  if (status >= 500) {
    return new PlatformServerError(status, serverMessage);
  }
  return new PlatformBadRequestError(status, serverMessage);
}

/**
 * If the error is a PlatformError, log its user-facing message and exit with
 * the appropriate code. Otherwise return false so the caller can handle the
 * error itself (preserving stack traces for unexpected failures).
 *
 * Verbose mode (CIRRON_VERBOSE=true) also dumps the underlying cause for
 * debugging.
 */
export function handlePlatformError(error: unknown): boolean {
  if (!(error instanceof PlatformError)) {
    return false;
  }

  logger.error(error.userMessage);

  if (
    process.env["CIRRON_VERBOSE"] === "true" &&
    (error as { cause?: unknown }).cause
  ) {
    logger.debug("Cause:", (error as { cause?: unknown }).cause);
  }

  process.exit(error.exitCode);
}
