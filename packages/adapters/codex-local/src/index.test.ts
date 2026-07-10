import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  codexLocalThinkingEffortsForModel,
  isCodexLocalFastModeSupported,
  models,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("does not advertise the ChatGPT-unsupported gpt-5.3-codex model as a default option", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.5");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
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
