import { describe, expect, it } from "vitest";
import { defaultInstructionsPathKeyForAdapter } from "../routes/agents.js";

describe("defaultInstructionsPathKeyForAdapter", () => {
  it("maps local instruction-file adapters to instructionsFilePath", () => {
    expect(defaultInstructionsPathKeyForAdapter("claude_local")).toBe("instructionsFilePath");
    expect(defaultInstructionsPathKeyForAdapter("codex_local")).toBe("instructionsFilePath");
    expect(defaultInstructionsPathKeyForAdapter("gemini_local")).toBe("instructionsFilePath");
    expect(defaultInstructionsPathKeyForAdapter("opencode_local")).toBe("instructionsFilePath");
    expect(defaultInstructionsPathKeyForAdapter("pi_local")).toBe("instructionsFilePath");
    expect(defaultInstructionsPathKeyForAdapter("cursor")).toBe("instructionsFilePath");
  });

  it("returns null when an adapter has no default instructions key", () => {
    expect(defaultInstructionsPathKeyForAdapter("process")).toBeNull();
  });
});
