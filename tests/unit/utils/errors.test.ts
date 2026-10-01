import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionDeniedError } from "../../../src/utils/api-errors";
import {
  CLIError,
  CLIErrorCode,
  errorMessage,
  reportCommandError,
} from "../../../src/utils/errors";
import { logger } from "../../../src/utils/logger";
import { exitCodeFromError, stubProcessExit } from "../../helpers/mock-api";

describe("errorMessage", () => {
  it("returns an Error's message without its name or stack", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("reportCommandError", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitStub: ReturnType<typeof stubProcessExit>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    exitStub = stubProcessExit();
  });

  afterEach(() => {
    logger.setVerbose(false);
    vi.restoreAllMocks();
  });

  function stderr(): string {
    return errorSpy.mock.calls.flat().map(String).join(" ");
  }

  it("prints a plain Error as one line with no repeated prefix or stack", () => {
    reportCommandError(new Error("No cirron config found"));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(stderr()).toMatch(/No cirron config found/);
    expect(stderr()).not.toMatch(/Error: Error/);
    expect(stderr()).not.toMatch(/\n\s+at /);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("leads with the context when one is given", () => {
    reportCommandError(new Error("disk full"), "Failed to save");
    expect(stderr()).toMatch(/Failed to save: disk full/);
  });

  it("hands a PlatformError to handlePlatformError, which exits with its code", () => {
    let caught: unknown;
    try {
      reportCommandError(new PermissionDeniedError("Forbidden", "x:y"));
    } catch (error) {
      caught = error;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(stderr()).toMatch(/Permission denied/);
  });

  it("shows the stack only in verbose mode", () => {
    const logSpy = vi.mocked(console.log);
    reportCommandError(new Error("quiet"));
    expect(logSpy.mock.calls.flat().join(" ")).not.toMatch(/\n\s+at /);

    logger.setVerbose(true);
    reportCommandError(new Error("loud"));
    expect(logSpy.mock.calls.flat().join(" ")).toMatch(/\n\s+at /);
  });
});

describe("CLIError.format", () => {
  it("does not start with its own 'Error' label, since the logger adds one", () => {
    const formatted = new CLIError({
      code: CLIErrorCode.PROJECT_NOT_FOUND,
      message: "Project configuration not found",
    }).format();

    expect(formatted).toMatch(/Project configuration not found \(code 31\)/);
    expect(stripVTControlCharacters(formatted)).not.toMatch(/^Error/);
  });
});
