import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUOTA_PACING_SETTINGS,
  type ProviderQuotaResult,
  type QuotaPacingSettings,
} from "@paperclipai/shared";
import {
  createQuotaPacingController,
  decideQuotaPacingMode,
  effectiveMaxConcurrentRuns,
  pacedMaxConcurrentRuns,
  pacedProviderForAdapterType,
  startQuotaPacing,
  stopQuotaPacing,
  type QuotaPacingDecisionInput,
  type QuotaPacingWindowInput,
} from "../services/quota-pacing.js";
import { logger } from "../middleware/logger.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const SESSION_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** A window whose given share has elapsed at NOW. */
function windowAt(usedPercent: number | null, elapsed: number, windowSeconds: number): QuotaPacingWindowInput {
  const resetsAt = new Date(NOW.getTime() + (1 - elapsed) * windowSeconds * 1000).toISOString();
  return { usedPercent, resetsAt, windowSeconds };
}

const session = (usedPercent: number | null, elapsed = 0.5) => windowAt(usedPercent, elapsed, SESSION_SECONDS);
const weekly = (usedPercent: number | null, elapsed = 0.5) => windowAt(usedPercent, elapsed, WEEK_SECONDS);

function decide(overrides: Partial<QuotaPacingDecisionInput> & { mode?: QuotaPacingSettings["mode"] } = {}) {
  const { mode, ...input } = overrides;
  return decideQuotaPacingMode({
    settings: { ...DEFAULT_QUOTA_PACING_SETTINGS, mode: mode ?? "auto" },
    windows: { session: session(30), weekly: weekly(40) },
    stale: false,
    now: NOW,
    ...input,
  });
}

describe("decideQuotaPacingMode", () => {
  // Defaults: 20% session reserve, 8% weekly allowance. Halfway through both
  // windows the session target is 40% and the weekly target is 58%.
  it.each([
    ["on pace in both windows", session(30), weekly(40), "full", "on_pace"],
    ["exactly on the session target", session(40), weekly(40), "full", "on_pace"],
    ["slightly ahead in the session", session(45), weekly(40), "half", "session_ahead"],
    ["more than 10 points ahead in the session", session(55), weekly(40), "low", "session_ahead"],
    ["at the session reserve line", session(80, 0.99), weekly(40), "low", "session_limit"],
    ["ahead in the week within the allowance", session(30), weekly(62), "half", "weekly_ahead"],
    ["ahead in the week by more than the allowance", session(30), weekly(67), "low", "weekly_ahead"],
    ["at 95% of the week", session(10), weekly(95, 0.99), "low", "weekly_limit"],
    ["session window only", session(45), null, "half", "session_ahead"],
    ["weekly window only", null, weekly(40), "full", "on_pace"],
  ] as const)("%s", (_label, sessionWindow, weeklyWindow, mode, reason) => {
    expect(decide({ windows: { session: sessionWindow, weekly: weeklyWindow } })).toMatchObject({ mode, reason });
  });

  it("computes the session and weekly targets from the elapsed share", () => {
    const decision = decide({ windows: { session: session(10, 0.25), weekly: weekly(10, 0.25) } });
    expect(decision.session).toMatchObject({ usedPercent: 10, targetPercent: 20, aheadPercent: -10, elapsedPercent: 25 });
    expect(decision.weekly).toMatchObject({ usedPercent: 10, targetPercent: 33, aheadPercent: -23, elapsedPercent: 25 });
  });

  it("uses the configured reserve and allowance", () => {
    const decision = decideQuotaPacingMode({
      settings: { mode: "auto", sessionReservePercent: 50, weeklyAllowancePercent: 0 },
      windows: { session: session(26), weekly: weekly(40) },
      stale: false,
      now: NOW,
    });
    // Session target is 0.5 * 50 = 25, so 26% is 1 point ahead.
    expect(decision).toMatchObject({ mode: "half", reason: "session_ahead" });
    expect(decision.session?.targetPercent).toBe(25);
  });

  it("treats a window past its reset time as fully elapsed", () => {
    const expired = { usedPercent: 70, resetsAt: new Date(NOW.getTime() - 60_000).toISOString(), windowSeconds: SESSION_SECONDS };
    expect(decide({ windows: { session: expired, weekly: null } }).session).toMatchObject({ elapsedPercent: 100, targetPercent: 80 });
  });

  it.each([
    ["half", "half"],
    ["low", "low"],
    ["full", "full"],
  ] as const)("lets a manual %s mode override on-pace data", (mode, expected) => {
    expect(decide({ mode })).toMatchObject({ mode: expected, reason: "manual_override" });
  });

  it("lets a manual full mode override data that is far ahead", () => {
    expect(decide({ mode: "full", windows: { session: session(90), weekly: weekly(99) } })).toMatchObject({
      mode: "full",
      reason: "manual_override",
    });
  });

  it("applies a manual mode even without quota data", () => {
    expect(decide({ mode: "low", windows: null })).toMatchObject({ mode: "low", reason: "manual_override" });
  });

  it("fails open to full without quota data", () => {
    expect(decide({ windows: null })).toMatchObject({ mode: "full", reason: "no_data" });
    expect(decide({ windows: { session: null, weekly: null } })).toMatchObject({ mode: "full", reason: "no_data" });
    expect(decide({ windows: { session: session(null), weekly: weekly(null) } })).toMatchObject({
      mode: "full",
      reason: "no_data",
    });
  });

  it("fails open to full with stale quota data but still reports the last values", () => {
    const decision = decide({ windows: { session: session(90), weekly: weekly(99) }, stale: true });
    expect(decision).toMatchObject({ mode: "full", reason: "stale_data" });
    expect(decision.session?.usedPercent).toBe(90);
  });

  it("applies only the absolute limits when the window position is unknown", () => {
    const cliSession = (usedPercent: number) => ({ usedPercent, resetsAt: null, windowSeconds: SESSION_SECONDS });
    expect(decide({ windows: { session: cliSession(85), weekly: null } })).toMatchObject({
      mode: "low",
      reason: "session_limit",
    });
    const onPace = decide({ windows: { session: cliSession(50), weekly: null } });
    expect(onPace).toMatchObject({ mode: "full", reason: "on_pace" });
    expect(onPace.session).toMatchObject({ targetPercent: null, aheadPercent: null });
  });
});

