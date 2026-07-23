import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  codexLocalThinkingEffortsForModel,
  isCodexLocalFastModeSupported,
  models,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises current GPT-5.6 Codex-capable OpenAI models by default", () => {
    const modelIds = models.map((model) => model.id);

    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6");
    expect(modelIds.slice(0, 4)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
  });

  it("advertises the GPT-5.6 Codex family", () => {
    expect(models).toEqual(expect.arrayContaining([
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna" },
    ]));
  });

  it("advertises model-specific Codex thinking efforts", () => {
    expect(codexLocalThinkingEffortsForModel("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(codexLocalThinkingEffortsForModel("gpt-5.6-terra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(codexLocalThinkingEffortsForModel("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(codexLocalThinkingEffortsForModel("gpt-5.5")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("keeps fast mode enabled for the GPT-5.6 Codex family", () => {
    expect(isCodexLocalFastModeSupported("gpt-5.6-sol")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-5.6-terra")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-5.6-luna")).toBe(true);
  });
});
