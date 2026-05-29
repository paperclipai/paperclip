/**
 * Codex usage-limit probe — KSI-690.
 *
 * Background: Paperclip codex_local agents can be configured with two profiles
 * (CODEX_HOME + CODEX_FALLBACK, e.g. `/paperclip/.codex-c1` and
 * `/paperclip/.codex-c2`). When both profiles report a Codex usage-limit, the
 * adapter marks the run as `errorCode = codex_transient_upstream` and the
 * heartbeat scheduler records a scheduled retry. Until at least one profile
 * recovers, no Codex agent can make progress on Codex-blocked issues.
 *
 * This module periodically probes the configured Codex profiles via a no-op
 * `codex --version`-style invocation (which does not consume model turns) and,
 * when at least one profile is responsive again, accelerates every scheduled
 * retry that is parked on `codex_transient_upstream` so the retry runs on the
 * next scheduler tick.
 *
 * Design notes:
 *
 * - The probe is *self-gating*. It is "active" iff there is at least one
 *   Codex `scheduled_retry` heartbeat run waiting on
 *   `errorFamily = transient_upstream`. When the queue drains, the probe
 *   simply does nothing on subsequent ticks (auto-deactivation).
 * - Trigger cadence is honored via the cron expression `0 * * * *` (top of
 *   every UTC hour). The cron is evaluated against the same wall-clock as the
 *   server-internal heartbeat scheduler tick (no separate timer needed).
 * - The probe never spawns more than one `codex` process per profile per tick
 *   and uses a short timeout to keep the operation cheap.
 * - On recovery, the probe calls `heartbeatService.retryScheduledRetryNow`
 *   for each affected issue. That helper already handles promotion +
 *   wakeup-request payload bookkeeping.
 *
 * Decisions explicitly made for KSI-690:
 *
 * - `D3` (issue plan): implement as a server-internal periodic task instead
 *   of a `routines`-table row. The `routines` table only knows how to
 *   dispatch issues to agents; running an out-of-band `codex --version` per
 *   profile does not fit that model and would either require a Codex agent
 *   (chicken-and-egg: the agent itself is exhausted) or a dispatch-intercept
 *   hook just for this routine. A server-internal probe is simpler, has no
 *   external state, and is auditable through structured logger output. UI
 *   visibility under `/routines` can be added in a follow-up if leadership
 *   wants it.
 * - The probe is intentionally lenient toward partial integration with the
 *   sibling subtasks KSI-687 (Mudança 1, blocked status) and KSI-689
 *   (Mudança 3, label `codex-limit`). It identifies affected runs by
 *   `errorFamily = transient_upstream` on a codex_local agent and does not
 *   require the label to exist; once those subtasks land the probe will pick
 *   up the additional state (label removal, blocked → in_progress) for free
 *   because the existing transitions in heartbeat.ts already react to
 *   scheduled-retry promotion.
 */

import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

import { logger } from "../middleware/logger.js";
import { parseCron, type ParsedCron } from "./cron.js";
import type { heartbeatService } from "./heartbeat.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cron tick for the probe. Top of every UTC hour. Mirrors the value
 * documented in KSI-690.
 */
export const CODEX_LIMIT_PROBE_CRON = "0 * * * *";

/**
 * Wall-clock timezone used to evaluate `CODEX_LIMIT_PROBE_CRON`. The server
 * already runs internal jobs against UTC; using UTC keeps probe behavior
 * stable regardless of host timezone.
 */
export const CODEX_LIMIT_PROBE_TIMEZONE = "UTC";

/**
 * Default per-profile probe timeout. Probes are no-op `--version` calls so
 * they normally return in milliseconds; the cap exists to protect against
 * stuck child processes.
 */
export const CODEX_LIMIT_PROBE_PER_PROFILE_TIMEOUT_MS = 10_000;

/**
 * Default codex binary used for the probe. Overridable for tests via
 * `PAPERCLIP_CODEX_COMMAND`. The probe never invokes the
 * `codex-home-fallback` wrapper because we want to test exactly *one*
 * profile per spawn.
 */
