import { describe, expect, it } from "vitest";
import { DEFAULT_COPILOT_LOCAL_MODEL, models } from "./index.js";

describe("copilot_local metadata", () => {
  it("defaults to the verified Copilot model and keeps auto selection available", () => {
    expect(DEFAULT_COPILOT_LOCAL_MODEL).toBe("gpt-5.6-sol");
    expect(models[0]?.id).toBe(DEFAULT_COPILOT_LOCAL_MODEL);
    expect(models.some((model) => model.id === "auto")).toBe(true);
  });
});
