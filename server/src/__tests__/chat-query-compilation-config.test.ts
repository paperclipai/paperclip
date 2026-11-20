import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

describe("chat idle optimization configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, "false", "", "1", "TRUE", " true "])("does not enable reuse for %s", (value) => {
    vi.stubEnv("PAPERCLIP_CHAT_IDLE_OPTIMIZATIONS", value);
    expect(loadConfig().chatIdleOptimizations).toBe(false);
  });
  it("does not accept the unpublished old flag", () => {
    vi.stubEnv("PAPERCLIP_CHAT_IDLE_OPTIMIZATIONS", undefined);
    vi.stubEnv("PAPERCLIP_CHAT_QUERY_COMPILATION_REUSE", "true");
    expect(loadConfig().chatIdleOptimizations).toBe(false);
  });
  it("enables reuse only for true", () => {
    vi.stubEnv("PAPERCLIP_CHAT_IDLE_OPTIMIZATIONS", "true");
    expect(loadConfig().chatIdleOptimizations).toBe(true);
  });
});