const DEFAULT_CODEX_BINARY = "/usr/local/bin/codex";

const DEFAULT_CODEX_PROBE_ARGS = ["--version"] as const;

const RECOGNIZED_USAGE_LIMIT_RE =
  /usage limit|limite de mensagens|limite de uso|you'?ve hit your usage limit|you have hit your usage limit|voce atingiu o limite|voc[eê] atingiu o limite|seu limite de uso/i;

// ---------------------------------------------------------------------------
// Helpers (public for testing)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFileCallback);

/**
 * Resolve which CODEX_HOME directories the probe should test for the local
 * Paperclip instance. Reads `CODEX_HOME` and `CODEX_FALLBACK` from the
 * provided env (default: `process.env`).
 *
 * The returned array is the de-duplicated, ordered list of homes that match
 * the host filesystem: paths that do not look absolute are dropped (we will
 * never silently probe a relative path).
 */
export function resolveProbeProfiles(env: NodeJS.ProcessEnv = process.env): Array<{
  label: string;
  home: string;
}> {
  const seen = new Set<string>();
  const result: Array<{ label: string; home: string }> = [];

  const candidates: string[] = [];
  const primary = (env.CODEX_HOME ?? "").trim();
  if (primary) candidates.push(primary);
  const fallbackRaw = (env.CODEX_FALLBACK ?? "").trim();
  if (fallbackRaw) {
    for (const piece of fallbackRaw.split(/[,:]/)) {
      const trimmed = piece.trim();
      if (trimmed) candidates.push(trimmed);
    }
  }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ label: profileLabelForHome(normalized), home: normalized });
  }

  return result;
}

/**
 * Pick a stable, log-safe label for a CODEX_HOME path. Mirrors the labelling
 * scheme used by `paperclip/bin/codex-home-fallback` so the probe's logs read
 * the same as the wrapper's.
 */
export function profileLabelForHome(home: string): string {
  const base = path.basename(home).replace(/^\./, "");
  if (base === "codex-c1") return "codex-c1";
  if (base === "codex-c2") return "codex-c2";
  if (/^[A-Za-z0-9._-]+$/.test(base) && base.length > 0) return `custom-${base}`;
  return "custom";
}

/**
 * True when the captured stdout/stderr from a probe spawn looks like a
 * Codex-side usage-limit message. Matches the same regex as the wrapper.
 */
export function looksLikeCodexUsageLimit(text: string): boolean {
  return RECOGNIZED_USAGE_LIMIT_RE.test(text);
}

// ---------------------------------------------------------------------------
// cron.ts re-export (to avoid coupling consumers to the routines module)
// ---------------------------------------------------------------------------

export type { ParsedCron };

/**
 * Returns true when `now` falls on a tick of the given cron expression in
 * the configured timezone (rounded to the minute).
 *
 * Implemented in terms of the existing `parseCron` helper from
 * `./cron.js`, with timezone parts derived from `Intl.DateTimeFormat`.
 */
export function matchesCronTickInTimeZone(
  expression: string,
  timeZone: string,
  date: Date,
): boolean {
  const cron = parseCron(expression);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayIndex[map.weekday ?? ""];
  if (weekday == null) return false;
  return (
    cron.minutes.includes(Number(map.minute)) &&
    cron.hours.includes(Number(map.hour)) &&
    cron.daysOfMonth.includes(Number(map.day)) &&
    cron.months.includes(Number(map.month)) &&
    cron.daysOfWeek.includes(weekday)
  );
}

// ---------------------------------------------------------------------------
// Probe service
// ---------------------------------------------------------------------------

/**
 * Probe outcome for a single CODEX_HOME.
 */
export type ProbeProfileOutcome =
  | { label: string; home: string; status: "alive" }
  | { label: string; home: string; status: "usage_limit" }
  | { label: string; home: string; status: "error"; reason: string };

/**
 * Aggregate outcome for a probe tick.
 */
