import {
  DEFAULT_QUOTA_PACING_SETTINGS,
  QUOTA_PACING_MAX_POLL_INTERVAL_SEC,
  QUOTA_PACING_MIN_POLL_INTERVAL_SEC,
  QUOTA_PACING_PROVIDERS,
  type ProviderQuotaResult,
  type QuotaPacingMode,
  type QuotaPacingProvider,
  type QuotaPacingProviderState,
  type QuotaPacingReason,
  type QuotaPacingSettings,
  type QuotaPacingState,
  type QuotaPacingWindowState,
  type QuotaWindow,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { fetchAllQuotaWindows, providerSlugForAdapterType } from "./quota-windows.js";

/**
 * Quota-aware run pacing.
 *
 * Polls the provider quota windows while pacing is on and lowers the
 * concurrent-run limit of `claude_local` and `codex_local` agents when usage
 * runs ahead of an even spend rate. Pacing only limits new run starts: the
 * scheduler never cancels a running run because of it. It fails open: with
 * missing, stale, or failed quota data every agent keeps its configured limit.
 */

/** Quota data older than this many poll intervals no longer drives pacing. */
export const QUOTA_PACING_STALE_AFTER_POLL_INTERVALS = 3;
/** Session usage this far ahead of pace drops straight to low. */
const SESSION_AHEAD_LOW_PERCENT = 10;
/** Weekly usage at or above this drops to low whatever the pace. */
const WEEKLY_LOW_PERCENT = 95;
const MAX_LOGGED_ERROR_LENGTH = 500;

const MODE_RANK: Record<QuotaPacingMode, number> = { low: 0, half: 1, full: 2 };

export interface QuotaPacingWindowInput {
  usedPercent: number | null;
  resetsAt: string | null;
  windowSeconds: number | null;
}

export interface QuotaPacingWindows {
  session: QuotaPacingWindowInput | null;
  weekly: QuotaPacingWindowInput | null;
}

export interface QuotaPacingDecisionInput {
  settings: Pick<QuotaPacingSettings, "mode" | "sessionReservePercent" | "weeklyAllowancePercent">;
  /** Windows from the last successful poll; null when no poll has succeeded. */
  windows: QuotaPacingWindows | null;
  /** True when the last successful poll is older than the stale threshold. */
  stale: boolean;
  now: Date;
}

export interface QuotaPacingDecision {
  mode: QuotaPacingMode;
  reason: QuotaPacingReason;
  session: QuotaPacingWindowState | null;
  weekly: QuotaPacingWindowState | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Share (0-1) of a rolling window that has elapsed; null when the window position is unknown. */
function elapsedFraction(window: QuotaPacingWindowInput, now: Date): number | null {
  if (!window.resetsAt || window.windowSeconds == null || !(window.windowSeconds > 0)) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) return null;
  const remainingSeconds = (resetsAtMs - now.getTime()) / 1000;
  return clamp(1 - remainingSeconds / window.windowSeconds, 0, 1);
}

function measureWindow(
  window: QuotaPacingWindowInput | null,
  now: Date,
  targetAt: (elapsed: number) => number,
): QuotaPacingWindowState | null {
  if (!window || window.usedPercent == null || !Number.isFinite(window.usedPercent)) return null;
  const usedPercent = clamp(window.usedPercent, 0, 100);
  const elapsed = elapsedFraction(window, now);
  // A target above 100% cannot change a decision (usage never exceeds 100%),
  // so clamp it to keep the reported value readable.
  const targetPercent = elapsed == null ? null : clamp(targetAt(elapsed), 0, 100);
  return {
    usedPercent,
    targetPercent,
    aheadPercent: targetPercent == null ? null : usedPercent - targetPercent,
    elapsedPercent: elapsed == null ? null : elapsed * 100,
    resetsAt: window.resetsAt,
    windowSeconds: window.windowSeconds,
  };
}

/**
 * Decide the pacing mode for one provider.
 *
 * With `elapsed = 1 - (resetsAt - now) / windowSeconds` for each window:
 * - session target = elapsed * (100 - sessionReservePercent)
 * - weekly target = elapsed * 100 + weeklyAllowancePercent
 * - ahead = used - target
 *
 * The mode is "low" when session usage reaches the reserve line, weekly usage
 * reaches 95%, the session is more than 10 points ahead, or the week is more
 * than the allowance ahead. It is "half" when either window is ahead at all,
 * and "full" otherwise. A manual mode wins over the data. Missing or stale
 * data fails open to "full". A window without a known position (for example
 * CLI-scraped usage without a reset time) still applies the absolute limits.
 */
export function decideQuotaPacingMode(input: QuotaPacingDecisionInput): QuotaPacingDecision {
  const { settings, now } = input;
  const session = measureWindow(
    input.windows?.session ?? null,
    now,
    (elapsed) => elapsed * (100 - settings.sessionReservePercent),
  );
  const weekly = measureWindow(
    input.windows?.weekly ?? null,
    now,
    (elapsed) => elapsed * 100 + settings.weeklyAllowancePercent,
  );
  const decide = (mode: QuotaPacingMode, reason: QuotaPacingReason): QuotaPacingDecision => ({
    mode,
    reason,
    session,
    weekly,
  });

  if (settings.mode !== "auto") return decide(settings.mode, "manual_override");
  if (!input.windows) return decide("full", "no_data");
  if (input.stale) return decide("full", "stale_data");
  if (!session && !weekly) return decide("full", "no_data");

  const sessionAhead = session?.aheadPercent ?? null;
  const weeklyAhead = weekly?.aheadPercent ?? null;
  if (session && session.usedPercent >= 100 - settings.sessionReservePercent) {
    return decide("low", "session_limit");
  }
  if (weekly && weekly.usedPercent >= WEEKLY_LOW_PERCENT) return decide("low", "weekly_limit");
  if (sessionAhead != null && sessionAhead > SESSION_AHEAD_LOW_PERCENT) return decide("low", "session_ahead");
  if (weeklyAhead != null && weeklyAhead > settings.weeklyAllowancePercent) return decide("low", "weekly_ahead");
  if (sessionAhead != null && sessionAhead > 0) return decide("half", "session_ahead");
  if (weeklyAhead != null && weeklyAhead > 0) return decide("half", "weekly_ahead");
  return decide("full", "on_pace");
}

/** Concurrent-run limit for a pacing mode. Pacing never raises the configured limit. */
export function pacedMaxConcurrentRuns(mode: QuotaPacingMode, configuredMax: number): number {
  switch (mode) {
    case "full":
      return configuredMax;
    case "half":
      return Math.min(configuredMax, Math.max(1, Math.ceil(configuredMax / 2)));
    case "low":
      return Math.min(configuredMax, 1);
  }
}

/** The paced provider for an adapter type, or null for adapters that pacing leaves alone. */
export function pacedProviderForAdapterType(adapterType: string): QuotaPacingProvider | null {
  const provider = providerSlugForAdapterType(adapterType);
  // The slug mapping falls back to the adapter type itself; only a mapped
  // local adapter is paced.
  if (provider === adapterType) return null;
  return (QUOTA_PACING_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as QuotaPacingProvider)
    : null;
}

function pacingWindow(windows: QuotaWindow[], kind: "session" | "weekly"): QuotaPacingWindowInput | null {
  const window = windows.find((entry) => entry.kind === kind);
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowSeconds: window.windowSeconds ?? null,
  };
}

