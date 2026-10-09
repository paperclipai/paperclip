import { describe, expect, it } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import { parseOpenCodeReasoningMode } from "./reasoning-mode.js";

describe("explicit OpenCode reasoning mode", () => {
  it.each([undefined, "", "default"])("preserves provider defaults for %s", (value) => {
    expect(parseOpenCodeReasoningMode(value)).toBe("default");
  });
  it("accepts disabled and rejects misspelled settings", () => {
    expect(parseOpenCodeReasoningMode("disabled")).toBe("disabled");
    expect(() => parseOpenCodeReasoningMode("false")).toThrow("must be default or disabled");
  });
  it("rejects unsupported providers before starting a process", () => {
    expect(() => new OpenCodeServerDriver({
      model: "anthropic/claude-sonnet-5",
      runtimeDirectory: "/unused",
      reasoningMode: "disabled",
    })).toThrow("only for OpenRouter");
  });
});
