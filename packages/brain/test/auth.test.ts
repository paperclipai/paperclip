import { describe, it, expect } from "vitest";
import { authenticate, loadTokensFromEnv, type TokenIdentity } from "../src/mcp-server/auth.js";

const CEO_ID: TokenIdentity = { defaultAgentId: "CEO", allowedAgentIds: ["CEO"] };
const WALTER_ID: TokenIdentity = { defaultAgentId: "walter", allowedAgentIds: ["walter"] };

describe("authenticate", () => {
  const tokens = { "secret-1": CEO_ID, "secret-2": WALTER_ID };

  it("accepts a valid bearer token", () => {
    const r = authenticate("Bearer secret-1", tokens);
    expect(r.ok).toBe(true);
    expect(r.identity?.defaultAgentId).toBe("CEO");
    expect(r.identity?.allowedAgentIds).toEqual(["CEO"]);
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

  it("loads three known token vars with single-identity allowlists by default", () => {
    const tokens = loadTokensFromEnv({
      BRAIN_PAPERCLIP_TOKEN: "p",
      BRAIN_CLAUDE_CODE_TOKEN: "c",
      BRAIN_N8N_TOKEN: "n",
    });
    expect(tokens.p).toEqual({ defaultAgentId: "PAPERCLIP", allowedAgentIds: ["PAPERCLIP"] });
    expect(tokens.c).toEqual({ defaultAgentId: "walter", allowedAgentIds: ["walter"] });
    expect(tokens.n).toEqual({ defaultAgentId: "n8n", allowedAgentIds: ["n8n"] });
  });

  it("extends Paperclip token allowlist from BRAIN_PAPERCLIP_ALLOWED_AGENTS", () => {
    const tokens = loadTokensFromEnv({
      BRAIN_PAPERCLIP_TOKEN: "p",
      BRAIN_PAPERCLIP_ALLOWED_AGENTS: "CEO, CFO,CMO , walter",
    });
    expect(tokens.p.defaultAgentId).toBe("PAPERCLIP");
    expect(tokens.p.allowedAgentIds).toEqual(["PAPERCLIP", "CEO", "CFO", "CMO", "walter"]);
  });

  it("walter and n8n token allowlists are NOT extendable via env (fixed single identity)", () => {
    const tokens = loadTokensFromEnv({
      BRAIN_CLAUDE_CODE_TOKEN: "c",
      BRAIN_N8N_TOKEN: "n",
      BRAIN_PAPERCLIP_ALLOWED_AGENTS: "CEO,CFO",
    });
    expect(tokens.c.allowedAgentIds).toEqual(["walter"]);
    expect(tokens.n.allowedAgentIds).toEqual(["n8n"]);
  });
});
