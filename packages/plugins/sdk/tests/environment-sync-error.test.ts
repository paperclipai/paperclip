import { describe, expect, it } from "vitest";
import { preserveEnvironmentSyncErrorDiagnostic, environmentSyncErrorData, readEnvironmentSyncErrorDiagnostic, withEnvironmentSyncErrorCapture, withEnvironmentSyncTransferStep, recordEnvironmentSyncError } from "../src/environment-sync-error.js";

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


describe("request-local transfer evidence", () => {
  it("preserves frozen error identity, nested attribution, and later-attempt attribution", async () => {
    const error = Object.freeze(new Error("private-message"));
    const before = Object.getOwnPropertyDescriptors(error);
    await withEnvironmentSyncErrorCapture(async () => {
      await expect(withEnvironmentSyncTransferStep("archive_download", () =>
        withEnvironmentSyncTransferStep("sandbox_access", async () => { throw error; }))).rejects.toBe(error);
      expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(error) })?.transferStep).toBe("sandbox_access");
      await expect(withEnvironmentSyncTransferStep("archive_create", async () => { throw error; })).rejects.toBe(error);
      expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(error) })?.transferStep).toBe("archive_create");
    });
    expect(environmentSyncErrorData(error)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
    await withEnvironmentSyncErrorCapture(async () => expect(environmentSyncErrorData(error)).toBeUndefined());
  });

  it("does not trust labels on raw errors, their causes, or unknown producer values", async () => {
    const error = { transferStep: "archive_create", transferFailureKind: "command_failed",
      cause: { transferStep: "archive_validate", message: "private-message" } };
    await withEnvironmentSyncErrorCapture(async () => {
      expect(environmentSyncErrorData(error)).toBeUndefined();
      recordEnvironmentSyncError(error, { transferStep: "private-stage", transferFailureKind: "private-kind", exitCode: 900 } as never);
      expect(environmentSyncErrorData(error)).toBeUndefined();
    });
    expect(readEnvironmentSyncErrorDiagnostic({ data: { schema, diagnostic: {
      errorCode: "unknown", transferStep: "private-stage", transferFailureKind: "private-kind", rpcCode: -32003,
    } } })).toBeUndefined();
  });

  it("omits evidence from detached work after the RPC scope closes", async () => {
    const error = new Error("private-message");
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let detached!: Promise<unknown>;
    await withEnvironmentSyncErrorCapture(async () => {
      detached = withEnvironmentSyncTransferStep("archive_create", async () => { await gate; throw error; })
        .catch(failure => environmentSyncErrorData(failure));
    });
    resume();
    expect(await detached).toBeUndefined();
  });
});


it("copies safe evidence into an existing wrapper only within its request", async () => {
  const source = Object.freeze(Object.assign(new Error("private-message"), { status: 404, cause: { code: "EIO", token: "private-token" } }));
  const wrapper = Object.freeze(new Error("stable-policy-message"));
  await withEnvironmentSyncErrorCapture(async () => {
    await expect(withEnvironmentSyncTransferStep("file_download", async () => { throw source; })).rejects.toBe(source);
    expect(preserveEnvironmentSyncErrorDiagnostic(wrapper, source)).toBe(wrapper);
    expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(wrapper) })).toEqual({
      errorCode: "EIO", httpStatus: 404, transferStep: "file_download",
    });
    expect(wrapper).not.toHaveProperty("cause");
    expect(wrapper.message).toBe("stable-policy-message");
    // Reusing a wrapper for a later untyped failure must clear the earlier evidence.
    preserveEnvironmentSyncErrorDiagnostic(wrapper, new Error("private-untyped-message"));
    expect(environmentSyncErrorData(wrapper)).toBeUndefined();
  });
  expect(environmentSyncErrorData(wrapper)).toBeUndefined();
  await withEnvironmentSyncErrorCapture(async () => {
    preserveEnvironmentSyncErrorDiagnostic(wrapper, source);
    expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(wrapper) })).toEqual({ errorCode: "EIO", httpStatus: 404 });
  });
});
