import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildGatewayToolCallResult } from "./tool-gateway-mcp-result.js";

describe("buildGatewayToolCallResult", () => {
  it.each(["mcp_http", "local_stdio", "cognee_cloud"])("preserves native images and text from governed %s content", (transport) => {
    const content = [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "cGl4ZWxz" }];
    const result = buildGatewayToolCallResult({ text: JSON.stringify(content), structuredContent: { content, transport, structuredContent: { width: 1 }, isError: false } });
    expect(CallToolResultSchema.parse(result).content).toEqual(content);
    expect(result.structuredContent).toEqual({ transport, structuredContent: { width: 1 }, isError: false });
    expect(JSON.stringify(result.structuredContent)).not.toContain("cGl4ZWxz");
  });

  it("does not promote arbitrary structured data into provider content", () => {
    const result = buildGatewayToolCallResult({ text: "governed response", structuredContent: { content: [{ type: "image", mimeType: "image/png", data: "pixels" }] } });
    expect(result.content).toEqual([{ type: "text", text: "governed response" }]);
  });

  it("falls back to governed text when provider blocks are malformed", () => {
    const result = buildGatewayToolCallResult({ text: "redacted response", structuredContent: { transport: "mcp_http", content: [{ type: "image", data: null }] }, isError: true });
    expect(result.content).toEqual([{ type: "text", text: "redacted response" }]);
    expect(result.isError).toBe(true);
  });

  it("preserves provider errors", () => {
    const result = buildGatewayToolCallResult({ text: "failed", structuredContent: { transport: "mcp_http", content: [{ type: "text", text: "failed" }], isError: true } });
    expect(result.isError).toBe(true);
  });
  it.each([undefined, null, "scalar", 7, true, ["array"]])(
    "omits invalid structuredContent for %s while preserving the text result",
    (structuredContent) => {
      const result = buildGatewayToolCallResult({ text: "provider response", structuredContent });
      expect(CallToolResultSchema.parse(result)).toEqual({
        content: [{ type: "text", text: "provider response" }],
        isError: false,
      });
    },
  );

  it("preserves object structuredContent and error results", () => {
    const result = buildGatewayToolCallResult({
      text: "provider error details",
      structuredContent: { code: "provider_failed" },
      isError: true,
    });
    expect(CallToolResultSchema.parse(result)).toEqual({
      content: [{ type: "text", text: "provider error details" }],
      structuredContent: { code: "provider_failed" },
      isError: true,
    });
  });
});
