import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_LIMIT_PROBE_CRON,
  CODEX_LIMIT_PROBE_TIMEZONE,
  codexLimitProbeService,
  profileLabelForHome,
  resolveProbeProfiles,
  matchesCronTickInTimeZone,
  looksLikeCodexUsageLimit,
} from "../services/codex-limit-probe.js";

describe("codex-limit-probe helpers", () => {
  describe("profileLabelForHome", () => {
    it("maps known c1/c2 paths to their canonical labels", () => {
      expect(profileLabelForHome("/paperclip/.codex-c1")).toBe("codex-c1");
      expect(profileLabelForHome("/paperclip/.codex-c2")).toBe("codex-c2");
    });

    it("falls back to 'custom-<base>' for sanitisable basenames", () => {
      expect(profileLabelForHome("/paperclip/.codex-staging")).toBe("custom-codex-staging");
      expect(profileLabelForHome("/tmp/myhome")).toBe("custom-myhome");
    });
  });

  describe("resolveProbeProfiles", () => {
    it("returns CODEX_HOME first, then CODEX_FALLBACK entries, deduplicated", () => {
      const profiles = resolveProbeProfiles({
        CODEX_HOME: "/paperclip/.codex-c1",
        CODEX_FALLBACK: "/paperclip/.codex-c1,/paperclip/.codex-c2",
      } as NodeJS.ProcessEnv);
      expect(profiles).toEqual([
        { label: "codex-c1", home: "/paperclip/.codex-c1" },
        { label: "codex-c2", home: "/paperclip/.codex-c2" },
      ]);
    });

    it("supports colon-separated CODEX_FALLBACK", () => {
      const profiles = resolveProbeProfiles({
        CODEX_HOME: "",
        CODEX_FALLBACK: "/paperclip/.codex-c1:/paperclip/.codex-c2",
      } as NodeJS.ProcessEnv);
      expect(profiles.map((p) => p.label)).toEqual(["codex-c1", "codex-c2"]);
    });

    it("ignores relative paths", () => {
      const profiles = resolveProbeProfiles({
        CODEX_HOME: "../bogus",
        CODEX_FALLBACK: "/paperclip/.codex-c1",
      } as NodeJS.ProcessEnv);
      expect(profiles).toEqual([{ label: "codex-c1", home: "/paperclip/.codex-c1" }]);
    });

    it("returns empty when nothing is configured", () => {
      expect(resolveProbeProfiles({} as NodeJS.ProcessEnv)).toEqual([]);
    });
  });

  describe("looksLikeCodexUsageLimit", () => {
    it("matches English usage-limit phrases", () => {
      expect(looksLikeCodexUsageLimit("you've hit your usage limit; try again at 5pm")).toBe(true);
      expect(looksLikeCodexUsageLimit("You have hit your usage limit")).toBe(true);
    });

    it("matches Portuguese usage-limit phrases", () => {
      expect(looksLikeCodexUsageLimit("Você atingiu o limite de mensagens por hoje.")).toBe(true);
      expect(looksLikeCodexUsageLimit("seu limite de uso será redefinido às 14:00")).toBe(true);
    });

    it("does not match unrelated stderr", () => {
      expect(looksLikeCodexUsageLimit("codex 0.123.4")).toBe(false);
      expect(looksLikeCodexUsageLimit("error: connection refused")).toBe(false);
    });
  });

  describe("matchesCronTickInTimeZone", () => {
    it("matches the documented `0 * * * *` cron at the top of the UTC hour", () => {
      const onHour = new Date("2026-01-15T17:00:00Z");
      expect(matchesCronTickInTimeZone(CODEX_LIMIT_PROBE_CRON, CODEX_LIMIT_PROBE_TIMEZONE, onHour)).toBe(true);
    });

    it("rejects ticks that are not on the 0th minute", () => {
      const offHour = new Date("2026-01-15T17:01:00Z");
      expect(matchesCronTickInTimeZone(CODEX_LIMIT_PROBE_CRON, CODEX_LIMIT_PROBE_TIMEZONE, offHour)).toBe(false);
      const offHour2 = new Date("2026-01-15T17:30:00Z");
      expect(matchesCronTickInTimeZone(CODEX_LIMIT_PROBE_CRON, CODEX_LIMIT_PROBE_TIMEZONE, offHour2)).toBe(false);
    });
  });
});

