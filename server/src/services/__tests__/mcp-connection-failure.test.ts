import { describe, expect, it } from "vitest";
import { HttpError } from "../../errors.js";
import { isExpectedMcpConnectionFailure, retainMcpConnectionFailure, withMcpConnectionFailure } from "../mcp-connection-failure.js";
import { assertPublicRemoteHttpEndpoint } from "../remote-http-endpoint-guard.js";

describe("MCP outbound failure provenance", () => {
  it.each([
    "ECONNREFUSED", "ENOTFOUND", "ENODATA", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
    "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("recognizes the structured transport failure %s without changing the thrown error", async (code) => {
    const original = new TypeError("request failed", { cause: { code } });
    await expect(withMcpConnectionFailure(async () => { throw original; })).rejects.toBe(original);
    const wrapped = retainMcpConnectionFailure(original, new HttpError(502, original.message));
    expect(isExpectedMcpConnectionFailure(wrapped)).toBe(true);
    expect(Object.keys(original)).not.toContain("connectionFailure");
  });

  it.each([
    new TypeError("ECONNREFUSED"),
    new DOMException("request expired", "TimeoutError"),
    Object.assign(new Error("cancelled", { cause: { code: "ECONNRESET" } }), { name: "AbortError" }),
    Object.assign(new Error("too many files"), { code: "EMFILE" }),
    new TypeError("request failed", { cause: { code: "toString" } }),
    new TypeError("request failed", { cause: { code: "ECONNRESET", errors: [] } }),
    new TypeError("request failed", { cause: { errors: [{ code: "ECONNRESET" }, { code: "ERR_INTERNAL_ASSERTION" }] } }),
  ])("keeps unknown, local, cancellation, and mixed failures visible: %s", async (original) => {
    await expect(withMcpConnectionFailure(async () => { throw original; })).rejects.toBe(original);
    expect(isExpectedMcpConnectionFailure(retainMcpConnectionFailure(original, new HttpError(502, original.message))))
      .toBe(false);
  });

  it("does not carry provenance onto a subsequent independent error", async () => {
    const transport = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    await expect(withMcpConnectionFailure(async () => { throw transport; })).rejects.toBe(transport);
    const persistence = new Error("database write failed", { cause: transport });
    expect(isExpectedMcpConnectionFailure(retainMcpConnectionFailure(persistence, new HttpError(502, persistence.message))))
      .toBe(false);
  });

  it.each(["known DNS", "DNS deadline", "unknown lookup"])("retains only producer-proven %s across discovery wrapping", async (kind) => {
    const original = await assertPublicRemoteHttpEndpoint(new URL("https://missing.example.test/mcp"), {
      dnsTimeoutMs: 1,
      lookup: async () => {
        if (kind === "known DNS") throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
        if (kind === "unknown lookup") throw new TypeError("lookup implementation failed");
        return new Promise(() => {});
      },
    }, (message, code) => new HttpError(400, message, { code })).catch((error) => error);
    expect(original).toBeInstanceOf(HttpError);
    const wrapped = retainMcpConnectionFailure(original, new HttpError(502, original.message));
    expect(isExpectedMcpConnectionFailure(wrapped)).toBe(kind !== "unknown lookup");
    const unrelated = new Error("database failed", { cause: original });
    expect(isExpectedMcpConnectionFailure(retainMcpConnectionFailure(unrelated, new HttpError(502, unrelated.message))))
      .toBe(false);
  });
});
