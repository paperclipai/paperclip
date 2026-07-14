import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns } from "@paperclipai/db";

export const CLAUDE_LOCAL_ADAPTER_TYPE = "claude_local";
export const CLAUDE_QUOTA_BLOCK_ERROR_CODE = "blocked_by_claude_quota";
export const CLAUDE_QUOTA_CIRCUIT_OPENED_ACTION = "claude.quota_circuit_opened";
export const CLAUDE_QUOTA_CIRCUIT_RESUMED_ACTION = "claude.quota_circuit_resumed";

const CLAUDE_QUOTA_LOCK_KEY = "paperclip:claude_local_quota_dispatch";

type ClaudeQuotaBlock = {
  blocked: boolean;
  reason: string;
  blockedUntil: Date | null;
  operatorResumeRequired: boolean;
};

type ClaudeQuotaFailureInput = {
  adapterType: string;
  status?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stderrExcerpt?: string | null;
  resultJson?: unknown;
};

type ClaudeQuotaDb = Pick<Db, "execute" | "select" | "insert">;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTimeZoneParts(date: Date, timeZone: string) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (![year, month, day, hour, minute].every(Number.isInteger)) return null;
    return { year, month, day, hour, minute };
  } catch {
    return null;
  }
}

function zonedTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  const guess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  const rendered = getTimeZoneParts(new Date(guess), input.timeZone);
  if (!rendered) return null;

  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    0,
    0,
  );
  const corrected = new Date(guess - (renderedAsUtc - guess));
  const verified = getTimeZoneParts(corrected, input.timeZone);
  if (
    !verified ||
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }
  return corrected;
}

export function parseClaudeQuotaResetTime(text: string, now = new Date()): Date | null {
  const match = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const ampm = match[3]?.toLowerCase();
  const timeZone = readString(match[4]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null;
  }
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;

  if (timeZone) {
    const nowParts = getTimeZoneParts(now, timeZone);
    if (!nowParts) return null;
    let reset = zonedTimeToUtc({
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour,
      minute,
      timeZone,
    });
    if (!reset) return null;
    if (reset.getTime() <= now.getTime()) {
      const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 12, 0, 0, 0));
      const nextParts = getTimeZoneParts(nextDay, timeZone);
      if (!nextParts) return null;
      reset = zonedTimeToUtc({
        year: nextParts.year,
        month: nextParts.month,
        day: nextParts.day,
        hour,
        minute,
        timeZone,
      });
    }
    return reset;
  }

  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return reset;
}

