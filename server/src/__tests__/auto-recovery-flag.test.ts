import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(),
}));

import { isAutoRecoveryIssuesEnabled } from "../services/auto-recovery-flag.ts";
import { instanceSettingsService } from "../services/instance-settings.js";

const mockedInstanceSettingsService = vi.mocked(instanceSettingsService);

function stubExperimental(autoRecoveryIssues: boolean) {
  mockedInstanceSettingsService.mockReturnValue({
    getExperimental: vi.fn(async () => ({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
      autoRecoveryIssues,
    })),
  } as unknown as ReturnType<typeof instanceSettingsService>);
}

describe("isAutoRecoveryIssuesEnabled", () => {
  let priorEnv: string | undefined;
  beforeEach(() => {
    priorEnv = process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES;
    delete process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES;
    mockedInstanceSettingsService.mockReset();
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES;
    else process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = priorEnv;
  });

  it("returns false by default when no env override and no instance setting opt-in", async () => {
    stubExperimental(false);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(false);
  });

  it("env override 'on' beats a disabled instance setting", async () => {
    process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = "on";
    stubExperimental(false);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(true);
  });

  it("env override 'off' beats an enabled instance setting", async () => {
    process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = "off";
    stubExperimental(true);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(false);
  });

  it("falls through to instance setting when env override is unrecognized", async () => {
    process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = "maybe";
    stubExperimental(true);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(true);
  });

  it.each(["true", "1", "yes", "ON"])("treats env value %s as enabled", async (raw) => {
    process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = raw;
    stubExperimental(false);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(true);
  });

  it.each(["false", "0", "no", "OFF"])("treats env value %s as disabled", async (raw) => {
    process.env.PAPERCLIP_AUTO_RECOVERY_ISSUES = raw;
    stubExperimental(true);
    expect(await isAutoRecoveryIssuesEnabled({} as never)).toBe(false);
  });
});
