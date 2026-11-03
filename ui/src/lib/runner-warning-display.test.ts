import { afterEach, expect, it } from "vitest";
import { normalizeClaudeRunnerOptions } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { runnerWarningDisplay } from "./runner-warning-display";

afterEach(async () => { await i18n.changeLanguage("en"); });
it("translates pinned notices while preserving normalization, field IDs and custom diagnostics", async () => {
  const config = { maxTurnsPerRun: 20, chrome: true, warmHandleIdleMs: 10, acpWarmHandleIdleMs: 15, env: { RAW: "{{VALUE}}" } };
  const before = JSON.stringify(config), normalized = normalizeClaudeRunnerOptions(config);
  expect(normalized.config).toEqual({ env: { RAW: "{{VALUE}}" } });
  expect(normalized.warnings).toHaveLength(4);
  const originalWarnings = JSON.stringify(normalized.warnings);
  for (const language of ["en", "ru", "en"]) {
    await i18n.changeLanguage(language);
    for (const warning of normalized.warnings) {
      const displayed = runnerWarningDisplay(warning);
      expect(displayed).toContain(warning.field); expect(displayed).toContain("Paperclip Runner");
      expect(displayed).toContain(language === "ru" ? "игнорируется" : "ignored");
      expect(runnerWarningDisplay({ ...warning, message: "Custom {{RAW}} <diagnostic>" })).toBe("Custom {{RAW}} <diagnostic>");
      expect(runnerWarningDisplay({ ...warning, field: "constructor" })).toBe(warning.message);
    }
  }
  expect(JSON.stringify(config)).toBe(before); expect(JSON.stringify(normalized.warnings)).toBe(originalWarnings);
});
