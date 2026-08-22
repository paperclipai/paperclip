import { describe, expect, it } from "vitest";

import { isPlaceholderModelId, normalizeRecordedModelId, UNKNOWN_MODEL_ID } from "./model-identity.js";

describe("isPlaceholderModelId", () => {
  it.each(["default", "Default", " AUTO ", "none", "unknown", "", "   "])(
    "treats %j as a selection policy, not a model",
    (value) => {
      expect(isPlaceholderModelId(value)).toBe(true);
    },
  );

  it.each([null, undefined])("treats %j as unattributed", (value) => {
    expect(isPlaceholderModelId(value)).toBe(true);
  });

  it.each(["claude-sonnet-5", "claude-fable-5[1m]", "opus[1m]", "gpt-5.6-sol", "sonnet", "haiku"])(
    "accepts the real model id %j",
    (value) => {
      expect(isPlaceholderModelId(value)).toBe(false);
    },
  );
});

describe("normalizeRecordedModelId", () => {
  it("passes a real model id through, trimmed", () => {
    expect(normalizeRecordedModelId("  claude-opus-5 ")).toBe("claude-opus-5");
  });

  it.each(["default", "auto", "none", "", null, undefined])(
    "records %j as unknown so the attribution gap stays visible",
    (value) => {
      expect(normalizeRecordedModelId(value)).toBe(UNKNOWN_MODEL_ID);
    },
  );

  it("never returns an empty string, so the not-null model column always has a value", () => {
    for (const value of ["", "   ", null, undefined, "default"]) {
      expect(normalizeRecordedModelId(value).length).toBeGreaterThan(0);
    }
  });
});
