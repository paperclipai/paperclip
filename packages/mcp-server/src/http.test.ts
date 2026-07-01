import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@paperclipai/mcp-transport";
import { createPaperclipHttpAuthenticator } from "./http.js";

const ENV = { PAPERCLIP_API_URL: "https://cp.example.com" } as NodeJS.ProcessEnv;

function reqWith(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as never;
}

describe("createPaperclipHttpAuthenticator", () => {
  it("maps a token binding to a config with the server-pinned apiUrl", () => {
    const authenticate = createPaperclipHttpAuthenticator({
      env: ENV,
      readParameter: () => JSON.stringify({ apiKey: "sk-1", companyId: "c1", agentId: "a1" }),
    });

    expect(authenticate(reqWith("Bearer tok1"))).toEqual({
      apiUrl: "https://cp.example.com/api",
      apiKey: "sk-1",
      companyId: "c1",
      agentId: "a1",
      runId: null,
    });
  });

  it("never takes apiUrl from the token binding (pinned to server env)", () => {
    const authenticate = createPaperclipHttpAuthenticator({
      env: ENV,
      readParameter: () => JSON.stringify({ apiKey: "sk-1", apiUrl: "https://evil.example.com" }),
    });
    const config = authenticate(reqWith("Bearer tok1"));
    expect(config.apiUrl).toBe("https://cp.example.com/api");
  });

  it("rejects a binding without an apiKey", () => {
    const authenticate = createPaperclipHttpAuthenticator({
      env: ENV,
      readParameter: () => JSON.stringify({ companyId: "c1" }),
    });
    expect(() => authenticate(reqWith("Bearer tok1"))).toThrow(/apiKey/);
  });

  it("leaves optional company/agent null when absent", () => {
    const authenticate = createPaperclipHttpAuthenticator({
      env: ENV,
      readParameter: () => JSON.stringify({ apiKey: "sk-1" }),
    });
    expect(authenticate(reqWith("Bearer tok1"))).toMatchObject({
      apiKey: "sk-1",
      companyId: null,
      agentId: null,
    });
  });

  it("honors PAPERCLIP_MCP_TOKEN_PREFIX for the SSM path", () => {
    let seen = "";
    const authenticate = createPaperclipHttpAuthenticator({
      env: { ...ENV, PAPERCLIP_MCP_TOKEN_PREFIX: "/custom/prefix" } as NodeJS.ProcessEnv,
      readParameter: (name) => {
        seen = name;
        return JSON.stringify({ apiKey: "sk-1" });
      },
    });
    authenticate(reqWith("Bearer tok1"));
    expect(seen).toBe("/custom/prefix/tok1");
  });

  it("rejects a missing Authorization header before any SSM lookup", () => {
    let called = false;
    const authenticate = createPaperclipHttpAuthenticator({
      env: ENV,
      readParameter: () => {
        called = true;
        return "";
      },
    });
    expect(() => authenticate(reqWith())).toThrow(UnauthorizedError);
    expect(called).toBe(false);
  });
});
