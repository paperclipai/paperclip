/**
 * Seat-level circuit breaker (ROC-2148).
 *
 * Stops "board death": when a Claude subscription seat hits its weekly/usage cap
 * it returns rate_limit/401, the run fails, and the heartbeat scheduler otherwise
 * re-enqueues every interval — hammering an already-capped seat. Because MANY
 * agents can share ONE Claude profile (CLAUDE_CONFIG_DIR), the fragile resource is
 * the *seat*, not the agent. This breaker is therefore keyed by seat.
 *
 * State machine per seat:
 *   closed     -> normal; dispatch allowed.
 *   open        -> in cooldown; ALL agents on the seat are skipped until cooldownUntil.
 *   half_open   -> cooldown elapsed; exactly ONE agent (probeAgentId) is allowed to
 *                  probe. Others stay blocked. Probe success -> closed (reset);
 *                  probe failure -> open again with escalated backoff. A stale probe
 *                  (held > PROBE_TIMEOUT_MS) is reassigned so recovery can't wedge.
 *
 * This kills the thundering herd: on cooldown expiry only one request hits the seat.
 *
 * Trip classification: only genuine provider failures count. Orchestrator-level
 * outcomes (cancelled, process_lost, timeout) never trip the breaker.
 *
 * State is persisted to a JSON file (single Node process) so it survives restarts —
 * a restart must not silently re-open the firehose. No DB / no migration.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

const BACKPRESSURE_ENABLED = process.env.BACKPRESSURE_ENABLED !== "false";
const RATE_LIMIT_BASE_MS = num(process.env.BREAKER_RATE_LIMIT_BASE_MS, 300_000); // 5 min
const RATE_LIMIT_MAX_MS = num(process.env.BREAKER_RATE_LIMIT_MAX_MS, 21_600_000); // 6 h
const AUTH_BASE_MS = num(process.env.BREAKER_AUTH_BASE_MS, 300_000); // 5 min
const AUTH_MAX_MS = num(process.env.BREAKER_AUTH_MAX_MS, 21_600_000); // 6 h
const TRANSIENT_BASE_MS = num(process.env.BREAKER_TRANSIENT_BASE_MS, 30_000); // 30 s
const TRANSIENT_MAX_MS = num(process.env.BREAKER_TRANSIENT_MAX_MS, 600_000); // 10 min
const RATE_LIMIT_THRESHOLD = 1; // trip immediately on a cap
const AUTH_THRESHOLD = 2; // tolerate one transient 401 / token-refresh blip
const TRANSIENT_THRESHOLD = 3;
const PROBE_TIMEOUT_MS = num(process.env.BREAKER_PROBE_TIMEOUT_MS, 180_000); // 3 min

export type FailureClass = "rate_limit" | "auth" | "transient";
export type BreakerState = "closed" | "open" | "half_open";

export interface SeatBreaker {
  seatKey: string;
  state: BreakerState;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  lastReason: FailureClass | null;
  lastTrippedAt: number | null;
  probeAgentId: string | null;
  probeStartedAt: number | null;
  updatedAt: number;
}

const seats = new Map<string, SeatBreaker>();

function stateFilePath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "seat-breakers.json");
}

// Load persisted state once at module init.
(function loadFromDisk() {
  try {
    const file = stateFilePath();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as SeatBreaker[];
    if (Array.isArray(parsed)) {
      // Prune stale records (agy 2026-06-09 audit): drop closed/warming entries not
      // touched in >7d so churned/decommissioned agents don't grow the map forever.
      const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const s of parsed) {
        if (!s || typeof s.seatKey !== "string") continue;
        const active = s.state === "open" || s.state === "half_open";
        const stale = now - (s.updatedAt || 0) > PRUNE_MS;
        if (stale && !active) continue;
        seats.set(s.seatKey, s);
      }
    }
    logger.debug({ seats: seats.size }, "backpressure: loaded seat-breaker state");
  } catch (err) {
    logger.warn({ err }, "backpressure: failed to load seat-breaker state; starting empty");
  }
})();

function persist(): void {
  try {
    const file = stateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(seats.values())), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn({ err }, "backpressure: failed to persist seat-breaker state");
  }
}

function readEnvValue(envVal: unknown): string | null {
  // adapterConfig.env value may be a plain string or a {type:"plain",value} / {value} wrapper.
  if (typeof envVal === "string") return envVal.trim() || null;
  if (envVal && typeof envVal === "object") {
    const v = (envVal as Record<string, unknown>).value;
    if (typeof v === "string") return v.trim() || null;
  }
  return null;
}

/**
 * Seat identity. claude_local agents sharing a CLAUDE_CONFIG_DIR share a seat;
 * everything else is its own seat keyed by agent id.
 */
