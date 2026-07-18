import { describe, expect, it, vi } from "vitest";
import {
  createSsmTokenAuthenticator,
  extractBearerToken,
} from "./auth.js";
import { TokenBindingError, UnauthorizedError } from "./errors.js";

function reqWith(authorization?: string) {
  return { headers: authorization ? { authorization } : {} };
}

describe("extractBearerToken", () => {
  it("returns the token from a valid Bearer header", () => {
    expect(extractBearerToken(reqWith("Bearer abc123"))).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken(reqWith("bearer TOK_en-1.2~3"))).toBe("TOK_en-1.2~3");
  });

  it("rejects a missing header", () => {
    expect(() => extractBearerToken(reqWith())).toThrow(UnauthorizedError);
  });

  it("rejects a non-bearer scheme", () => {
    expect(() => extractBearerToken(reqWith("Basic abc"))).toThrow(UnauthorizedError);
  });

  it("rejects an empty token", () => {
    expect(() => extractBearerToken(reqWith("Bearer   "))).toThrow(UnauthorizedError);
  });

  it("rejects a token with shell/path metacharacters", () => {
    expect(() => extractBearerToken(reqWith('Bearer a"$(rm -rf /)'))).toThrow(UnauthorizedError);
    expect(() => extractBearerToken(reqWith("Bearer a/b"))).toThrow(UnauthorizedError);
  });
});

describe("createSsmTokenAuthenticator", () => {
  const toConfig = (binding: Record<string, unknown>) => ({
    companyId: binding.companyId,
    agentId: binding.agentId,
    apiKey: binding.apiKey,
  });

  it("resolves a token to config via the SSM reader", () => {
    const readParameter = vi.fn().mockReturnValue(
      JSON.stringify({ companyId: "c1", agentId: "a1", apiKey: "k1" }),
    );
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/paperclip/mcp/tokens/",
      toConfig,
      readParameter,
    });

    const config = authenticate(reqWith("Bearer tok1"));

    expect(readParameter).toHaveBeenCalledWith("/paperclip/mcp/tokens/tok1");
    expect(config).toEqual({ companyId: "c1", agentId: "a1", apiKey: "k1" });
  });

  it("maps a failed SSM lookup to Unauthorized (no existence leak)", () => {
    const readParameter = vi.fn(() => {
      throw new Error("ParameterNotFound");
    });
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/p",
      toConfig,
      readParameter,
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(UnauthorizedError);
  });

  it("maps the CLI 'None' sentinel to Unauthorized", () => {
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/p",
      toConfig,
      readParameter: () => "None",
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(UnauthorizedError);
  });

  it("maps non-JSON bindings to TokenBindingError", () => {
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/p",
      toConfig,
      readParameter: () => "not-json",
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(TokenBindingError);
  });

  it("rejects a non-object JSON binding", () => {
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/p",
      toConfig,
      readParameter: () => "[1,2,3]",
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(TokenBindingError);
  });

  it("propagates toConfig rejections", () => {
    const authenticate = createSsmTokenAuthenticator({
      paramPrefix: "/p",
      toConfig: () => {
        throw new TokenBindingError("missing apiKey");
      },
      readParameter: () => JSON.stringify({ companyId: "c1" }),
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(/missing apiKey/);
  });
});