export interface ProbeTickOutcome {
  ranAt: Date;
  /** Profiles tested. Empty array means probe was skipped (not active). */
  profiles: ProbeProfileOutcome[];
  /**
   * Number of `scheduled_retry` heartbeat runs that the probe accelerated to
   * `scheduledRetryAt = now()` because at least one profile recovered.
   */
  acceleratedRunCount: number;
  /**
   * True when the cron was due AND there was at least one Codex
   * `scheduled_retry` run blocked on usage-limit.
   */
  ran: boolean;
  /** Skip reason when `ran === false`, e.g. `"cron_not_due"`, `"no_blocked_runs"`. */
  skippedReason?: "cron_not_due" | "no_blocked_runs" | "no_profiles_configured";
}

interface CodexLimitProbeDeps {
  db: Db;
  heartbeat: Pick<ReturnType<typeof heartbeatService>, "retryScheduledRetryNow">;
  /** Override for the codex binary command. Defaults to PAPERCLIP_CODEX_COMMAND or /usr/local/bin/codex. */
  codexBinary?: string;
  /** Override probe args. Defaults to ["--version"]. */
  codexProbeArgs?: readonly string[];
  /** Override profile resolver. Defaults to reading process.env. */
  resolveProfiles?: () => Array<{ label: string; home: string }>;
  /** Override spawn function for tests. */
  execFile?: typeof execFileAsync;
  /** Override cron evaluator for tests. */
  isDueAt?: (now: Date) => boolean;
  /** Per-profile probe timeout. */
  perProfileTimeoutMs?: number;
}

/**
 * Public service factory for the Codex limit probe.
 */
