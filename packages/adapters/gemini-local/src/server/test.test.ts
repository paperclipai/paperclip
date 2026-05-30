import { describe, expect, it } from "vitest";
import { parseGeminiDirectApiBody } from "./test.js";

describe("parseGeminiDirectApiBody", () => {
  it("detects OK text in a standard Gemini v1beta response", () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "OK" }],
            role: "model",
          },
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    });
    expect(parseGeminiDirectApiBody(body).hasOkText).toBe(true);
  });

  it("detects OK text case-insensitively", () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    expect(parseGeminiDirectApiBody(body).hasOkText).toBe(true);
  });

  it("returns false when text does not contain OK", () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hello world" }] } }],
    });
    expect(parseGeminiDirectApiBody(body).hasOkText).toBe(false);
  });

  it("returns false on empty response body", () => {
    expect(parseGeminiDirectApiBody("").hasOkText).toBe(false);
  });

  it("returns false on malformed JSON", () => {
    expect(parseGeminiDirectApiBody("not-json").hasOkText).toBe(false);
  });

  it("returns false when candidates array is empty", () => {
    const body = JSON.stringify({ candidates: [] });
    expect(parseGeminiDirectApiBody(body).hasOkText).toBe(false);
  });

  it("tolerates thoughtSignature field in candidate content", () => {
    const body = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "OK", thoughtSignature: "AXX8Cw==" }],
            role: "model",
          },
          modelVersion: "gemini-3.5-flash-001",
          responseId: "resp-abc",
        },
      ],
    });
    expect(parseGeminiDirectApiBody(body).hasOkText).toBe(true);
  });

  it("does not expose API key values (pure parsing — no network calls)", () => {
    // This test documents that parseGeminiDirectApiBody is a pure parser
    // that never receives or logs the API key — it only parses response bodies.
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "OK" }] } }],
    });
    const result = parseGeminiDirectApiBody(body);
    expect(typeof result.hasOkText).toBe("boolean");
    // No API key fields appear in the result
    expect(Object.keys(result)).not.toContain("apiKey");
    expect(Object.keys(result)).not.toContain("key");
  });
});
