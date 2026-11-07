import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
function fixture(rows: Array<{ experimental: unknown }> = []) {
  const mutation = vi.fn(() => { throw new Error("read-only settings inspection mutated state"); });
  const select = vi.fn(() => ({ from: () => ({ where: async () => rows }) }));
  return { db: { select, insert: mutation, update: mutation, delete: mutation, execute: mutation } as unknown as Db, mutation, select };
}
describe("read-only experimental settings view", () => {
  it("returns disabled public-MCP defaults without creating a missing singleton", async () => {
    const f = fixture();
    const value = await instanceSettingsService(f.db,{ runtimeEnv: {} }).getExperimentalReadOnly();
    expect(value.enablePublicMcp).toBe(false);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("preserves the existing managed overlay on missing and stored rows", async () => {
    const runtimeEnv = { PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "test",
      features: { enablePublicMcp: true, enableOpenAiDot: true }, plugins: { autoInstall: [] } }) };
    for (const rows of [[], [{ experimental: { enablePublicMcp: false } }]]) {
      const f = fixture(rows);
      const value = await instanceSettingsService(f.db,{ runtimeEnv }).getExperimentalReadOnly();
      expect(value.enablePublicMcp).toBe(true); expect(value.enableOpenAiDot).toBe(true);
      expect(f.mutation).not.toHaveBeenCalled();
    }
  });
});
