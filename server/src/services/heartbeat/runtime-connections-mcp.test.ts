import { describe, expect, it } from "vitest";
import { shouldOfferRuntimeConnectionsMcp } from "./runtime-connections-mcp.js";

describe("shouldOfferRuntimeConnectionsMcp", () => {
  it("offers the connections server to a task-bound native MCP run", () => {
    expect(shouldOfferRuntimeConnectionsMcp({ runtimeToolDelivery: "native_mcp", hasIssue: true })).toBe(true);
  });

  it("does not offer it to a run without an issue, which the endpoint rejects with 422", () => {
    expect(shouldOfferRuntimeConnectionsMcp({ runtimeToolDelivery: "native_mcp", hasIssue: false })).toBe(false);
  });

  it("does not offer it when the tools are delivered another way", () => {
    expect(shouldOfferRuntimeConnectionsMcp({ runtimeToolDelivery: "invocation_context", hasIssue: true })).toBe(false);
    expect(shouldOfferRuntimeConnectionsMcp({ runtimeToolDelivery: "environment", hasIssue: true })).toBe(false);
  });
});
