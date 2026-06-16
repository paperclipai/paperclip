import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(),
}));

const { logActivity } = await import("../services/activity-log.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");
const {
  runQuotaExhaustedHook,
  __resetQuotaExhaustedHookStateForTesting,
} = await import("../services/quota-exhausted-hook.js");

const fakeDb = {} as unknown as Db;

function mockSettings(quotaExhaustedCmd: string | null) {
  vi.mocked(instanceSettingsService).mockReturnValue({
    getGeneral: vi.fn().mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      quotaExhaustedCmd,
      preRunCmd: null,
      postRunCmd: null,
    }),
  } as any);
}

beforeEach(() => {
  __resetQuotaExhaustedHookStateForTesting();
  delete process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD;
  delete process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV;
  delete process.env.CCROTATE_STATE_URL;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runQuotaExhaustedHook", () => {
  it("skips when no command configured and env fallback disabled", async () => {
    mockSettings(null);
    const onSuccess = vi.fn();

    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: "r1",
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
      onSuccess,
    });

    expect(result.status).toBe("skipped");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("skips env-var fallback when PAPERCLIP_QUOTA_HOOK_ALLOW_ENV is not set", async () => {
    mockSettings(null);
    process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD = "true";

    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: null,
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
    });

    expect(result.status).toBe("skipped");
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("uses env-var command when ALLOW_ENV=1 and no setting", async () => {
    mockSettings(null);
    process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD = "true";
    process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV = "1";

    const onSuccess = vi.fn();
    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: "r1",
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
      onSuccess,
    });

    expect(result.status).toBe("ran");
    expect(result.result?.ok).toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "instance.quota_exhausted_hook_fired",
        agentId: "a1",
        companyId: "c1",
        runId: "r1",
        details: expect.objectContaining({ source: "env", ok: true }),
      }),
    );
  });

  it("prefers instance setting over env var", async () => {
    mockSettings("true");
    process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD = "false";
    process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV = "1";

    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: null,
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
    });

    expect(result.status).toBe("ran");
    expect(result.result?.ok).toBe(true);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ source: "instance_settings" }),
      }),
    );
  });

  it("drops legacy local ccrotate fragments when using the state server", async () => {
    process.env.CCROTATE_STATE_URL = "http://ccrotate-state.local:4002";
    mockSettings("node -e \"process.stdout.write('relogin')\"; ccrotate --target codex next --yes");
    const onSuccess = vi.fn();

    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: "r1",
      errorCode: "provider_quota_exhausted",
      adapterType: "opencode_k8s",
      onSuccess,
    });

    expect(result.status).toBe("ran");
    expect(result.result?.ok).toBe(true);
    expect(result.result?.stdout).toBe("relogin");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("debounces concurrent calls within 60s window", async () => {
    mockSettings("true");

    const first = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: null,
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
    });
    expect(first.status).toBe("ran");
    expect(logActivity).toHaveBeenCalledTimes(1);

    const onSuccess = vi.fn();
    const second = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a2",
      companyId: "c1",
      runId: null,
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
      onSuccess,
    });

    expect(second.status).toBe("debounced");
    // Activity log only written for the actual run (debounced calls don't produce duplicate audit rows).
    expect(logActivity).toHaveBeenCalledTimes(1);
    // Debounced call still triggers onSuccess so the agent gets re-woken.
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("records failure when command exits non-zero", async () => {
    mockSettings("false");
    const onSuccess = vi.fn();

    const result = await runQuotaExhaustedHook({
      db: fakeDb,
      agentId: "a1",
      companyId: "c1",
      runId: null,
      errorCode: "provider_quota_exhausted",
      adapterType: "test",
      onSuccess,
    });

    expect(result.status).toBe("ran");
    expect(result.result?.ok).toBe(false);
    expect(result.result?.exitCode).toBe(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ ok: false, exitCode: 1 }),
      }),
    );
  });
});
