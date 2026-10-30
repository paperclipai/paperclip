import { describe, expect, it } from "vitest";
import { resolveToolExecutionTimeoutMs } from "./tool-gateway.js";

describe("tool gateway execution timeout", () => {
  it("gives local stdio MCP tools the maximum timeout when the caller omits one", () => {
    expect(resolveToolExecutionTimeoutMs(undefined, { providerType: "mcp_local_stdio" })).toBe(60_000);
  });

  it("honors an explicit shorter timeout for local stdio MCP tools", () => {
    expect(resolveToolExecutionTimeoutMs(2_500, { providerType: "mcp_local_stdio" })).toBe(2_500);
  });

  it("keeps the generic default timeout for remote MCP tools", () => {
    expect(resolveToolExecutionTimeoutMs(undefined, { providerType: "mcp_remote_http" })).toBe(10_000);
  });
});