export function codexLimitProbeService(deps: CodexLimitProbeDeps) {
  const codexBinary = deps.codexBinary
    ?? process.env.PAPERCLIP_CODEX_COMMAND
    ?? DEFAULT_CODEX_BINARY;
  const codexProbeArgs = deps.codexProbeArgs ?? DEFAULT_CODEX_PROBE_ARGS;
  const resolveProfiles = deps.resolveProfiles ?? (() => resolveProbeProfiles());
  const execFile = deps.execFile ?? execFileAsync;
  const isDueAt = deps.isDueAt
    ?? ((now: Date) => matchesCronTickInTimeZone(CODEX_LIMIT_PROBE_CRON, CODEX_LIMIT_PROBE_TIMEZONE, now));
  const perProfileTimeoutMs = deps.perProfileTimeoutMs ?? CODEX_LIMIT_PROBE_PER_PROFILE_TIMEOUT_MS;

  /**
   * List `scheduled_retry` heartbeat runs that are parked on
   * `errorFamily = transient_upstream` for `codex_local` agents. Each entry
   * has the issue id (when available) so the probe can target
   * `retryScheduledRetryNow` per issue.
   */
  async function listBlockedCodexRuns(): Promise<
    Array<{ runId: string; companyId: string; agentId: string; issueId: string | null }>
  > {
    const rows = await deps.db
      .select({
        runId: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        adapterType: agents.adapterType,
        errorFamily: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'errorFamily'`,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.status, "scheduled_retry"),
          eq(agents.adapterType, "codex_local"),
        ),
      );
    return rows
      .filter((row) => row.errorFamily === "transient_upstream")
      .map((row) => ({
        runId: row.runId,
        companyId: row.companyId,
        agentId: row.agentId,
        issueId: row.issueId,
      }));
  }

  /**
   * Spawn the probe binary once with `CODEX_HOME=<home>`. Returns the
   * profile outcome.
   */
  async function probeProfile(profile: {
    label: string;
    home: string;
  }): Promise<ProbeProfileOutcome> {
    try {
      const { stdout, stderr } = await execFile(
        codexBinary,
        [...codexProbeArgs],
        {
          env: { ...process.env, CODEX_HOME: profile.home },
          timeout: perProfileTimeoutMs,
          windowsHide: true,
        },
      );
      const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (looksLikeCodexUsageLimit(combined)) {
        return { label: profile.label, home: profile.home, status: "usage_limit" };
      }
      return { label: profile.label, home: profile.home, status: "alive" };
    } catch (err) {
      // Even when the binary exits non-zero, the captured stderr may signal
      // usage-limit (the wrapper does the same thing). Prefer the
      // usage-limit classification over a generic error so the probe does
      // not falsely mark the profile as recovered.
      const stderr = (err as { stderr?: unknown }).stderr;
      const stdout = (err as { stdout?: unknown }).stdout;
      const combined = `${typeof stdout === "string" ? stdout : ""}\n${typeof stderr === "string" ? stderr : ""}`;
      if (combined.length > 0 && looksLikeCodexUsageLimit(combined)) {
        return { label: profile.label, home: profile.home, status: "usage_limit" };
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { label: profile.label, home: profile.home, status: "error", reason };
    }
  }

  /**
   * Run the probe once. Skips silently when the cron is not due or when
   * there are no Codex runs parked on `transient_upstream`.
   *
   * Safe to call from any periodic tick that fires more often than once
   * per minute.
   */
  async function tickProbe(now: Date = new Date()): Promise<ProbeTickOutcome> {
    if (!isDueAt(now)) {
      return { ranAt: now, profiles: [], acceleratedRunCount: 0, ran: false, skippedReason: "cron_not_due" };
    }

    const blockedRuns = await listBlockedCodexRuns();
    if (blockedRuns.length === 0) {
      return { ranAt: now, profiles: [], acceleratedRunCount: 0, ran: false, skippedReason: "no_blocked_runs" };
    }

    const profiles = resolveProfiles();
    if (profiles.length === 0) {
      logger.warn(
        { configuredCodexHome: process.env.CODEX_HOME ?? null, configuredCodexFallback: process.env.CODEX_FALLBACK ?? null },
        "Codex limit probe: no profiles configured but blocked runs exist; cannot probe",
      );
      return {
        ranAt: now,
        profiles: [],
        acceleratedRunCount: 0,
        ran: false,
        skippedReason: "no_profiles_configured",
      };
    }

    const outcomes: ProbeProfileOutcome[] = [];
    for (const profile of profiles) {
      // Sequential: total fan-out is at most ~2 profiles in the documented
      // configuration, and serial execution avoids competing for the codex
      // binary on the host.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await probeProfile(profile);
      outcomes.push(outcome);
    }

    const anyAlive = outcomes.some((o) => o.status === "alive");
    let acceleratedRunCount = 0;

    if (anyAlive) {
      // Snapshot the issues we are accelerating once; a new run may show up
      // mid-loop but it will be picked up by the next tick.
      const seenIssues = new Set<string>();
      for (const blocked of blockedRuns) {
        if (!blocked.issueId || seenIssues.has(blocked.issueId)) continue;
        seenIssues.add(blocked.issueId);
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await deps.heartbeat.retryScheduledRetryNow({
            issueId: blocked.issueId,
            actor: { actorType: "system", actorId: "codex-limit-probe" },
            now,
          });
          if (result.outcome === "promoted" || result.outcome === "already_promoted") {
            acceleratedRunCount += 1;
          }
        } catch (err) {
          logger.warn(
            { err, issueId: blocked.issueId, runId: blocked.runId },
            "Codex limit probe: failed to accelerate scheduled retry for blocked issue",
          );
        }
      }
      logger.info(
        {
          profiles: outcomes.map((o) => ({ label: o.label, status: o.status })),
          acceleratedRunCount,
          blockedRunCount: blockedRuns.length,
        },
        "Codex limit probe: at least one profile recovered; accelerated scheduled retries",
      );
    } else {
      logger.info(
        {
          profiles: outcomes.map((o) => ({ label: o.label, status: o.status })),
          blockedRunCount: blockedRuns.length,
        },
        "Codex limit probe: no profile recovered; will retry on the next cron tick",
      );
    }

    return {
      ranAt: now,
      profiles: outcomes,
      acceleratedRunCount,
      ran: true,
    };
  }

  return {
    tickProbe,
    listBlockedCodexRuns,
    probeProfile,
  };
}

export type CodexLimitProbeService = ReturnType<typeof codexLimitProbeService>;