describe("codexLimitProbeService", () => {
  // We intentionally bypass the real DB by passing a tiny stub that
  // satisfies just the calls the probe makes via Drizzle's fluent builder.
  // This keeps the unit test fast and free of postgres.
  function makeDbStub(blockedRows: Array<{
    runId: string;
    companyId: string;
    agentId: string;
    issueId: string | null;
    adapterType: string;
    errorFamily: string | null;
  }>) {
    return {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(blockedRows),
          }),
        }),
      }),
    } as unknown as Parameters<typeof codexLimitProbeService>[0]["db"];
  }

  function makeHeartbeatStub() {
    return {
      retryScheduledRetryNow: vi.fn(async (input: { issueId: string }) => ({
        outcome: "promoted" as const,
        message: "ok",
        scheduledRetry: { runId: `run-for-${input.issueId}` },
      })),
    };
  }

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("skips silently when the cron is not due", async () => {
    const heartbeat = makeHeartbeatStub();
    const probe = codexLimitProbeService({
      db: makeDbStub([]),
      heartbeat,
      isDueAt: () => false,
      execFile: vi.fn() as never,
      resolveProfiles: () => [{ label: "codex-c1", home: "/paperclip/.codex-c1" }],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:30:00Z"));
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("cron_not_due");
    expect(heartbeat.retryScheduledRetryNow).not.toHaveBeenCalled();
  });

  it("skips silently when no codex_local scheduled_retry runs are blocked", async () => {
    const heartbeat = makeHeartbeatStub();
    const probe = codexLimitProbeService({
      db: makeDbStub([]),
      heartbeat,
      isDueAt: () => true,
      execFile: vi.fn() as never,
      resolveProfiles: () => [{ label: "codex-c1", home: "/paperclip/.codex-c1" }],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("no_blocked_runs");
    expect(heartbeat.retryScheduledRetryNow).not.toHaveBeenCalled();
  });

  it("skips when no profiles are configured even if blocked runs exist", async () => {
    const heartbeat = makeHeartbeatStub();
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-1",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: vi.fn() as never,
      resolveProfiles: () => [],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("no_profiles_configured");
    expect(heartbeat.retryScheduledRetryNow).not.toHaveBeenCalled();
  });

  it("filters out runs whose contextSnapshot.errorFamily is not transient_upstream", async () => {
    const heartbeat = makeHeartbeatStub();
    const execFile = vi.fn(async () => ({ stdout: "codex 0.123.4\n", stderr: "" }));
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-not-transient",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "max_turn",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: execFile as never,
      resolveProfiles: () => [{ label: "codex-c1", home: "/paperclip/.codex-c1" }],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe("no_blocked_runs");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not accelerate any retry when both profiles still report usage_limit", async () => {
    const heartbeat = makeHeartbeatStub();
    const execFile = vi.fn(async () => {
      const error = new Error("Command exited 1") as Error & { stdout: string; stderr: string };
      error.stdout = "";
      error.stderr = "you've hit your usage limit; try again at 5pm";
      throw error;
    });
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-1",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: execFile as never,
      resolveProfiles: () => [
        { label: "codex-c1", home: "/paperclip/.codex-c1" },
        { label: "codex-c2", home: "/paperclip/.codex-c2" },
      ],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(true);
    expect(result.acceleratedRunCount).toBe(0);
    expect(result.profiles.map((p) => p.status)).toEqual(["usage_limit", "usage_limit"]);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(heartbeat.retryScheduledRetryNow).not.toHaveBeenCalled();
  });

  it("accelerates each unique blocked issue when at least one profile recovers", async () => {
    const heartbeat = makeHeartbeatStub();
    const execFile = vi.fn(async (_bin: string, _args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
      // c1 still exhausted; c2 recovered
      if (opts.env.CODEX_HOME === "/paperclip/.codex-c1") {
        const err = new Error("Command exited 1") as Error & { stdout: string; stderr: string };
        err.stdout = "";
        err.stderr = "you've hit your usage limit";
        throw err;
      }
      return { stdout: "codex 0.123.4\n", stderr: "" };
    });
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-1",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
        {
          runId: "run-2",
          companyId: "c-1",
          agentId: "a-2",
          issueId: "issue-2",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
        {
          // duplicate issueId — should be deduped
          runId: "run-3",
          companyId: "c-1",
          agentId: "a-3",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: execFile as never,
      resolveProfiles: () => [
        { label: "codex-c1", home: "/paperclip/.codex-c1" },
        { label: "codex-c2", home: "/paperclip/.codex-c2" },
      ],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(true);
    expect(result.profiles).toEqual([
      { label: "codex-c1", home: "/paperclip/.codex-c1", status: "usage_limit" },
      { label: "codex-c2", home: "/paperclip/.codex-c2", status: "alive" },
    ]);
    expect(result.acceleratedRunCount).toBe(2);
    expect(heartbeat.retryScheduledRetryNow).toHaveBeenCalledTimes(2);
    const issueIds = heartbeat.retryScheduledRetryNow.mock.calls.map((call) => call[0].issueId).sort();
    expect(issueIds).toEqual(["issue-1", "issue-2"]);
    for (const call of heartbeat.retryScheduledRetryNow.mock.calls) {
      expect(call[0].actor).toEqual({ actorType: "system", actorId: "codex-limit-probe" });
    }
  });

  it("treats a runtime spawn error (no stderr) as a transient probe failure, not as recovery", async () => {
    const heartbeat = makeHeartbeatStub();
    const execFile = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, open 'codex'");
    });
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-1",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-1",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: execFile as never,
      resolveProfiles: () => [{ label: "codex-c1", home: "/paperclip/.codex-c1" }],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(true);
    expect(result.profiles[0].status).toBe("error");
    // Still no acceleration since "error" is not "alive".
    expect(heartbeat.retryScheduledRetryNow).not.toHaveBeenCalled();
  });

  it("survives a heartbeat retry promotion failure for one issue without aborting the rest", async () => {
    const heartbeat = {
      retryScheduledRetryNow: vi
        .fn()
        .mockImplementationOnce(async () => {
          throw new Error("transaction conflict");
        })
        .mockImplementationOnce(async (input: { issueId: string }) => ({
          outcome: "promoted" as const,
          message: "ok",
          scheduledRetry: { runId: `run-for-${input.issueId}` },
        })),
    };
    const execFile = vi.fn(async () => ({ stdout: "codex 0.123.4\n", stderr: "" }));
    const probe = codexLimitProbeService({
      db: makeDbStub([
        {
          runId: "run-a",
          companyId: "c-1",
          agentId: "a-1",
          issueId: "issue-a",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
        {
          runId: "run-b",
          companyId: "c-1",
          agentId: "a-2",
          issueId: "issue-b",
          adapterType: "codex_local",
          errorFamily: "transient_upstream",
        },
      ]),
      heartbeat,
      isDueAt: () => true,
      execFile: execFile as never,
      resolveProfiles: () => [{ label: "codex-c1", home: "/paperclip/.codex-c1" }],
    });

    const result = await probe.tickProbe(new Date("2026-01-15T17:00:00Z"));
    expect(result.ran).toBe(true);
    expect(result.acceleratedRunCount).toBe(1);
    expect(heartbeat.retryScheduledRetryNow).toHaveBeenCalledTimes(2);
  });
});
