import { describe, expect, it } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentAcquisitionDiagnostic } from "@paperclipai/plugin-sdk";
import { captureEnvironmentAcquisitionDiagnostic } from "./environment-acquisition-diagnostics.js";
import {
  EnvironmentProviderUnavailableError,
  findEnvironmentProviderUnavailableError,
  readTransientEnvironmentProviderFailure,
  readTransientLeaseAcquisitionFailure,
} from "./environment-provider-unavailable-error.js";

function withStatus(status: number, key: "status" | "statusCode" = "status") {
  return Object.assign(new Error("provider refused"), { [key]: status });
}

describe("readTransientEnvironmentProviderFailure", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("treats HTTP %i as transient", (status) => {
    expect(readTransientEnvironmentProviderFailure(withStatus(status))).toEqual({ httpStatus: status });
  });

  it("reads statusCode as well as status", () => {
    expect(readTransientEnvironmentProviderFailure(withStatus(503, "statusCode"))).toEqual({ httpStatus: 503 });
  });

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"])("treats errno %s as transient", (code) => {
    expect(readTransientEnvironmentProviderFailure(Object.assign(new Error("closed"), { code })))
      .toEqual({ errorCode: code });
  });

  it.each(["ENOTFOUND", "ABORT_ERR", "EACCES"])("does not retry errno %s", (code) => {
    expect(readTransientEnvironmentProviderFailure(Object.assign(new Error("x"), { code }))).toBeNull();
  });

  it.each([400, 401, 403, 404, 409, 422, 501])("does not retry HTTP %i", (status) => {
    expect(readTransientEnvironmentProviderFailure(withStatus(status))).toBeNull();
  });

  it("finds transient evidence on a wrapped cause", () => {
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: withStatus(502) }) });
    expect(readTransientEnvironmentProviderFailure(wrapped)).toEqual({ httpStatus: 502 });
  });

  it("stops at a definite non-transient status instead of reading deeper causes", () => {
    const outer = Object.assign(new Error("bad request", { cause: withStatus(503) }), { status: 400 });
    expect(readTransientEnvironmentProviderFailure(outer)).toBeNull();
  });

  it("reads the validated plugin RPC envelope", () => {
    const rpcError = Object.assign(new Error("rpc failed"), {
      data: { schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 429 } },
    });
    expect(readTransientEnvironmentProviderFailure(rpcError)).toEqual({ httpStatus: 429 });
  });

  const stagingLeaseTimeout = (diagnostic: { phase: string; elapsedMs: number; budgetMs: number; providerState?: string }) =>
    Object.assign(new Error("Daytona lease acquisition timed out; allocation cleanup is pending"), {
      data: { schema: "paperclip/environment-creation-cleanup/v1",
        cleanup: { providerLeaseId: "paperclip-create-05f81d77", companyId: "company", environmentId: "environment",
          runId: "f41857b6", attemptId: "05f81d77", accountFingerprint: "a".repeat(64),
          labels: { "paperclip-provider": "daytona", "paperclip-create-attempt": "05f81d77" } },
        acquisitionDiagnostic: diagnostic },
    });

  it("treats an acquisition that reached its deadline as transient", () => {
    const timeout = stagingLeaseTimeout({ phase: "create", elapsedMs: 300_004, budgetMs: 300_000, providerState: "creating" });
    expect(readTransientEnvironmentProviderFailure(new Error("outer", { cause: timeout }))).toEqual({ acquisitionTimedOut: true });
  });

  it("does not retry an acquisition whose first failure came before its deadline", () => {
    expect(readTransientEnvironmentProviderFailure(stagingLeaseTimeout({ phase: "workspace", elapsedMs: 100, budgetMs: 300_000 }))).toBeNull();
  });

  it("never parses message text", () => {
    expect(readTransientEnvironmentProviderFailure(new Error("HTTP 502 Bad Gateway ECONNRESET"))).toBeNull();
  });
});

describe("EnvironmentProviderUnavailableError", () => {
  it.each([
    [{ httpStatus: 429 }, "rate_limit"],
    [{ httpStatus: 408 }, "timeout"],
    [{ httpStatus: 504 }, "timeout"],
    [{ errorCode: "ETIMEDOUT" }, "timeout"],
    [{ httpStatus: 502 }, "overloaded"],
    [{ errorCode: "ECONNRESET" }, "overloaded"],
  ] as const)("classifies %o as %s", (evidence, category) => {
    const error = new EnvironmentProviderUnavailableError({
      environmentName: "env", driver: "daytona", evidence, cause: null,
    });
    expect(error.providerFailure.category).toBe(category);
    expect(error.providerFailure.retryability).toBe("transient");
  });

  it("names an acquisition timeout in plain words", () => {
    const error = new EnvironmentProviderUnavailableError({
      environmentName: "Paperclip Sandbox", driver: "sandbox", evidence: { acquisitionTimedOut: true }, cause: null,
    });
    expect(error.providerFailure).toMatchObject({ category: "timeout", retryability: "transient", phase: "startup" });
    expect(error.providerFailure.message).toContain("did not finish starting");
    expect(error.providerFailure.message).not.toMatch(/ETIMEDOUT|undefined/);
  });

  it("falls back to a generic provider label for an unsafe driver key", () => {
    const error = new EnvironmentProviderUnavailableError({
      environmentName: "env", driver: "bad driver <x>", evidence: { httpStatus: 502 }, cause: null,
    });
    expect(error.providerFailure.provider).toBe("environment");
  });

  it("is found through wrapper causes", () => {
    const inner = new EnvironmentProviderUnavailableError({
      environmentName: "env", driver: "ssh", evidence: { errorCode: "ECONNREFUSED" }, cause: null,
    });
    expect(findEnvironmentProviderUnavailableError(new Error("outer", { cause: inner }))).toBe(inner);
    expect(findEnvironmentProviderUnavailableError(new Error("plain"))).toBeNull();
  });
});

