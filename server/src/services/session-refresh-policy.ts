import { parseObject } from "../adapters/utils.js";

export type SessionRefreshPolicyMode = "none" | "per_run" | "inactivity" | "daily";

export type SessionRefreshPolicyConfig = {
  sessionRefreshPolicy: SessionRefreshPolicyMode;
  sessionInactivityTtlSec: number;
  sessionDailyRefreshHour: number;
};

const POLICIES: ReadonlySet<string> = new Set(["none", "per_run", "inactivity", "daily"]);

export function parseSessionRefreshPolicyConfig(raw: Record<string, unknown>): SessionRefreshPolicyConfig {
  const policyRaw = raw.sessionRefreshPolicy;
  const policy =
    typeof policyRaw === "string" && POLICIES.has(policyRaw)
      ? (policyRaw as SessionRefreshPolicyMode)
      : ("none" as const);

  let sessionInactivityTtlSec = 1800;
  const ttlRaw = raw.sessionInactivityTtlSec;
  if (typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0) {
    sessionInactivityTtlSec = Math.floor(ttlRaw);
  }

  let sessionDailyRefreshHour = 0;
  const hourRaw = raw.sessionDailyRefreshHour;
  if (typeof hourRaw === "number" && Number.isFinite(hourRaw)) {
    const h = Math.floor(hourRaw);
    if (h >= 0 && h <= 23) sessionDailyRefreshHour = h;
  }

  return { sessionRefreshPolicy: policy, sessionInactivityTtlSec, sessionDailyRefreshHour };
}

function utcBoundaryWindowStartMs(at: Date, boundaryHourUtc: number): number {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  const h = at.getUTCHours();
  let start = Date.UTC(y, m, d, boundaryHourUtc, 0, 0, 0);
  if (h < boundaryHourUtc) {
    start -= 24 * 60 * 60 * 1000;
  }
  return start;
}

export type SessionRefreshEvalInput = {
  adapterConfig: Record<string, unknown>;
  now: Date;
  hasExplicitResume: boolean;
  /** True when the run would resume Claude/session state from Paperclip persistence (task row or agent runtime fallback). */
  wouldResumeFromPersistence: boolean;
  /** Last time persisted session state was updated; task session row takes precedence over agent runtime when both apply. */
  lastPersistedSessionTouch: Date | null;
};

export type SessionRefreshEvalResult = {
  clearPersistedSession: boolean;
  logReason: string | null;
};

/**
 * Server-side session refresh: drop persisted resume state before invoking the adapter
 * (task session params + runtime session id fallback) when policy says so.
 */
export function evaluateSessionRefreshPolicy(input: SessionRefreshEvalInput): SessionRefreshEvalResult {
  if (input.hasExplicitResume || !input.wouldResumeFromPersistence) {
    return { clearPersistedSession: false, logReason: null };
  }

  const cfg = parseSessionRefreshPolicyConfig(parseObject(input.adapterConfig));

  if (cfg.sessionRefreshPolicy === "none") {
    return { clearPersistedSession: false, logReason: null };
  }

  if (cfg.sessionRefreshPolicy === "per_run") {
    return {
      clearPersistedSession: true,
      logReason: "adapter sessionRefreshPolicy is per_run",
    };
  }

  const last = input.lastPersistedSessionTouch;
  if (!last) {
    return { clearPersistedSession: false, logReason: null };
  }

  if (cfg.sessionRefreshPolicy === "inactivity") {
    const elapsedSec = (input.now.getTime() - last.getTime()) / 1000;
    if (elapsedSec > cfg.sessionInactivityTtlSec) {
      return {
        clearPersistedSession: true,
        logReason: `session idle for ${Math.floor(elapsedSec)}s (sessionInactivityTtlSec=${cfg.sessionInactivityTtlSec})`,
      };
    }
    return { clearPersistedSession: false, logReason: null };
  }

  if (cfg.sessionRefreshPolicy === "daily") {
    const nowStart = utcBoundaryWindowStartMs(input.now, cfg.sessionDailyRefreshHour);
    const lastStart = utcBoundaryWindowStartMs(last, cfg.sessionDailyRefreshHour);
    if (nowStart !== lastStart) {
      return {
        clearPersistedSession: true,
        logReason: `new session refresh window (sessionRefreshPolicy=daily, sessionDailyRefreshHour=${cfg.sessionDailyRefreshHour} UTC)`,
      };
    }
    return { clearPersistedSession: false, logReason: null };
  }

  return { clearPersistedSession: false, logReason: null };
}
