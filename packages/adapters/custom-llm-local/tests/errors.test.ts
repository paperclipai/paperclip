import { describe, expect, it } from "vitest";
import { buildErrorResult, classifyFetchError, classifyHttpStatus } from "../src/errors.js";

describe("classifyFetchError", () => {
  it.each(["connect ECONNREFUSED 127.0.0.1:1", "getaddrinfo ENOTFOUND llm.local"])(
    "maps %s to ENDPOINT_UNREACHABLE",
    (message) => {
      expect(classifyFetchError(new Error(message))).toMatchObject({ code: "ENDPOINT_UNREACHABLE" });
    },
  );

  it("maps AbortError to TIMEOUT", () => {
    expect(classifyFetchError(new Error("AbortError: The operation was aborted"))).toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("classifyHttpStatus", () => {
  it.each([401, 403])("maps HTTP %s to AUTH_FAILED", (status) => {
    expect(classifyHttpStatus(status, "nope")).toMatchObject({ code: "AUTH_FAILED" });
  });

  it.each([400, 404, 429])("maps HTTP %s to MODEL_REJECTED", (status) => {
    expect(classifyHttpStatus(status, "bad model")).toMatchObject({ code: "MODEL_REJECTED" });
  });

  it.each([500, 502, 503])("maps HTTP %s to UPSTREAM_ERROR", (status) => {
    expect(classifyHttpStatus(status, "upstream down")).toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("buildErrorResult", () => {
  it("creates a failed AdapterExecutionResult shape", () => {
    expect(
      buildErrorResult({
        code: "TIMEOUT",
        message: "too slow",
        meta: { timeoutSec: 2 },
      }),
    ).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorMessage: "too slow",
      errorCode: "TIMEOUT",
      errorMeta: { timeoutSec: 2 },
    });
  });
});