export function isClaudeQuotaOrSessionFailure(input: ClaudeQuotaFailureInput): boolean {
  if (input.adapterType !== CLAUDE_LOCAL_ADAPTER_TYPE) return false;
  const result = readObject(input.resultJson);
  const apiErrorStatus = readNumber(result.apiErrorStatus ?? result.httpStatus ?? result.statusCode);
  const status = (input.status ?? "").toLowerCase();
  const code = (input.errorCode ?? readString(result.error) ?? readString(result.errorCode) ?? "").toLowerCase();
  const text = [
    input.errorMessage,
    input.stderrExcerpt,
    readString(result.message),
    readString(result.errorMessage),
    readString(result.summary),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (input.httpStatus === 429 || apiErrorStatus === 429 || code === "rate_limit") return true;
  if (text.includes("you've hit your session limit")) return true;
  if (text.includes("session limit") || text.includes("resets")) return true;
  return status === "timed_out" || status === "adapter_failed";
}

export function claudeQuotaBlockMessage(block: ClaudeQuotaBlock): string {
  const until = block.blockedUntil ? ` until ${block.blockedUntil.toISOString()}` : " until an operator resumes it";
  return `Claude-local dispatch is blocked by Claude quota/session circuit breaker${until}`;
}

async function latestCircuitEvent(db: ClaudeQuotaDb, _companyId?: string | null) {
  const actions = [CLAUDE_QUOTA_CIRCUIT_OPENED_ACTION, CLAUDE_QUOTA_CIRCUIT_RESUMED_ACTION];
  const rows = await db
    .select()
    .from(activityLog)
    .where(inArray(activityLog.action, actions))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestClaudeQuotaCircuitOpenedAt(db: ClaudeQuotaDb): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(eq(activityLog.action, CLAUDE_QUOTA_CIRCUIT_OPENED_ACTION))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

export async function getClaudeQuotaBlock(db: ClaudeQuotaDb, companyId?: string | null, now = new Date()): Promise<ClaudeQuotaBlock> {
  const event = await latestCircuitEvent(db, companyId);
  if (!event || event.action === CLAUDE_QUOTA_CIRCUIT_RESUMED_ACTION) {
    return { blocked: false, reason: "ready", blockedUntil: null, operatorResumeRequired: false };
  }

  const details = readObject(event.details);
  const blockedUntilText = readString(details.blockedUntil);
  const blockedUntil = blockedUntilText ? new Date(blockedUntilText) : null;
  const validBlockedUntil = blockedUntil && Number.isFinite(blockedUntil.getTime()) ? blockedUntil : null;
  const operatorResumeRequired = details.operatorResumeRequired !== false && !validBlockedUntil;
  if (validBlockedUntil && validBlockedUntil.getTime() <= now.getTime()) {
    return { blocked: false, reason: "reset_elapsed", blockedUntil: validBlockedUntil, operatorResumeRequired: false };
  }

  return {
    blocked: true,
    reason: readString(details.reason) ?? CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    blockedUntil: validBlockedUntil,
    operatorResumeRequired,
  };
}

export async function recordClaudeQuotaFailure(
  db: ClaudeQuotaDb,
  input: ClaudeQuotaFailureInput & {
    companyId: string;
    agentId?: string | null;
    runId?: string | null;
    observedAt?: Date;
  },
) {
  if (!isClaudeQuotaOrSessionFailure(input)) return null;

  const observedAt = input.observedAt ?? new Date();
  const resetAt = parseClaudeQuotaResetTime(
    [input.errorMessage, input.stderrExcerpt].filter(Boolean).join(" "),
    observedAt,
  );
  const details = {
    reason: CLAUDE_QUOTA_BLOCK_ERROR_CODE,
    blockedUntil: resetAt?.toISOString() ?? null,
    operatorResumeRequired: resetAt ? false : true,
    triggeringRunId: input.runId ?? null,
    triggeringStatus: input.status ?? null,
    triggeringErrorCode: input.errorCode ?? null,
    triggeringHttpStatus: input.httpStatus ?? null,
  };

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "claude_quota_guard",
    action: CLAUDE_QUOTA_CIRCUIT_OPENED_ACTION,
    entityType: "system",
    entityId: CLAUDE_LOCAL_ADAPTER_TYPE,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details,
    createdAt: observedAt,
  });
  return details;
}

export async function blockIfClaudeQuotaOpen(db: ClaudeQuotaDb, companyId: string) {
  const block = await getClaudeQuotaBlock(db, companyId);
  return block.blocked ? block : null;
}

export async function acquireClaudeLocalDispatchSlot(
  tx: ClaudeQuotaDb,
  companyId: string,
  runId: string,
): Promise<{ allowed: true } | { allowed: false; reason: "circuit_open" | "concurrency_limit"; block?: ClaudeQuotaBlock }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CLAUDE_QUOTA_LOCK_KEY}, 0))`);

  const block = await getClaudeQuotaBlock(tx, companyId);
  if (block.blocked) {
    return { allowed: false, reason: "circuit_open", block };
  }

  const runningRows = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(and(
      eq(heartbeatRuns.status, "running"),
      eq(agents.adapterType, CLAUDE_LOCAL_ADAPTER_TYPE),
      sql`${heartbeatRuns.id} <> ${runId}`,
    ))
    .limit(1);

  if (runningRows.length > 0) {
    return { allowed: false, reason: "concurrency_limit" };
  }

  return { allowed: true };
}
