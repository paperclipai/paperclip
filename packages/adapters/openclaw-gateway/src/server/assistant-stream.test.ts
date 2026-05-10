import { describe, expect, it } from "vitest";
import { pickAssistantChunk } from "./assistant-stream.js";

describe("pickAssistantChunk", () => {
  it("preserves the leading space on BPE-style word-tokens", () => {
    // Qwen3 / GPT / Llama-family BPE tokenizers emit word-tokens with a
    // leading space. `nonEmpty()` (which trims its argument) used to drop
    // those leading spaces, producing run-on output like
    // "ItseemsthereisapersistentissuewiththePythoncommandsyntax". The
    // chunk picker must keep every byte intact.
    const deltas = ["It", " seems", " there", " is", " a", " persistent", " issue"];
    const joined = deltas
      .map((delta) => pickAssistantChunk({ delta }))
      .filter((chunk): chunk is string => chunk !== null)
      .join("");

    expect(joined).toBe("It seems there is a persistent issue");
    // Six inter-word spaces; pre-fix this was 0.
    expect(joined.match(/ /g)?.length).toBe(6);
  });

  it("preserves a single-space delta (length > 0)", () => {
    expect(pickAssistantChunk({ delta: " " })).toBe(" ");
    expect(pickAssistantChunk({ delta: "   " })).toBe("   ");
  });

  it("drops zero-length deltas and falls back to text", () => {
    expect(pickAssistantChunk({ delta: "" })).toBeNull();
    expect(pickAssistantChunk({ delta: "", text: "fallback" })).toBe("fallback");
  });

  it("drops zero-length text", () => {
    expect(pickAssistantChunk({ text: "" })).toBeNull();
    expect(pickAssistantChunk({})).toBeNull();
  });

  it("ignores non-string delta and text values", () => {
    expect(pickAssistantChunk({ delta: 42 })).toBeNull();
    expect(pickAssistantChunk({ delta: null })).toBeNull();
    expect(pickAssistantChunk({ delta: undefined })).toBeNull();
    expect(pickAssistantChunk({ text: { raw: "x" } })).toBeNull();
    // delta is non-string but text is valid → should fall back to text.
    expect(pickAssistantChunk({ delta: 42, text: "fallback" })).toBe("fallback");
  });

  it("prefers delta over text when both are present", () => {
    expect(pickAssistantChunk({ delta: "from-delta", text: "from-text" })).toBe("from-delta");
  });

  it("keeps newlines and other whitespace intact", () => {
    expect(pickAssistantChunk({ delta: "\n" })).toBe("\n");
    expect(pickAssistantChunk({ delta: "line\nwith\tcontrol" })).toBe("line\nwith\tcontrol");
  });
});
