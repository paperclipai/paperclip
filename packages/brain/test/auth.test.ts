import { describe, it, expect } from "vitest";
import { authenticate, loadTokensFromEnv } from "../src/mcp-server/auth.js";

describe("authenticate", () => {
  const tokens = { "secret-1": "CEO", "secret-2": "walter" };

  it("accepts a valid bearer token", () => {
    const r = authenticate("Bearer secret-1", tokens);
    expect(r.ok).toBe(true);
    expect(r.defaultAgentId).toBe("CEO");
  });

  it("rejects missing header", () => {
    expect(authenticate(undefined, tokens).ok).toBe(false);
  });

  it("rejects malformed header", () => {
    expect(authenticate("Token foo", tokens).ok).toBe(false);
  });

  it("rejects unknown token", () => {
    expect(authenticate("Bearer wrong", tokens).ok).toBe(false);
  });
});

describe("loadTokensFromEnv", () => {
  it("returns empty object when no token vars set", () => {
    expect(loadTokensFromEnv({})).toEqual({});
  });

  it("loads three known token vars", () => {
    const tokens = loadTokensFromEnv({
      BRAIN_PAPERCLIP_TOKEN: "p",
      BRAIN_CLAUDE_CODE_TOKEN: "c",
      BRAIN_N8N_TOKEN: "n",
    });
    expect(tokens).toEqual({ p: "PAPERCLIP", c: "walter", n: "n8n" });
  });
});
