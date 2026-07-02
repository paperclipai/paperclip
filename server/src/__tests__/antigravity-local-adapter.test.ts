import { describe, expect, it } from "vitest";
import {
  findServerAdapter,
  listAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";

describe("antigravity_local adapter registration", () => {
  it("ships antigravity_local as a built-in server adapter with agy model labels", async () => {
    const adapter = requireServerAdapter("antigravity_local");

    expect(findServerAdapter("antigravity_local")).toBe(adapter);
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(true);
    expect(adapter.sessionCodec).toBeDefined();

    await expect(listAdapterModels("antigravity_local")).resolves.toEqual([
      { id: "auto", label: "Auto" },
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
      { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)" },
      { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash (Low)" },
      { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro (Low)" },
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
      { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
      { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" },
      { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B (Medium)" },
    ]);
  });
});
