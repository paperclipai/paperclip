import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { HttpError } from "../errors.js";

const DEFAULT_GRACE_MS = 2 * 60 * 1000;

/**
 * Thrown when a company is currently under a quota-driven auto-pause window
 * (`companies.paused_until > now()`). HTTP 503 so the API and dispatcher both
 * surface the same status to callers.
 */
export class CompanyPausedError extends HttpError {
  readonly pausedUntil: Date;
  readonly pausedReason: string | null;

  constructor(pausedUntil: Date, pausedReason: string | null) {
    super(
      503,
      pausedReason
        ? `Company is paused until ${pausedUntil.toISOString()} (${pausedReason}).`
        : `Company is paused until ${pausedUntil.toISOString()}.`,
      { pausedUntil: pausedUntil.toISOString(), pausedReason },
    );
    this.pausedUntil = pausedUntil;
    this.pausedReason = pausedReason;
  }
}

/**
 * Reads `companies.paused_until` and throws `CompanyPausedError` if the pause
 * window is still active. Used by the heartbeat dispatcher, the issue checkout
 * route, and the agent-token auth middleware to short-circuit work for a paused
 * company in a single place (ADR-001 D3). The middleware MUST only apply this
 * to agent tokens — human user requests bypass the gate so a manual unpause is
 * always possible.
 */
export async function assertCompanyNotPaused(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<void> {
  const rows = await db
    .select({
      pausedUntil: companies.pausedUntil,
      pausedReason: companies.pausedReason,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const row = rows[0];
  if (!row?.pausedUntil) return;
  if (row.pausedUntil.getTime() <= now.getTime()) return;
  throw new CompanyPausedError(row.pausedUntil, row.pausedReason ?? null);
}

export interface ApplyCompanyQuotaPauseInput {
  db: Db;
  companyId: string;
  /** Reset moment reported by the adapter (e.g. Claude's `resets HH:MM`). */
  resetAt: Date;
  /** Run id that triggered the pause, embedded into `paused_reason` for audit. */
  runId: string;
  /** Extra wall-clock buffer beyond the reset moment. Defaults to 2 minutes per ADR-001 D3. */
  graceMs?: number;
}

export interface ApplyCompanyQuotaPauseResult {
  applied: boolean;
  pausedUntil: Date;
  pausedReason: string;
}

/**
 * Sets `paused_until` and `paused_reason` on the company in one statement,
 * keyed on the new `pausedUntil` only being later than the current one (so
 * concurrent quota signals don't shorten an existing pause window). ADR-001 D3.
 */
export async function applyCompanyQuotaPause(
  input: ApplyCompanyQuotaPauseInput,
): Promise<ApplyCompanyQuotaPauseResult> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const pausedUntil = new Date(input.resetAt.getTime() + graceMs);
  const pausedReason = `claude_quota_exhausted:${input.runId}`;

  const result = await input.db
    .update(companies)
    .set({
      pausedUntil,
      pausedReason,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(companies.id, input.companyId),
        or(
          sql`${companies.pausedUntil} IS NULL`,
          lt(companies.pausedUntil, pausedUntil),
        ),
      ),
    )
    .returning({ id: companies.id });

  return {
    applied: result.length > 0,
    pausedUntil,
    pausedReason,
  };
}

/**
 * Clears the quota auto-pause window. Used by the P-2 canary path and by
 * admin/unpause flows. Leaves the existing manual `pause_reason`/`paused_at`
 * fields untouched — those belong to the budgets service.
 */
export async function clearCompanyQuotaPause(db: Db, companyId: string): Promise<void> {
  await db
    .update(companies)
    .set({
      pausedUntil: null,
      pausedReason: null,
      pausedCanaryAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(companies.id, companyId), isNotNull(companies.pausedUntil)));
}
