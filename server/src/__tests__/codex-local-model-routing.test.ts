import { describe, expect, it } from "vitest";
import { resolveCodexModelForBilling } from "@paperclipai/adapter-codex-local/server";

describe("codex local model routing", () => {
  it("keeps ChatGPT-account compatible Codex models unchanged", () => {
    expect(resolveCodexModelForBilling("gpt-5.5", "subscription")).toBe("gpt-5.5");
    expect(resolveCodexModelForBilling("gpt-5.4", "subscription")).toBe("gpt-5.4");
    expect(resolveCodexModelForBilling("gpt-5.3-codex-spark", "subscription")).toBe("gpt-5.3-codex-spark");
    expect(resolveCodexModelForBilling("codex-mini-latest", "subscription")).toBe("codex-mini-latest");
  });

  it("falls back from ChatGPT-account models rejected by Codex local", () => {
    expect(resolveCodexModelForBilling("o4-mini", "subscription")).toBe("gpt-5.3-codex-spark");
    expect(resolveCodexModelForBilling("gpt-5-mini", "subscription")).toBe("gpt-5.3-codex-spark");
    expect(resolveCodexModelForBilling("gpt-5-nano", "subscription")).toBe("gpt-5.3-codex-spark");
    expect(resolveCodexModelForBilling("gpt-5.4-mini", "subscription")).toBe("gpt-5.3-codex-spark");
  });

  it("does not rewrite API-key backed Codex models", () => {
    expect(resolveCodexModelForBilling("o4-mini", "api")).toBe("o4-mini");
    expect(resolveCodexModelForBilling("gpt-5-mini", "api")).toBe("gpt-5-mini");
    expect(resolveCodexModelForBilling("custom-future-codex-model", "api")).toBe("custom-future-codex-model");
  });
});
