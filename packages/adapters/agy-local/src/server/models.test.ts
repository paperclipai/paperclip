import { describe, expect, it } from "vitest";
import { parseAgyModelsOutput } from "./models.js";

describe("parseAgyModelsOutput", () => {
  it("parses model id and label correctly", () => {
    const rawOutput = `
⠋ Fetching available models...⠙ Fetching available models...gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
    const models = parseAgyModelsOutput(rawOutput);
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
  });
});
