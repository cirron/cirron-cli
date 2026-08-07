import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFetchError,
  classifyHttpError,
  handlePlatformError,
  NotAuthenticatedError,
  PlatformBadRequestError,
  PlatformError,
  PlatformRateLimitError,
  PlatformServerError,
  PlatformUnavailableError,
} from "../../../src/utils/api-errors";
import { exitCodeFromError, stubProcessExit } from "../../helpers/mock-api";

describe("PlatformError subclasses", () => {
  it("PlatformUnavailableError has exit code 3 and a user-facing waitlist message", () => {
    const err = new PlatformUnavailableError("ECONNREFUSED");
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.exitCode).toBe(3);
    expect(err.userMessage).toMatch(/private preview/i);
    expect(err.userMessage).toMatch(/cirron\.com\/waitlist/);
  });

  it("NotAuthenticatedError has exit code 2 and tells the user to log in", () => {
    const err = new NotAuthenticatedError("token expired");
    expect(err.exitCode).toBe(2);
    expect(err.userMessage).toMatch(/cirron auth login/);
  });

  it("PlatformBadRequestError preserves the server message verbatim", () => {
    const err = new PlatformBadRequestError(422, "project name already exists");
    expect(err.exitCode).toBe(1);
    expect(err.status).toBe(422);
    expect(err.userMessage).toBe("project name already exists");
  });

  it("PlatformServerError wraps the server message with status context", () => {
    const err = new PlatformServerError(503, "service unavailable");
    expect(err.exitCode).toBe(1);
    expect(err.status).toBe(503);
    expect(err.userMessage).toMatch(/503/);
    expect(err.userMessage).toMatch(/service unavailable/);
  });

  it("retains the original cause for verbose debugging", () => {
    const cause = new Error("underlying network failure");
    const err = new PlatformUnavailableError("wrapped", { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("classifyFetchError", () => {
  it("maps ECONNREFUSED to PlatformUnavailableError", () => {
    const raw = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    });
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("maps ENOTFOUND (DNS failure) to PlatformUnavailableError", () => {
    const raw = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("maps ETIMEDOUT to PlatformUnavailableError", () => {
    const raw = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("maps AbortError (from timeout) to PlatformUnavailableError", () => {
    const raw = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("maps a legacy FetchError by name", () => {
    const raw = Object.assign(new Error("fetch failed"), {
      name: "FetchError",
    });
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("falls back to message regex when name/code are absent", () => {
    const raw = new Error("request to http://x.invalid/ failed, reason: dns");
    expect(classifyFetchError(raw)).toBeInstanceOf(PlatformUnavailableError);
  });

  it("preserves the original error as the cause for telemetry", () => {
    const raw = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const classified = classifyFetchError(raw) as PlatformUnavailableError;
    expect((classified as { cause?: unknown }).cause).toBe(raw);
  });

  it("returns unrecognized errors unchanged so callers can inspect them", () => {
    const raw = new TypeError("totally unrelated bug");
    expect(classifyFetchError(raw)).toBe(raw);
  });

  it("returns non-Error values unchanged", () => {
    expect(classifyFetchError("string thrown")).toBe("string thrown");
    expect(classifyFetchError(null)).toBe(null);
  });
});

describe("classifyHttpError", () => {
  it.each([401, 403])("maps HTTP %s to NotAuthenticatedError", (status) => {
    expect(classifyHttpError(status, "unauthorized")).toBeInstanceOf(
      NotAuthenticatedError
    );
  });

  it.each([
    400, 404, 409, 422,
  ])("maps client error HTTP %s to PlatformBadRequestError", (status) => {
    const err = classifyHttpError(status, "bad request");
    expect(err).toBeInstanceOf(PlatformBadRequestError);
    expect((err as PlatformBadRequestError).status).toBe(status);
  });

  it("maps HTTP 429 to PlatformRateLimitError carrying Retry-After", () => {
    const err = classifyHttpError(429, "Rate limit exceeded", 7);
    expect(err).toBeInstanceOf(PlatformRateLimitError);
    expect((err as PlatformRateLimitError).retryAfterSeconds).toBe(7);
    expect((err as PlatformRateLimitError).status).toBe(429);
  });

  it("leaves retryAfterSeconds undefined when the header is absent", () => {
    const err = classifyHttpError(429, "Rate limit exceeded");
    expect(err).toBeInstanceOf(PlatformRateLimitError);
    expect((err as PlatformRateLimitError).retryAfterSeconds).toBeUndefined();
  });

  it.each([
    500, 502, 503, 504,
  ])("maps server error HTTP %s to PlatformServerError", (status) => {
    const err = classifyHttpError(status, "boom");
    expect(err).toBeInstanceOf(PlatformServerError);
    expect((err as PlatformServerError).status).toBe(status);
  });
});

describe("handlePlatformError", () => {
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      /* swallow */
    });
  });

  afterEach(() => {
    exitStub.restore();
    errorSpy.mockRestore();
  });

  it("logs the user message and exits with the error's exit code", () => {
    const err = new PlatformUnavailableError("offline");
    expect(() => handlePlatformError(err)).toThrow(/__process\.exit\(3\)__/);
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/private preview/i);
  });

  it("uses exit code 2 for auth errors", () => {
    try {
      handlePlatformError(new NotAuthenticatedError("nope"));
    } catch (caught) {
      expect(exitCodeFromError(caught)).toBe(2);
    }
  });

  it("returns false (no exit) for non-PlatformErrors", () => {
    const result = handlePlatformError(new Error("regular bug"));
    expect(result).toBe(false);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("returns false for non-Error throws (strings, undefined)", () => {
    expect(handlePlatformError("boom")).toBe(false);
    expect(handlePlatformError(undefined)).toBe(false);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });
});
