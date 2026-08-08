import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./quota.js";

export interface RateLimitSignal {
  tokensRemaining: number | null;
  resetAt: Date | null;
  retryAfterAt: Date | null;
}

export interface QuotaState {
  tokensRemaining: number | null;
  resetAt: string | null;
  retryAfterAt: string | null;
  recordedAt: string;
}

export const DEFAULT_TOKENS_REMAINING_THRESHOLD = 5000;

const QUOTA_STORE_FILENAME = "paperclip-quota.json";

let memoryStore: QuotaState | null = null;

function quotaStorePath(): string {
  return path.join(claudeConfigDir(), QUOTA_STORE_FILENAME);
}

function readHeader(
  headers: Headers | Record<string, string | string[] | undefined> | Map<string, string>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    const v = headers.get(lower);
    return v == null ? null : v;
  }
  if (headers instanceof Map) {
    for (const [k, v] of headers.entries()) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v[0] ?? null;
    return typeof v === "string" ? v : null;
  }
  return null;
}

function parsePositiveInt(value: string | null): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function parseIsoDate(value: string | null): Date | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000);
  }
  return parseIsoDate(trimmed);
}

export function parseAnthropicRateLimitHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | Map<string, string>,
  now: Date = new Date(),
): RateLimitSignal {
  const tokensRemaining = parsePositiveInt(readHeader(headers, "anthropic-ratelimit-tokens-remaining"));
  const resetAt = parseIsoDate(readHeader(headers, "anthropic-ratelimit-tokens-reset"));
  const retryAfterAt = parseRetryAfter(readHeader(headers, "retry-after"), now);
  return { tokensRemaining, resetAt, retryAfterAt };
}

function loadFromDisk(): QuotaState | null {
  try {
    const raw = fs.readFileSync(quotaStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<QuotaState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      tokensRemaining:
        typeof parsed.tokensRemaining === "number" && Number.isFinite(parsed.tokensRemaining)
          ? parsed.tokensRemaining
          : null,
      resetAt: typeof parsed.resetAt === "string" ? parsed.resetAt : null,
      retryAfterAt: typeof parsed.retryAfterAt === "string" ? parsed.retryAfterAt : null,
      recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function persistToDisk(state: QuotaState): void {
  try {
    const dir = path.dirname(quotaStorePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(quotaStorePath(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort — in-memory store remains authoritative for this process
  }
}

function currentState(): QuotaState | null {
  if (memoryStore) return memoryStore;
  const fromDisk = loadFromDisk();
  if (fromDisk) memoryStore = fromDisk;
  return memoryStore;
}

export function recordQuotaSignal(signal: RateLimitSignal, now: Date = new Date()): QuotaState {
  const state: QuotaState = {
    tokensRemaining: signal.tokensRemaining,
    resetAt: signal.resetAt ? signal.resetAt.toISOString() : null,
    retryAfterAt: signal.retryAfterAt ? signal.retryAfterAt.toISOString() : null,
    recordedAt: now.toISOString(),
  };
  memoryStore = state;
  persistToDisk(state);
  return state;
}

export function recordRetryAfter(retryAfterAt: Date, now: Date = new Date()): QuotaState {
  return recordQuotaSignal({ tokensRemaining: null, resetAt: null, retryAfterAt }, now);
}

export function clearQuotaStore(): void {
  memoryStore = null;
  try {
    fs.rmSync(quotaStorePath(), { force: true });
  } catch {
    // ignore
  }
}

export interface ActivePause {
  pauseUntil: Date;
  reason: "tokens-remaining-below-threshold" | "retry-after" | "tokens-reset-in-future";
}

export function getActivePause(
  now: Date = new Date(),
  tokensThreshold: number = DEFAULT_TOKENS_REMAINING_THRESHOLD,
): ActivePause | null {
  const state = currentState();
  if (!state) return null;

  const retryAfterAt = state.retryAfterAt ? new Date(state.retryAfterAt) : null;
  if (retryAfterAt && retryAfterAt.getTime() > now.getTime()) {
    return { pauseUntil: retryAfterAt, reason: "retry-after" };
  }

  const resetAt = state.resetAt ? new Date(state.resetAt) : null;
  const belowThreshold =
    typeof state.tokensRemaining === "number" && state.tokensRemaining < tokensThreshold;

  if (belowThreshold && resetAt && resetAt.getTime() > now.getTime()) {
    return { pauseUntil: resetAt, reason: "tokens-remaining-below-threshold" };
  }

  return null;
}

/** Test helper: replace the in-memory store directly without touching disk. */
export function __setQuotaStateForTests(state: QuotaState | null): void {
  memoryStore = state;
}
