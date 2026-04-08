import { describe, expect, it } from "vitest";
import { parsePixelJsonl } from "./parse.js";

describe("parsePixelJsonl", () => {
  it("extracts session and assistant summary from stream-json lines", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "pixel-pro",
      }),
      JSON.stringify({
        type: "assistant",
        message: { text: "Hello from Pixel" },
      }),
      JSON.stringify({
        type: "result",
        result: "done",
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
        is_error: false,
      }),
    ].join("\n");

    const parsed = parsePixelJsonl(stdout);
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.summary).toContain("Hello from Pixel");
    expect(parsed.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(parsed.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });
});
