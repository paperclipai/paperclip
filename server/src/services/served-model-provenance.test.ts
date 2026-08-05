import { describe, expect, it } from "vitest";
import { buildServedModelProvenance } from "./served-model-provenance.js";

describe("buildServedModelProvenance", () => {
  it("persists a served model and emits a drift guard finding", () => {
    expect(buildServedModelProvenance({
      declaredModel: "claude-opus-4-6",
      servedModel: "gpt-5.4",
    })).toEqual({
      declaredModel: "claude-opus-4-6",
      servedModel: "gpt-5.4",
      guardFindings: [{
        code: "served_model_drift",
        declaredModel: "claude-opus-4-6",
        servedModel: "gpt-5.4",
      }],
    });
  });

  it("records unknown when the adapter cannot report a served model", () => {
    expect(buildServedModelProvenance({ declaredModel: "gpt-5.4", servedModel: null })).toEqual({
      declaredModel: "gpt-5.4",
      servedModel: "unknown",
      guardFindings: [],
    });
  });
});
