import { describe, expect, it } from "vitest";
import { isCodexLocalFastModeSupported, isCodexLocalKnownModel, models } from "./index.js";

describe("codex local adapter model metadata", () => {
  it("lists GPT-5.5 as a known fast-mode capable Codex model", () => {
    expect(models.map((model) => model.id)).toContain("gpt-5.5");
    expect(isCodexLocalKnownModel("gpt-5.5")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-5.5")).toBe(true);
  });
});
