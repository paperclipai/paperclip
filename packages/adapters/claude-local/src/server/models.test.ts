import { afterEach, describe, expect, it, vi } from "vitest";
import { detectClaudeModel } from "./models.js";

describe("detectClaudeModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the host ANTHROPIC_MODEL override", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", " claude-opus-5-5 ");
    await expect(detectClaudeModel()).resolves.toEqual({
      model: "claude-opus-5-5",
      provider: "anthropic",
      source: "env:ANTHROPIC_MODEL",
    });
  });

  it("returns null when no override is set", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    await expect(detectClaudeModel()).resolves.toBeNull();
  });
});
