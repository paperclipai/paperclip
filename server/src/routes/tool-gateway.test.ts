import { describe, expect, it } from "vitest";
import { buildMcpToolCallResult } from "./tool-gateway.js";

describe("buildMcpToolCallResult", () => {
  it("keeps the existing contract for ordinary results", () => {
    expect(
      buildMcpToolCallResult({ content: "ok", data: { rows: [1] } }, null),
    ).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { rows: [1] },
      isError: false,
    });
    expect(buildMcpToolCallResult(null, { error: "boom" })).toEqual({
      content: [{ type: "text", text: '{"error":"boom"}' }],
      structuredContent: null,
      isError: false,
    });
  });

  it("flags timeouts structurally instead of burying them in text", () => {
    expect(
      buildMcpToolCallResult(
        { content: "timed out", timedOut: true, timeoutMs: 5000 },
        null,
      ),
    ).toEqual({
      content: [{ type: "text", text: "timed out" }],
      structuredContent: { data: null, timedOut: true, timeoutMs: 5000 },
      isError: true,
    });
  });

  it("omits a non-numeric timeout budget", () => {
    const result = buildMcpToolCallResult(
      { content: "timed out", timedOut: true, timeoutMs: "soon" },
      null,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ data: null, timedOut: true });
  });
});