export function seatKeyForAgent(agent: {
  id: string;
  adapterType?: string | null;
  adapterConfig?: unknown;
}): string {
  let cfg: Record<string, unknown> | null = null;
  const ac = agent.adapterConfig;
  if (ac && typeof ac === "object") cfg = ac as Record<string, unknown>;
  else if (typeof ac === "string") {
    try {
      const p = JSON.parse(ac);
      if (p && typeof p === "object") cfg = p as Record<string, unknown>;
    } catch {
      cfg = null;
    }
  }
  if (cfg) {
    const env = cfg.env;
    if (env && typeof env === "object") {
      const dir = readEnvValue((env as Record<string, unknown>).CLAUDE_CONFIG_DIR);
      if (dir) return `claude:${dir}`;
    }
    const direct = readEnvValue(cfg.claudeConfigDir);
    if (direct) return `claude:${direct}`;
  }
  return `agent:${agent.id}`;
}

/**
 * Classify a run failure. Auth is checked before rate_limit. Orchestrator-level
 * outcomes (process_lost/cancelled/timeout) are NOT seat failures -> null.
 */
export function classifyFailure(
  errorCode: string | null | undefined,
  message: string | null | undefined,
): FailureClass | null {
  const code = (errorCode ?? "").toLowerCase();
  if (code === "process_lost" || code === "cancelled" || code === "timeout") return null;
  const hay = `${code} ${(message ?? "").toLowerCase()}`;
  if (/401|invalid authentication|authentication_failed|unauthorized|invalid api key/.test(hay)) {
    return "auth";
  }
  if (/rate.?limit|429|quota|usage limit|overloaded|exhausted|too many requests/.test(hay)) {
    return "rate_limit";
  }
  return "transient";
}

export interface DispatchDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Gate a dispatch for (seatKey, agentId). Transitions open->half_open on cooldown
 * expiry, granting the calling agent the single probe slot.
 */
export function canDispatch(seatKey: string, agentId: string, now = Date.now()): DispatchDecision {
  if (!BACKPRESSURE_ENABLED) return { allowed: true, reason: null };
  const seat = seats.get(seatKey);
  if (!seat || seat.state === "closed") return { allowed: true, reason: null };

  if (seat.state === "open") {
    if (seat.cooldownUntil != null && now < seat.cooldownUntil) {
      return { allowed: false, reason: `circuit_open:${seat.lastReason ?? "unknown"}` };
    }
    // Cooldown elapsed -> half-open this agent as the single probe.
    seat.state = "half_open";
    seat.probeAgentId = agentId;
    seat.probeStartedAt = now;
    seat.updatedAt = now;
    persist();
    logger.info({ seatKey, agentId }, "backpressure: seat half-open, granting probe");
    return { allowed: true, reason: null };
  }

  if (seat.state === "half_open") {
    if (seat.probeAgentId === agentId) return { allowed: true, reason: null };
    if (seat.probeStartedAt != null && now - seat.probeStartedAt > PROBE_TIMEOUT_MS) {
      // Stale probe — reassign so recovery can't wedge on a stuck prober.
      seat.probeAgentId = agentId;
      seat.probeStartedAt = now;
      seat.updatedAt = now;
      persist();
      return { allowed: true, reason: null };
    }
    return { allowed: false, reason: "seat_half_open" };
  }

  return { allowed: true, reason: null };
}

/** A successful run closes the breaker for the whole seat. */
export function recordSuccess(seatKey: string): void {
  if (seats.delete(seatKey)) persist();
}

/** Record a classified provider failure, escalating/ tripping the seat as needed. */
export function recordFailure(seatKey: string, cls: FailureClass, now = Date.now()): void {
  let seat = seats.get(seatKey);
  if (!seat) {
    seat = {
      seatKey,
      state: "closed",
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastReason: null,
      lastTrippedAt: null,
      probeAgentId: null,
      probeStartedAt: null,
      updatedAt: now,
    };
    seats.set(seatKey, seat);
  }

  const wasHalfOpen = seat.state === "half_open";
  seat.consecutiveFailures += 1;
  seat.lastReason = cls;
  seat.updatedAt = now;

  let threshold: number;
  let base: number;
  let max: number;
  if (cls === "rate_limit") {
    threshold = RATE_LIMIT_THRESHOLD;
    base = RATE_LIMIT_BASE_MS;
    max = RATE_LIMIT_MAX_MS;
  } else if (cls === "auth") {
    threshold = AUTH_THRESHOLD;
    base = AUTH_BASE_MS;
    max = AUTH_MAX_MS;
  } else {
    threshold = TRANSIENT_THRESHOLD;
    base = TRANSIENT_BASE_MS;
    max = TRANSIENT_MAX_MS;
  }

  // A failed probe (half_open) re-opens immediately; otherwise trip once threshold reached.
  if (wasHalfOpen || seat.consecutiveFailures >= threshold) {
    const backoffSteps = Math.max(0, seat.consecutiveFailures - 1);
    seat.state = "open";
    seat.lastTrippedAt = now;
    seat.probeAgentId = null;
    seat.probeStartedAt = null;
    seat.cooldownUntil = now + Math.min(max, base * Math.pow(2, backoffSteps));
    logger.warn(
      { seatKey, cls, consecutiveFailures: seat.consecutiveFailures, cooldownUntil: seat.cooldownUntil },
      "backpressure: seat breaker OPEN",
    );
  }
  persist();
}

export function getSeat(seatKey: string): SeatBreaker | undefined {
  return seats.get(seatKey);
}

export function snapshot(): SeatBreaker[] {
  return Array.from(seats.values());
}
