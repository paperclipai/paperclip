import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, isCodexLocalFastModeSupported, models } from "./index.js";

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
});