describe("pacedMaxConcurrentRuns", () => {
  it.each([
    ["full", 4, 4],
    ["full", 1, 1],
    ["half", 4, 2],
    ["half", 5, 3],
    ["half", 1, 1],
    ["low", 4, 1],
    ["low", 1, 1],
  ] as const)("maps %s with a configured max of %i to %i", (mode, configuredMax, expected) => {
    expect(pacedMaxConcurrentRuns(mode, configuredMax)).toBe(expected);
  });
});

describe("pacedProviderForAdapterType", () => {
  it.each([
    ["claude_local", "anthropic"],
    ["codex_local", "openai"],
    ["gemini_local", null],
    ["cursor", null],
    ["anthropic", null],
  ] as const)("maps %s to %s", (adapterType, provider) => {
    expect(pacedProviderForAdapterType(adapterType)).toBe(provider);
  });
});

function anthropicResult(sessionUsed: number, weeklyUsed: number, at = new Date()): ProviderQuotaResult {
  const reset = (seconds: number) => new Date(at.getTime() + (seconds / 2) * 1000).toISOString();
  return {
    provider: "anthropic",
    ok: true,
    windows: [
      { label: "Current session", usedPercent: sessionUsed, resetsAt: reset(SESSION_SECONDS), valueLabel: null, kind: "session", windowSeconds: SESSION_SECONDS },
      { label: "Current week (all models)", usedPercent: weeklyUsed, resetsAt: reset(WEEK_SECONDS), valueLabel: null, kind: "weekly", windowSeconds: WEEK_SECONDS },
    ],
  };
}

const openaiMissing: ProviderQuotaResult = { provider: "openai", ok: false, error: "no local codex auth token", windows: [] };

