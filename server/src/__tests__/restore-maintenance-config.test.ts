import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("restore maintenance mode config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is disabled unless explicitly enabled for this process", () => {
    vi.stubEnv("PAPERCLIP_RESTORE_MAINTENANCE_MODE", undefined);

    expect(loadConfig().restoreMaintenanceMode).toBe(false);
  });

  it("enables only for the exact true value", () => {
    vi.stubEnv("PAPERCLIP_RESTORE_MAINTENANCE_MODE", "true");
    expect(loadConfig().restoreMaintenanceMode).toBe(true);

    vi.stubEnv("PAPERCLIP_RESTORE_MAINTENANCE_MODE", "TRUE");
    expect(loadConfig().restoreMaintenanceMode).toBe(false);
  });
});
