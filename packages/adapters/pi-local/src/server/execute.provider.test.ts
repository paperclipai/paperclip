import { describe, expect, it } from "vitest";
import { parseModelProvider } from "./execute.js";

describe("parseModelProvider", () => {
  it("infers google provider for bare gemini-* model names", () => {
    expect(parseModelProvider("gemini-3.7-flash")).toBe("google");
    expect(parseModelProvider("gemini-1.5-pro")).toBe("google");
    expect(parseModelProvider("gemini-flash")).toBe("google");
  });

  it("is case-insensitive for bare gemini-* names", () => {
    expect(parseModelProvider("GEMINI-3.7-flash")).toBe("google");
    expect(parseModelProvider("Gemini-2.0")).toBe("google");
  });

  it("honours explicit provider prefix — google/model stays google", () => {
    expect(parseModelProvider("google/gemini-3.7-flash")).toBe("google");
  });

  it("honours explicit provider prefix even when it does not match the model name pattern", () => {
    // An unlikely combination, but the prefix must win.
    expect(parseModelProvider("openai/gemini-flash")).toBe("openai");
    expect(parseModelProvider("anthropic/gemini-flash")).toBe("anthropic");
  });

  it("returns null for model names that do not match any known pattern and have no prefix", () => {
    expect(parseModelProvider("claude-3-5-sonnet")).toBeNull();
    expect(parseModelProvider("gpt-4o")).toBeNull();
    expect(parseModelProvider("llama3")).toBeNull();
  });

  it("returns null for null or empty input", () => {
    expect(parseModelProvider(null)).toBeNull();
    expect(parseModelProvider("")).toBeNull();
    expect(parseModelProvider("   ")).toBeNull();
  });
});