describe("quota pacing controller", () => {
  const enabled: QuotaPacingSettings = { ...DEFAULT_QUOTA_PACING_SETTINGS, enabled: true };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopQuotaPacing();
    vi.useRealTimers();
  });

  it("does not poll or change limits while pacing is off", async () => {
    const fetchQuotaWindows = vi.fn(async () => [anthropicResult(90, 90)]);
    const controller = createQuotaPacingController({
      loadSettings: async () => DEFAULT_QUOTA_PACING_SETTINGS,
      fetchQuotaWindows,
    });
    await controller.ready;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(fetchQuotaWindows).not.toHaveBeenCalled();
    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(4);
    expect(controller.getState()).toMatchObject({ enabled: false, nextPollAt: null });
    controller.stop();
  });

  it("paces only the adapters of a provider that is ahead", async () => {
    // Halfway through the session with 60% used: 20 points ahead of the 40% target.
    const controller = createQuotaPacingController({
      loadSettings: async () => enabled,
      fetchQuotaWindows: async () => [anthropicResult(60, 40), openaiMissing],
    });
    await controller.ready;

    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(1);
    expect(controller.effectiveMaxConcurrentRuns("codex_local", 4)).toBe(4);
    expect(controller.effectiveMaxConcurrentRuns("gemini_local", 4)).toBe(4);
    const state = controller.getState();
    expect(state.providers).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        mode: "low",
        reason: "session_ahead",
        session: expect.objectContaining({ usedPercent: 60, targetPercent: 40, aheadPercent: 20 }),
        lastError: null,
      }),
      expect.objectContaining({ provider: "openai", mode: "full", reason: "no_data", lastError: "no local codex auth token" }),
    ]);
    controller.stop();
  });

  it("polls on the configured interval and never faster than five minutes", async () => {
    const fetchQuotaWindows = vi.fn(async () => [anthropicResult(10, 10)]);
    const controller = createQuotaPacingController({ loadSettings: async () => enabled, fetchQuotaWindows });
    await controller.ready;
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(1);

    // Turning pacing off and on again right away must not poll again early.
    controller.applySettings({ ...enabled, enabled: false });
    controller.applySettings(enabled);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("keeps the last good result and backs off when a poll fails", async () => {
    const fetchQuotaWindows = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([anthropicResult(60, 40)])
      .mockRejectedValue(new Error("network down"));
    const controller = createQuotaPacingController({ loadSettings: async () => enabled, fetchQuotaWindows });
    await controller.ready;

    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(2);
    const state = controller.getState();
    expect(state.lastError).toBe("network down");
    // The cached data is still fresh, so the provider stays paced.
    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(1);
    // One failure doubles the delay: the next poll is 10 minutes after the last one.
    expect(state.nextPollAt).toBe(new Date(NOW.getTime() + 300_000 + 600_000).toISOString());
    controller.stop();
  });

  it("fails open when the cached data goes stale and resumes queued runs", async () => {
    const onModeRelaxed = vi.fn();
    const fetchQuotaWindows = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([anthropicResult(60, 40)])
      .mockRejectedValue(new Error("rate limited"));
    const controller = createQuotaPacingController({ loadSettings: async () => enabled, fetchQuotaWindows, onModeRelaxed });
    await controller.ready;
    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(1);

    // Three poll intervals after the last good poll the data is stale.
    await vi.advanceTimersByTimeAsync(3 * 300_000 + 1_000);
    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(4);
    expect(controller.getState().providers[0]).toMatchObject({ mode: "full", reason: "stale_data" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onModeRelaxed).toHaveBeenCalledWith(["anthropic"]);
    controller.stop();
  });

  it("resumes queued runs when a manual mode relaxes or pacing turns off", async () => {
    const onModeRelaxed = vi.fn();
    const controller = createQuotaPacingController({
      loadSettings: async () => ({ ...enabled, mode: "low" }),
      fetchQuotaWindows: async () => [anthropicResult(10, 10)],
      onModeRelaxed,
    });
    await controller.ready;
    expect(controller.effectiveMaxConcurrentRuns("codex_local", 4)).toBe(1);

    controller.applySettings({ ...enabled, mode: "half" });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.effectiveMaxConcurrentRuns("codex_local", 4)).toBe(2);
    expect(onModeRelaxed).toHaveBeenLastCalledWith(["anthropic", "openai"]);

    controller.applySettings({ ...enabled, mode: "half", enabled: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.effectiveMaxConcurrentRuns("codex_local", 4)).toBe(4);
    expect(onModeRelaxed).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("does not resume queued runs when the mode tightens", async () => {
    const onModeRelaxed = vi.fn();
    const controller = createQuotaPacingController({
      loadSettings: async () => enabled,
      fetchQuotaWindows: async () => [anthropicResult(10, 10)],
      onModeRelaxed,
    });
    await controller.ready;
    controller.applySettings({ ...enabled, mode: "low" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onModeRelaxed).not.toHaveBeenCalled();
    controller.stop();
  });

  it("logs mode changes with the used and target values", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const controller = createQuotaPacingController({
      loadSettings: async () => enabled,
      fetchQuotaWindows: async () => [anthropicResult(60, 40), openaiMissing],
    });
    await controller.ready;

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        previousMode: "full",
        mode: "low",
        reason: "session_ahead",
        sessionUsedPercent: 60,
        sessionTargetPercent: 40,
        weeklyUsedPercent: 40,
        weeklyTargetPercent: 58,
      }),
      "quota pacing mode changed",
    );
    controller.stop();
    info.mockRestore();
  });

  it("warns once per provider when pacing fails open", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const fetchQuotaWindows = vi.fn(async () => [anthropicResult(10, 10), openaiMissing]);
    const controller = createQuotaPacingController({ loadSettings: async () => enabled, fetchQuotaWindows });
    await controller.ready;
    await vi.advanceTimersByTimeAsync(2 * 300_000);
    expect(fetchQuotaWindows).toHaveBeenCalledTimes(3);

    const failOpenWarnings = warn.mock.calls.filter(
      ([, message]) => message === "quota pacing has no fresh quota data; the provider runs at full concurrency",
    );
    expect(failOpenWarnings).toHaveLength(1);
    expect(failOpenWarnings[0]![0]).toMatchObject({ provider: "openai", reason: "no_data", lastError: "no local codex auth token" });
    controller.stop();
    warn.mockRestore();
  });

  it("keeps configured limits when no controller runs", () => {
    stopQuotaPacing();
    expect(effectiveMaxConcurrentRuns("claude_local", 4)).toBe(4);
  });

  it("routes the process-wide accessor to the started controller", async () => {
    const controller = startQuotaPacing({
      loadSettings: async () => ({ ...enabled, mode: "low" }),
      fetchQuotaWindows: async () => [],
    });
    await controller.ready;
    expect(effectiveMaxConcurrentRuns("claude_local", 4)).toBe(1);
    expect(effectiveMaxConcurrentRuns("process", 4)).toBe(4);
    stopQuotaPacing();
    expect(effectiveMaxConcurrentRuns("claude_local", 4)).toBe(4);
  });
});
