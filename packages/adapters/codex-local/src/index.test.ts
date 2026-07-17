import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, models } from "./index.js";

describe("codex local adapter metadata", () => {
  it("does not advertise the ChatGPT-unsupported gpt-5.3-codex model as a default option", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.5");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
  });
});
