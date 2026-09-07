import { describe, expect, it } from "bun:test";
import { classifyAgentCredentials } from "./agent-credentials.js";

describe("agent credential classification", () => {
  it("classifies a valid bearer as an agent credential candidate", () => {
    expect(classifyAgentCredentials(
      "/api/issues",
      "Bearer agent-token",
    )).toEqual({ kind: "agent", token: "agent-token" });
  });

  it("rejects an empty bearer without exposing a token", () => {
    expect(classifyAgentCredentials("/api/issues", "Bearer   ")).toEqual({
      kind: "invalid",
      reason: "empty_bearer",
    });
  });

  it("leaves the public MCP gateway token to its protocol handler", () => {
    expect(classifyAgentCredentials(
      `/mcp/gateways/gw_${"a".repeat(32)}`,
      "Bearer pcgw_runtime_token",
    )).toEqual({ kind: "gateway", token: "pcgw_runtime_token" });
  });

  it("does not grant the MCP exception to a lookalike path", () => {
    expect(classifyAgentCredentials(
      "/mcp/gateways/not-a-gateway",
      "Bearer pcgw_runtime_token",
    )).toEqual({ kind: "agent", token: "pcgw_runtime_token" });
  });

  it("does not classify non-bearer authentication as an agent credential", () => {
    expect(classifyAgentCredentials("/api/issues", "Basic token")).toEqual({ kind: "none" });
    expect(classifyAgentCredentials("/api/issues", undefined)).toEqual({ kind: "none" });
  });
});
