import { describe, expect, it } from "vitest";
import { environmentSyncErrorData, readEnvironmentSyncErrorDiagnostic } from "../src/environment-sync-error.js";

const schema = "paperclip/environment-sync-error/v1";

describe("environment sync diagnostic envelope", () => {
  it("keeps only known codes and bounded numbers from nested provider errors", () => {
    const error = Object.assign(new Error("private-message"), {
      name: "private-name", code: "private-code", path: "/private-path",
      response: { status: 503, data: { token: "private-token" } },
      data: { credentials: "private-credentials" },
      cause: { code: "ECONNRESET", exitCode: 7, stderr: "private-output" },
    });
    const data = environmentSyncErrorData(error);
    expect(data).toEqual({ schema, diagnostic: { errorCode: "ECONNRESET", httpStatus: 503, exitCode: 7 } });
    expect(JSON.stringify(data)).not.toContain("private-");
    expect(readEnvironmentSyncErrorDiagnostic({ data })).toEqual({ errorCode: "ECONNRESET", httpStatus: 503, exitCode: 7 });
  });

  it.each([undefined, null, "private-error", { code: "PRIVATE_TOKEN" }, { status: 600 }, { status: 399 },
    { statusCode: "503" }, { status: 500.5 }, { exitCode: 0 }, { exitCode: 256 }, { code: -32001 },
    { exitCode: Infinity }, { data: { schema, diagnostic: { errorCode: "EACCES" } } },
  ])("omits unrecognized or unbounded provider values: %j", (error) => {
    expect(environmentSyncErrorData(error)).toBeUndefined();
  });

  it("bounds cyclic causes and ignores throwing getters without changing the error", () => {
    const error = Object.defineProperties({ statusCode: 429 } as Record<string, unknown>, {
      code: { get() { throw new Error("private-code"); } },
      response: { get() { throw new Error("private-response"); } },
    });
    error.cause = error;
    expect(environmentSyncErrorData(error)).toEqual({ schema, diagnostic: { errorCode: "unknown", httpStatus: 429 } });
    const wrap = (cause: unknown) => ({ cause });
    expect(environmentSyncErrorData(wrap(wrap(wrap({ code: "EIO" }))))).toEqual({ schema, diagnostic: { errorCode: "EIO" } });
    expect(environmentSyncErrorData(wrap(wrap(wrap(wrap({ code: "EIO" })))))).toBeUndefined();
  });

  it("revalidates worker fields and ignores arbitrary payload and protocol versions", () => {
    expect(readEnvironmentSyncErrorDiagnostic({ data: { schema, diagnostic: {
      errorCode: "EACCES", httpStatus: 403, exitCode: 1.5,
      message: "private-message", path: "/private-path", credentials: "private-token",
    } } })).toEqual({ errorCode: "EACCES", httpStatus: 403 });
    expect(readEnvironmentSyncErrorDiagnostic({ data: { schema: "other", diagnostic: { errorCode: "EACCES" } } })).toBeUndefined();
    expect(readEnvironmentSyncErrorDiagnostic({ data: { schema, diagnostic: { errorCode: "private-token", httpStatus: 900 } } })).toBeUndefined();
    expect(readEnvironmentSyncErrorDiagnostic(Object.defineProperty({}, "data", { get() { throw new Error("private"); } }))).toBeUndefined();
  });
});
