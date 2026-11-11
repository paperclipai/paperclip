import { describe, expect, it } from "vitest";
import {
  EnvironmentProviderUnavailableError,
  findEnvironmentProviderUnavailableError,
  readTransientEnvironmentProviderFailure,
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
