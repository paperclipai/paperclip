import { expect, it } from "vitest";
import { resolveClaudeRuntimeSettings } from "./runtime-settings.js";

it("keeps defaults and resolves legacy bindings without overriding typed off choices", () => {
  expect(resolveClaudeRuntimeSettings({})).toEqual({ profileImportMode: "off", profileSourceDir: "", transcriptRetentionEnabled: false, transcriptRetentionDays: 7 });
  const env = {
    PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: { type: "plain", value: "cache" },
    PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR: "/personal",
    PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_ENABLED: "true",
    PAPERCLIP_MANAGED_CLAUDE_TRANSCRIPT_RETENTION_DAYS: "14",
  };
  expect(resolveClaudeRuntimeSettings({}, env)).toEqual({ profileImportMode: "cache", profileSourceDir: "/personal", transcriptRetentionEnabled: true, transcriptRetentionDays: 14 });
  expect(resolveClaudeRuntimeSettings({ profileImportMode: "off", profileSourceDir: "", transcriptRetentionEnabled: false, transcriptRetentionDays: 3 }, env))
    .toEqual({ profileImportMode: "off", profileSourceDir: "", transcriptRetentionEnabled: false, transcriptRetentionDays: 3 });
});


it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid retention days %s", (days) => {
  expect(() => resolveClaudeRuntimeSettings({ transcriptRetentionDays: days })).toThrow("positive integer");
});
