import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

describe("skill version retention config parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the defaults when the variables are not set", () => {
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_KEEP", undefined);
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES", undefined);
    expect(loadConfig()).toMatchObject({ skillVersionRetentionKeepNewest: 0, skillVersionRetentionGraceMinutes: 60 });
  });

  it("accepts explicit non-negative values, including 0", () => {
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_KEEP", " 0 ");
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES", "30");
    expect(loadConfig()).toMatchObject({ skillVersionRetentionKeepNewest: 0, skillVersionRetentionGraceMinutes: 30 });
  });

  it.each(["", "   ", "-1", "many"])("falls back to the defaults for %j", (value) => {
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_KEEP", value);
    vi.stubEnv("PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES", value);
    expect(loadConfig()).toMatchObject({ skillVersionRetentionKeepNewest: 0, skillVersionRetentionGraceMinutes: 60 });
  });
});
