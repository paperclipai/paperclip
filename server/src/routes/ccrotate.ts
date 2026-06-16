/**
 * ccrotate pool status endpoint.
 *
 * Exposes a JSON snapshot of ccrotate's account-availability state so the
 * in-cluster health-check CronJob, dashboards, and agents can query pool
 * depth without `kubectl exec` into paperclip-0. The shape mirrors the
 * state-server-backed ccrotate plugin snapshot: sanitized account emails,
 * availability buckets, and exhausted-until times. It deliberately avoids the
 * local `ccrotate` CLI; production images may carry only a read-only shim
 * while canonical pool state lives in the ccrotate state server.
 *
 * Returned shape:
 *
 *   {
 *     "claude": {
 *       "active": "<email>",          // currently-active account, if any
 *       "usableNow": ["<email>", ...],
 *       "stale":     ["<email>", ...], // need operator /login + snap
 *       "exhausted": [{ email, resumesAt: "ISO", resumesInSec: number }],
 *       "unknown":   ["<email>", ...], // no usage data yet
 *       "total": number,
 *       "degraded": boolean            // true when stale > 0 OR usableNow <= 2
 *     },
 *     "codex":  { same shape },
 *     "checkedAt": "ISO timestamp"
 *   }
 *
 * Wakeup-driven CronJob alerts on `degraded === true`.
 */

import { Router } from "express";
import { logger } from "../middleware/logger.js";
import { assertAuthenticated } from "./authz.js";

const TARGETS = ["claude", "codex"] as const;
type Target = (typeof TARGETS)[number];

interface ExhaustedEntry {
  email: string;
  resumesAt: string;
  resumesInSec: number;
}

export interface TargetStatus {
  active: string | null;
  usableNow: string[];
  stale: string[];
  exhausted: ExhaustedEntry[];
  unknown: string[];
  total: number;
  degraded: boolean;
}

function emptyStatus(): TargetStatus {
  return {
    active: null,
    usableNow: [],
    stale: [],
    exhausted: [],
    unknown: [],
    total: 0,
    degraded: true, // missing data is degraded by default
  };
}

interface RateLimits {
  utilization5h?: number | null;
  utilization7d?: number | null;
  remaining5h?: number | null;
  remaining7d?: number | null;
  resetAt?: number | string | null;
  reset5h?: number | string | null;
  reset7d?: number | string | null;
  [key: string]: unknown;
}

interface ExhaustionRecord {
  reset5h?: number | string | null;
  reset7d?: number | string | null;
  response?: string | null;
}

interface TierCacheAccount {
  email?: string | null;
  status?: string | null;
  serviceTier?: string | null;
  response?: string | null;
  exhausted?: Record<string, ExhaustionRecord | null | undefined> | null;
  exhaustedModel?: string | null;
  rateLimits?: RateLimits | null;
  [key: string]: unknown;
}

interface TierCacheSnapshot {
  updatedAt?: string | null;
  accounts?: TierCacheAccount[];
}

interface Profile {
  stale?: boolean;
  staleReason?: string | null;
  credentials?: {
    claudeAiOauth?: {
      accessToken?: string | null;
    } | null;
  } | null;
  auth?: unknown;
  [key: string]: unknown;
}

type ProfilesSnapshot = Record<string, Profile | undefined>;

const STATE_BASE_URL = (
  process.env.CCROTATE_STATE_URL ??
  "http://ccrotate-auth-bot-state.paperclip.svc:4002"
).replace(/\/+$/, "");
const STATE_TOKEN = process.env.CCROTATE_STATE_TOKEN || null;

function stateHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    ...(STATE_TOKEN ? { authorization: `Bearer ${STATE_TOKEN}` } : {}),
  };
}