function normalizeSettings(settings: QuotaPacingSettings): QuotaPacingSettings {
  return {
    ...settings,
    pollIntervalSec: clamp(
      Number.isFinite(settings.pollIntervalSec)
        ? settings.pollIntervalSec
        : DEFAULT_QUOTA_PACING_SETTINGS.pollIntervalSec,
      QUOTA_PACING_MIN_POLL_INTERVAL_SEC,
      QUOTA_PACING_MAX_POLL_INTERVAL_SEC,
    ),
  };
}

function truncateError(message: string): string {
  return message.length > MAX_LOGGED_ERROR_LENGTH
    ? `${message.slice(0, MAX_LOGGED_ERROR_LENGTH)}…`
    : message;
}

function roundPercent(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

function roundWindowState(window: QuotaPacingWindowState | null): QuotaPacingWindowState | null {
  if (!window) return null;
  return {
    ...window,
    usedPercent: roundPercent(window.usedPercent) ?? 0,
    targetPercent: roundPercent(window.targetPercent),
    aheadPercent: roundPercent(window.aheadPercent),
    elapsedPercent: roundPercent(window.elapsedPercent),
  };
}

interface ProviderQuotaCache {
  windows: QuotaPacingWindows | null;
  polledAt: Date | null;
  lastError: string | null;
}

export interface QuotaPacingControllerOptions {
  /** Reads the stored pacing settings. */
  loadSettings: () => Promise<QuotaPacingSettings>;
  fetchQuotaWindows?: () => Promise<ProviderQuotaResult[]>;
  /** Called when a provider's mode relaxes, so queued runs can start at once. */
  onModeRelaxed?: (providers: QuotaPacingProvider[]) => void | Promise<void>;
  now?: () => Date;
}

export interface QuotaPacingController {
  /** Resolves after the settings load and, when pacing is on, the first poll. Never rejects. */
  readonly ready: Promise<void>;
  applySettings(settings: QuotaPacingSettings): void;
  effectiveMaxConcurrentRuns(adapterType: string, configuredMax: number): number;
  getState(): QuotaPacingState;
  /** Polls now unless a poll is already in flight. For tests and manual refresh. */
  pollNow(): Promise<void>;
  /** Stops polling and relax notifications. The last computed limits stay in effect. */
  stop(): void;
}

export function createQuotaPacingController(options: QuotaPacingControllerOptions): QuotaPacingController {
  const now = options.now ?? (() => new Date());
  const fetchQuotaWindows = options.fetchQuotaWindows ?? fetchAllQuotaWindows;
  let settings: QuotaPacingSettings = DEFAULT_QUOTA_PACING_SETTINGS;
  // Bumped by applySettings, so a settings read that started earlier cannot
  // overwrite a newer write that arrived through the settings route.
  let settingsVersion = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextPollAt: Date | null = null;
  let pollInFlight: Promise<void> | null = null;
  let lastPollStartedAt: Date | null = null;
  let lastPolledAt: Date | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  const cache = new Map<QuotaPacingProvider, ProviderQuotaCache>(
    QUOTA_PACING_PROVIDERS.map((provider) => [provider, { windows: null, polledAt: null, lastError: null }]),
  );
  // Before pacing has evaluated anything, every provider runs at full.
  const lastDecisions = new Map<QuotaPacingProvider, Pick<QuotaPacingDecision, "mode" | "reason">>(
    QUOTA_PACING_PROVIDERS.map((provider) => [provider, { mode: "full", reason: "disabled" }]),
  );
  const failOpenWarned = new Set<QuotaPacingProvider>();

  function pollIntervalMs() {
    return settings.pollIntervalSec * 1000;
  }

  function staleAfterMs() {
    return pollIntervalMs() * QUOTA_PACING_STALE_AFTER_POLL_INTERVALS;
  }

  function nextDelayMs() {
    if (consecutiveFailures === 0) return pollIntervalMs();
    // Back off on failures, but poll again before the cached data goes
    // stale enough to matter a second time.
    return Math.min(pollIntervalMs() * 2 ** consecutiveFailures, staleAfterMs());
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextPollAt = null;
  }

  function scheduleNextPoll() {
    clearTimer();
    if (stopped || !settings.enabled || pollInFlight) return;
    // Measure from the last poll start, so a settings change or a quick
    // off/on toggle never polls faster than the configured interval.
    const dueAtMs = lastPollStartedAt ? lastPollStartedAt.getTime() + nextDelayMs() : now().getTime();
    const delayMs = Math.max(0, dueAtMs - now().getTime());
    nextPollAt = new Date(now().getTime() + delayMs);
    timer = setTimeout(() => {
      timer = null;
      void pollNow();
    }, delayMs);
    timer.unref?.();
  }

  function decisionFor(provider: QuotaPacingProvider, at: Date): QuotaPacingDecision {
    const entry = cache.get(provider)!;
    const decision = decideQuotaPacingMode({
      settings,
      windows: entry.windows,
      stale: entry.polledAt == null || at.getTime() - entry.polledAt.getTime() > staleAfterMs(),
      now: at,
    });
    return settings.enabled ? decision : { ...decision, mode: "full", reason: "disabled" };
  }

  function logFields(
    provider: QuotaPacingProvider,
    previous: Pick<QuotaPacingDecision, "mode" | "reason">,
    decision: QuotaPacingDecision,
  ) {
    const entry = cache.get(provider)!;
    return {
      provider,
      previousMode: previous.mode,
      mode: decision.mode,
      reason: decision.reason,
      sessionUsedPercent: roundPercent(decision.session?.usedPercent ?? null),
      sessionTargetPercent: roundPercent(decision.session?.targetPercent ?? null),
      weeklyUsedPercent: roundPercent(decision.weekly?.usedPercent ?? null),
      weeklyTargetPercent: roundPercent(decision.weekly?.targetPercent ?? null),
      lastPolledAt: entry.polledAt?.toISOString() ?? null,
      lastError: entry.lastError ? truncateError(entry.lastError) : null,
    };
  }

  function notifyRelaxed(providers: QuotaPacingProvider[]) {
    const onModeRelaxed = options.onModeRelaxed;
    if (!onModeRelaxed || stopped) return;
    void Promise.resolve()
      .then(() => onModeRelaxed(providers))
      .catch((err) => {
        logger.error({ err, providers }, "quota pacing could not resume queued runs after the mode relaxed");
      });
  }

  /**
   * Recompute every provider's mode from the cached data. Runs on each poll,
   * each settings change, and each scheduler lookup, so staleness takes
   * effect on time even between polls. Logs and reacts only to transitions.
   */
  function evaluate(): Map<QuotaPacingProvider, QuotaPacingDecision> {
    const at = now();
    const decisions = new Map<QuotaPacingProvider, QuotaPacingDecision>();
    const relaxed: QuotaPacingProvider[] = [];
    for (const provider of QUOTA_PACING_PROVIDERS) {
      const decision = decisionFor(provider, at);
      decisions.set(provider, decision);
      const previous = lastDecisions.get(provider)!;
      let warned = false;
      if (decision.reason === "no_data" || decision.reason === "stale_data") {
        // Warn once per fail-open episode, and only after a poll finished:
        // before the first poll there is no data by design.
        if (lastPolledAt && !failOpenWarned.has(provider)) {
          logger.warn(
            logFields(provider, previous, decision),
            "quota pacing has no fresh quota data; the provider runs at full concurrency",
          );
          failOpenWarned.add(provider);
          warned = true;
        }
      } else {
        failOpenWarned.delete(provider);
      }
      if (previous.mode === decision.mode && previous.reason === decision.reason) continue;
      if (previous.mode !== decision.mode && !warned) {
        logger.info(logFields(provider, previous, decision), "quota pacing mode changed");
      }
      if (MODE_RANK[decision.mode] > MODE_RANK[previous.mode]) relaxed.push(provider);
      lastDecisions.set(provider, { mode: decision.mode, reason: decision.reason });
    }
    if (relaxed.length > 0) notifyRelaxed(relaxed);
    return decisions;
  }

  async function reloadSettings() {
    const version = settingsVersion;
    try {
      const loaded = normalizeSettings(await options.loadSettings());
      if (version === settingsVersion) settings = loaded;
    } catch (err) {
      logger.warn({ err }, "quota pacing could not read its settings; it keeps the previous settings");
    }
  }

  function recordResults(results: ProviderQuotaResult[], polledAt: Date): boolean {
    let anyOk = false;
    for (const provider of QUOTA_PACING_PROVIDERS) {
      const entry = cache.get(provider)!;
      const providerResults = results.filter((result) => result.provider === provider);
      const ok = providerResults.find((result) => result.ok);
      if (ok) {
        entry.windows = {
          session: pacingWindow(ok.windows, "session"),
          weekly: pacingWindow(ok.windows, "weekly"),
        };
        entry.polledAt = polledAt;
        entry.lastError = null;
        anyOk = true;
        continue;
      }
      // Keep the last good windows: they stay usable until they go stale.
      entry.lastError =
        providerResults
          .map((result) => result.error)
          .filter((error): error is string => typeof error === "string" && error.length > 0)
          .join("; ")
        || (providerResults.length === 0
          ? "No quota source reported this provider."
          : "The provider returned no quota data.");
    }
    return anyOk;
  }

  async function runPoll() {
    await reloadSettings();
    if (stopped || !settings.enabled) return;
    lastPollStartedAt = now();
    try {
      const anyOk = recordResults(await fetchQuotaWindows(), now());
      lastError = null;
      consecutiveFailures = anyOk ? 0 : consecutiveFailures + 1;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      consecutiveFailures += 1;
    }
    lastPolledAt = now();
    if (consecutiveFailures > 0) {
      logger.warn(
        {
          consecutiveFailures,
          error: lastError ? truncateError(lastError) : null,
          providerErrors: Object.fromEntries(
            QUOTA_PACING_PROVIDERS.map((provider) => {
              const error = cache.get(provider)!.lastError;
              return [provider, error ? truncateError(error) : null];
            }),
          ),
          nextPollInSec: Math.round(nextDelayMs() / 1000),
        },
        "quota pacing poll returned no quota data; backing off",
      );
    }
  }

  function pollNow(): Promise<void> {
    if (pollInFlight) return pollInFlight;
    clearTimer();
    pollInFlight = runPoll()
      .catch((err) => {
        logger.error({ err }, "quota pacing poll failed");
      })
      .finally(() => {
        pollInFlight = null;
        evaluate();
        scheduleNextPoll();
      });
    return pollInFlight;
  }

  const ready = (async () => {
    await reloadSettings();
    if (settings.enabled) {
      await pollNow();
    } else {
      evaluate();
    }
  })().catch((err) => {
    logger.error({ err }, "quota pacing failed to start; agents keep their configured limits");
  });

  return {
    ready,

    applySettings(next) {
      settingsVersion += 1;
      settings = normalizeSettings(next);
      if (!settings.enabled) clearTimer();
      else scheduleNextPoll();
      evaluate();
    },

    effectiveMaxConcurrentRuns(adapterType, configuredMax) {
      if (!settings.enabled) return configuredMax;
      const provider = pacedProviderForAdapterType(adapterType);
      if (!provider) return configuredMax;
      return pacedMaxConcurrentRuns(evaluate().get(provider)!.mode, configuredMax);
    },

    getState() {
      const decisions = evaluate();
      return {
        enabled: settings.enabled,
        settings,
        lastPolledAt: lastPolledAt?.toISOString() ?? null,
        nextPollAt: settings.enabled ? (nextPollAt?.toISOString() ?? null) : null,
        lastError,
        providers: QUOTA_PACING_PROVIDERS.map((provider): QuotaPacingProviderState => {
          const decision = decisions.get(provider)!;
          const entry = cache.get(provider)!;
          return {
            provider,
            mode: decision.mode,
            reason: decision.reason,
            session: roundWindowState(decision.session),
            weekly: roundWindowState(decision.weekly),
            lastPolledAt: entry.polledAt?.toISOString() ?? null,
            lastError: entry.lastError,
          };
        }),
      };
    },

    pollNow,

    stop() {
      stopped = true;
      clearTimer();
    },
  };
}

// One controller per server process. It sits at module scope, like the task
// drain state in heartbeat.ts, so every heartbeatService() instance and every
// route sees the same pacing.
let activeController: QuotaPacingController | null = null;

/** Start pacing for this process. Replaces a controller that is already running. */
export function startQuotaPacing(options: QuotaPacingControllerOptions): QuotaPacingController {
  activeController?.stop();
  activeController = createQuotaPacingController(options);
  return activeController;
}

export function stopQuotaPacing(): void {
  activeController?.stop();
  activeController = null;
}

/**
 * The concurrent-run limit the scheduler applies to an agent. Equals the
 * configured limit unless pacing is on and the agent's adapter is paced.
 */
export function effectiveMaxConcurrentRuns(adapterType: string, configuredMax: number): number {
  return activeController?.effectiveMaxConcurrentRuns(adapterType, configuredMax) ?? configuredMax;
}

/** Apply settings that the settings route just stored. */
export function applyQuotaPacingSettings(settings: QuotaPacingSettings): void {
  activeController?.applySettings(settings);
}

export function getQuotaPacingState(): QuotaPacingState {
  if (activeController) return activeController.getState();
  return {
    enabled: false,
    settings: DEFAULT_QUOTA_PACING_SETTINGS,
    lastPolledAt: null,
    nextPollAt: null,
    lastError: null,
    providers: QUOTA_PACING_PROVIDERS.map((provider) => ({
      provider,
      mode: "full",
      reason: "disabled",
      session: null,
      weekly: null,
      lastPolledAt: null,
      lastError: null,
    })),
  };
}
