import { describe, expect, it } from "bun:test";
import { classifyAgentCredentials } from "./agent-credentials.js";
import { classifyBearerRequest } from "./bearer-dispatch.js";

describe("bearer request dispatch", () => {
  it("identifies normal bearer credentials", () => {
    expect(classifyBearerRequest("/api/issues", "Bearer pcp_token")).toEqual({
      kind: "credential",
      token: "pcp_token",
    });
  });

  it("rejects an empty bearer without exposing a token", () => {
    expect(classifyBearerRequest("/api/issues", "Bearer   ")).toEqual({
      kind: "empty",
    });
  });

  it("leaves public MCP gateway bearers for the gateway protocol", () => {
    expect(classifyBearerRequest(
      `/mcp/gateways/gw_${"a".repeat(32)}`,
      "Bearer pcgw_runtime_token",
    )).toEqual({
      kind: "gateway",
      token: "pcgw_runtime_token",
    });
  });

  it("does not broaden the gateway exception to lookalike paths", () => {
    expect(classifyBearerRequest(
      "/mcp/gateways/not-a-public-id",
      "Bearer pcgw_runtime_token",
    )).toEqual({
      kind: "credential",
      token: "pcgw_runtime_token",
    });
  });

  it("returns none when authorization is absent or not bearer", () => {
    expect(classifyBearerRequest("/api/issues", undefined)).toEqual({ kind: "none" });
    expect(classifyBearerRequest("/api/issues", "Basic abc")).toEqual({ kind: "none" });
  });

  it("keeps the agent-specific classifier aligned with the shared dispatch contract", () => {
    const path = `/mcp/gateways/gw_${"a".repeat(32)}`;
    const authorization = "Bearer pcgw_runtime_token";
    expect(classifyAgentCredentials(path, authorization)).toEqual({
      kind: "gateway",
      token: "pcgw_runtime_token",
    });
    expect(classifyBearerRequest(path, authorization)).toEqual({
      kind: "gateway",
      token: "pcgw_runtime_token",
    });
  });
});