describe("readTransientLeaseAcquisitionFailure", () => {
  const run = { id: "run-1", companyId: "company-1" };
  const creationFailure = (elapsedMs: number, runId = run.id) => {
    const error = new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "Daytona lease acquisition timed out; allocation cleanup is pending",
      data: { schema: "paperclip/environment-creation-cleanup/v1",
        cleanup: { providerLeaseId: "paperclip-create-1", companyId: run.companyId, environmentId: "env-1", runId,
          attemptId: "attempt-1", accountFingerprint: "a".repeat(64), labels: {} },
        acquisitionDiagnostic: { phase: "create", elapsedMs, budgetMs: 300_000 } } });
    captureEnvironmentAcquisitionDiagnostic(error, { companyId: run.companyId, environmentId: "env-1", runId },
      readEnvironmentAcquisitionDiagnostic(error));
    return error;
  };

  it("keeps the provider's transient status", () => {
    expect(readTransientLeaseAcquisitionFailure(withStatus(503), run)).toEqual({ httpStatus: 503 });
  });

  it("retries a creation that hit the acquisition deadline", () => {
    expect(readTransientLeaseAcquisitionFailure(new Error("wrapped", { cause: creationFailure(300_000) }), run))
      .toEqual({ acquisitionTimedOut: true });
  });

  it("retries a provisional creation that did not finish", () => {
    expect(readTransientLeaseAcquisitionFailure(creationFailure(12_000), run)).toEqual({ reason: "acquisition_incomplete" });
  });

  it("ignores an unfinished-creation diagnostic recorded for another run", () => {
    expect(readTransientLeaseAcquisitionFailure(creationFailure(12_000, "run-2"), run)).toBeNull();
  });

  it("retries a plugin RPC deadline", () => {
    const timeout = new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "RPC call timed out" });
    expect(readTransientLeaseAcquisitionFailure(timeout, run)).toEqual({ acquisitionTimedOut: true });
  });

  const pg = (code: string) => Object.assign(new Error("database error"), { name: "PostgresError", code });
  it.each([
    ["a terminated connection", pg("57P01")],
    ["a connection failure", pg("08006")],
    ["too many connections", pg("53300")],
    ["a lock timeout", pg("55P03")],
    ["a closed connection", Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" })],
    ["a Drizzle wrapper around a statement timeout", new Error("Failed query: select 1\nparams: ", { cause: pg("57014") })],
  ])("retries %s while recording the lease", (_label, cause) => {
    expect(readTransientLeaseAcquisitionFailure(new Error("lease", { cause }), run)).toEqual({ reason: "database_error" });
  });

  it.each([
    ["a unique violation", pg("23505")],
    ["an undefined column", pg("42703")],
    ["a Drizzle wrapper around a syntax error", new Error("Failed query: select\nparams: ", { cause: pg("42601") })],
    ["a bare Drizzle wrapper", new Error("Failed query: select 1\nparams: ")],
    ["an errno that looks like a SQLSTATE", Object.assign(new Error("x"), { code: "EPERM" })],
  ])("does not retry %s", (_label, cause) => {
    expect(readTransientLeaseAcquisitionFailure(new Error("lease", { cause }), run)).toBeNull();
  });

  it("does not retry a definite non-transient status, even with other evidence", () => {
    const refused = Object.assign(new Error("unauthorized", { cause: creationFailure(300_000) }), { status: 401 });
    expect(readTransientLeaseAcquisitionFailure(refused, run)).toBeNull();
  });

  it("does not retry an error without structured evidence", () => {
    expect(readTransientLeaseAcquisitionFailure(new Error("Daytona lease acquisition timed out"), run)).toBeNull();
  });

  it("names the reason in the board-facing failure", () => {
    const error = new EnvironmentProviderUnavailableError({ environmentName: "Sandbox", driver: "daytona",
      evidence: { reason: "database_error" }, cause: null });
    expect(error.providerFailure).toMatchObject({ category: "overloaded", providerCode: "database_error" });
    expect(error.message).toContain("a database query failed while recording the lease");
  });
});
