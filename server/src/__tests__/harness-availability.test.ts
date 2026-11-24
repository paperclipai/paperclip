import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { getAvailableHarnesses } from "../services/harness-availability.js";

describe("deployment harness availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has no built-in deployment allowlist", () => {
    expect(getAvailableHarnesses({})).toBeUndefined();
  });

  it("accepts deployment-chosen IDs and refreshes when configuration changes", () => {
    const env = { PAPERCLIP_AVAILABLE_HARNESSES: '["gemini_local","plugin:example","gemini_local"]' };
    expect(getAvailableHarnesses(env)).toEqual(["gemini_local", "plugin:example"]);
    env.PAPERCLIP_AVAILABLE_HARNESSES = '["pi_local"]';
    expect(getAvailableHarnesses(env)).toEqual(["pi_local"]);
    env.PAPERCLIP_AVAILABLE_HARNESSES = "[]";
    expect(getAvailableHarnesses(env)).toEqual([]);
    expect(getAvailableHarnesses({})).toBeUndefined();
  });

  it.each(["", "claude_local", "{}", "null", '["valid",1]', '["Invalid"]', '["has space"]', JSON.stringify(["a".repeat(129)]), JSON.stringify(Array(129).fill("codex_local")), " ".repeat(16_385)])(
    "fails closed for malformed configuration %# without logging its value", raw => {
      getAvailableHarnesses({});
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(getAvailableHarnesses({ PAPERCLIP_AVAILABLE_HARNESSES: raw })).toEqual([]);
      expect(warn).toHaveBeenCalledExactlyOnceWith("PAPERCLIP_AVAILABLE_HARNESSES is invalid; harness selection is disabled");
    },
  );
});
