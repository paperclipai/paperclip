import { describe, expect, it } from "vitest";
import {
  applyCodexLocalWorkerDefaults,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
  models,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("defaults workers to Terra at xhigh without advertising unsupported gpt-5.3-codex", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-terra");
    expect(DEFAULT_CODEX_LOCAL_REASONING_EFFORT).toBe("xhigh");
    expect(applyCodexLocalWorkerDefaults({})).toMatchObject({
      model: "gpt-5.6-terra",
      modelReasoningEffort: "xhigh",
    });
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
  });

  it("preserves explicit worker model and reasoning overrides", () => {
    expect(
      applyCodexLocalWorkerDefaults({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    ).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "high" });
  });
});