async function fetchStateJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${STATE_BASE_URL}${path}`, {
      method: "GET",
      headers: stateHeaders(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${text.slice(0, 200) || res.statusText}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

function targetQuery(target: Target): string {
  return target === "codex" ? "?target=codex" : "";
}

function resetToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function readExhaustion(entry: TierCacheAccount | null | undefined): Record<string, ExhaustionRecord> {
  if (!entry || typeof entry !== "object") return {};
  const out: Record<string, ExhaustionRecord> = {};
  if (entry.exhausted && typeof entry.exhausted === "object") {
    for (const [key, value] of Object.entries(entry.exhausted)) {
      if (value && typeof value === "object") out[key] = value;
    }
  }
  if (Object.keys(out).length === 0 && entry.serviceTier === "exhausted") {
    const model = entry.exhaustedModel ?? (entry.rateLimits?.exhaustedModel as string | undefined) ?? "*";
    out[model] = {
      reset5h: entry.rateLimits?.reset5h ?? null,
      reset7d: entry.rateLimits?.reset7d ?? null,
      response: entry.response ?? null,
    };
  }
  return out;
}

function exhaustionResetMs(entry: TierCacheAccount | null | undefined, nowMs: number): number | null {
  const resets = Object.values(readExhaustion(entry))
    .flatMap((record) => [resetToMs(record.reset5h), resetToMs(record.reset7d)])
    .filter((value): value is number => value != null && value > nowMs);
  return resets.length > 0 ? Math.max(...resets) : null;
}

function quotaResetMs(entry: TierCacheAccount | null | undefined, target: Target, nowMs: number): number | null {
  const rateLimits = entry?.rateLimits ?? {};
  const resetAt = resetToMs(rateLimits.resetAt);
  const reset5h = resetToMs(rateLimits.reset5h);
  const reset7d = resetToMs(rateLimits.reset7d);
  if (target === "claude") {
    const fiveHBlocked = typeof rateLimits.utilization5h === "number" && rateLimits.utilization5h >= 95;
    const sevenDBlocked = typeof rateLimits.utilization7d === "number" && rateLimits.utilization7d >= 95;
    const resets = [
      fiveHBlocked ? reset5h : null,
      sevenDBlocked ? (reset7d ?? resetAt) : null,
    ].filter((value): value is number => value != null && value > nowMs);
    return resets.length > 0 ? Math.max(...resets) : null;
  }
  const fiveHBlocked = typeof rateLimits.remaining5h === "number" && rateLimits.remaining5h <= 0;
  const sevenDBlocked = typeof rateLimits.remaining7d === "number" && rateLimits.remaining7d <= 0;
  const resets = [
    fiveHBlocked ? reset5h : null,
    sevenDBlocked ? (reset7d ?? resetAt) : null,
  ].filter((value): value is number => value != null && value > nowMs);
  return resets.length > 0 ? Math.max(...resets) : null;
}

function isUsableNow(entry: TierCacheAccount | null | undefined, profile: Profile | undefined, target: Target, nowMs: number): boolean {
  if (profile?.stale) return false;
  if (exhaustionResetMs(entry, nowMs) || quotaResetMs(entry, target, nowMs)) return false;
  const tier = String(entry?.serviceTier ?? entry?.status ?? "").toLowerCase();
  if (target === "claude") {
    const rateLimits = entry?.rateLimits ?? {};
    if (typeof rateLimits.utilization5h === "number" || typeof rateLimits.utilization7d === "number") {
      return (rateLimits.utilization5h ?? 0) < 95 && (rateLimits.utilization7d ?? 0) < 95;
    }
    return ["base", "extra", "standard", "available"].includes(tier);
  }
  const rateLimits = entry?.rateLimits ?? {};
  if (typeof rateLimits.remaining5h === "number" || typeof rateLimits.remaining7d === "number") {
    return (rateLimits.remaining5h ?? 1) > 0 && (rateLimits.remaining7d ?? 1) > 0;
  }
  return tier === "available" || tier === "near_limit";
}

export function statusFromStateSnapshot(input: {
  target: Target;
  profiles: ProfilesSnapshot;
  tierCache: TierCacheSnapshot | null;
  activeEmail?: string | null;
  nowMs?: number;
}): TargetStatus {
  const nowMs = input.nowMs ?? Date.now();
  const status = emptyStatus();
  const cacheByEmail = new Map<string, TierCacheAccount>();
  for (const account of input.tierCache?.accounts ?? []) {
    if (typeof account?.email === "string" && account.email.length > 0) {
      cacheByEmail.set(account.email, account);
    }
  }

  const emails = new Set<string>([
    ...Object.keys(input.profiles ?? {}),
    ...cacheByEmail.keys(),
  ]);
  for (const email of [...emails].sort()) {
    const profile = input.profiles[email];
    const cached = cacheByEmail.get(email);
    if (email === input.activeEmail) status.active = email;
    if (profile?.stale) {
      status.stale.push(email);
      continue;
    }
    const resetMs = exhaustionResetMs(cached, nowMs) ?? quotaResetMs(cached, input.target, nowMs);
    if (resetMs) {
      const resumesInSec = Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
      status.exhausted.push({
        email,
        resumesAt: new Date(resetMs).toISOString(),
        resumesInSec,
      });
      continue;
    }
    if (isUsableNow(cached, profile, input.target, nowMs)) {
      status.usableNow.push(email);
    } else {
      status.unknown.push(email);
    }
  }
  status.total =
    status.usableNow.length +
    status.stale.length +
    status.exhausted.length +
    status.unknown.length;
  status.degraded = status.stale.length > 0 || status.usableNow.length <= 2;
  return status;
}

// `ccrotate when` produces lines like:
//   ★ ✓ 🟢 bot1@blockcast.net           base       5h:36% 7d:62%   usable now
//     ✓ 🔴 princeomz2004@gmail.com     ?                          stale (needs /login + snap)
//     ✓ ⏳ omar.ramadan@blockcast.net   exhausted  5h:0% 7d:100%   in 49h50m
//     ✓ ❔ ramadan@blockcast.net        ?                          no data (needs refresh)
//
// Header line: `Cache: <n>min old`. Status emojis vary; we key off the
// trailing label tokens which are stable.
const EMAIL_RE = /([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;

function parseDurationToSeconds(s: string): number {
  let total = 0;
  for (const m of s.matchAll(/(\d+)\s*([hms])/g)) {
    const n = Number.parseInt(m[1], 10);
    if (m[2] === "h") total += n * 3600;
    else if (m[2] === "m") total += n * 60;
    else if (m[2] === "s") total += n;
  }
  return total;
}

export function parseWhenOutput(out: string): TargetStatus {
  const status = emptyStatus();
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Cache:/.test(line)) continue;
    const emailMatch = EMAIL_RE.exec(line);
    if (!emailMatch) continue;
    const email = emailMatch[1];
    if (line.includes("★")) status.active = email;
    // BLO-4938: codex `near_limit` accounts are still rotation candidates
    // per ccrotate 1.1.1-kkroo.12 (BLO-4474), but the `ccrotate when` row
    // ends in `in <duration>` (the next reset). Without this guard, near_limit
    // lines fall through to the `in <duration>` branch and get mis-routed to
    // `exhausted`. Check the tier label before the reset hint.
    if (/usable now\b/.test(line) || /\bnear_limit\b/.test(line)) {
      status.usableNow.push(email);
    } else if (/\bstale\b/.test(line)) {
      status.stale.push(email);
    } else if (/\bin\s+\d+[hms]/i.test(line)) {
      const dur = /\bin\s+([\dhms\s]+)/i.exec(line);
      const seconds = dur ? parseDurationToSeconds(dur[1]) : 0;
      status.exhausted.push({
        email,
        resumesAt: new Date(Date.now() + seconds * 1000).toISOString(),
        resumesInSec: seconds,
      });
    } else if (/no data/.test(line)) {
      status.unknown.push(email);
    }
  }
  status.total =
    status.usableNow.length +
    status.stale.length +
    status.exhausted.length +
    status.unknown.length;
  // Degraded when any stale account exists OR usable pool depth <= 2.
  status.degraded = status.stale.length > 0 || status.usableNow.length <= 2;
  return status;
}

async function getTargetStatus(target: Target): Promise<TargetStatus> {
  try {
    const [current, profiles, tierCache] = await Promise.all([
      fetchStateJson<{ email?: string | null }>("/state/current").catch(() => ({ email: null })),
      fetchStateJson<ProfilesSnapshot>(`/state/profiles${targetQuery(target)}`),
      fetchStateJson<TierCacheSnapshot>(`/state/tier-cache${targetQuery(target)}`),
    ]);
    return statusFromStateSnapshot({
      target,
      profiles,
      tierCache,
      activeEmail: current.email ?? null,
    });
  } catch (err) {
    logger.warn({ err, target }, "ccrotate state snapshot failed; returning empty/degraded status");
    return emptyStatus();
  }
}

export function ccrotateRoutes() {
  const router = Router();

  router.get("/status", async (req, res) => {
    assertAuthenticated(req);
    const [claude, codex] = await Promise.all([
      getTargetStatus("claude"),
      getTargetStatus("codex"),
    ]);
    res.json({
      claude,
      codex,
      checkedAt: new Date().toISOString(),
    });
  });

  return router;
}
