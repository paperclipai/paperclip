import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";

export const COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_DEFAULT = 30;
export const COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_MIN = 1;
export const COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV = "PAPERCLIP_ACTIVE_RUN_CONCURRENCY_CAP";
export const COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_THROTTLE_REASON =
  "active_run_concurrency_budget_at_cap";

export const COMPANY_ACTIVE_RUN_BUDGET_STATUSES = ["queued", "running", "scheduled_retry"] as const;

export interface CompanyActiveRunBudgetState {
  companyId: string;
  cap: number;
  activeRunCount: number;
  activeInProgressIssueRunCount: number;
  atCap: boolean;
  throttleReason: typeof COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_THROTTLE_REASON | null;
}

export function resolveCompanyActiveRunConcurrencyBudget(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_ENV];
  const parsed = raw == null || raw.trim() === "" ? NaN : Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_DEFAULT;
  return Math.max(
    COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_MIN,
    Math.min(COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_DEFAULT, parsed),
  );
}

export function buildCompanyActiveRunBudgetThrottleMessage(
  state: Pick<CompanyActiveRunBudgetState, "activeRunCount" | "activeInProgressIssueRunCount" | "cap">,
) {
  return `Wake deferred by company active-run concurrency budget (activeRunCount=${state.activeRunCount}, activeInProgressIssueRunCount=${state.activeInProgressIssueRunCount}, cap=${state.cap})`;
}

export async function lockCompanyActiveRunBudget(executor: Db, companyId: string) {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${companyId}))`,
  );
}

export async function getCompanyActiveRunBudgetState(
  executor: Db,
  companyId: string,
  options: { lock?: boolean } = {},
): Promise<CompanyActiveRunBudgetState> {
  if (options.lock) {
    await lockCompanyActiveRunBudget(executor, companyId);
  }

  const cap = resolveCompanyActiveRunConcurrencyBudget();
  const row = await executor
    .select({
      activeRunCount: sql<number>`count(distinct ${heartbeatRuns.id})::int`,
      activeInProgressIssueRunCount:
        sql<number>`count(distinct ${issues.id}) filter (where ${issues.status} = 'in_progress')::int`,
    })
    .from(heartbeatRuns)
    .leftJoin(
      issues,
      and(
        eq(issues.companyId, heartbeatRuns.companyId),
        or(
          eq(issues.executionRunId, heartbeatRuns.id),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      ),
    )
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...COMPANY_ACTIVE_RUN_BUDGET_STATUSES]),
      ),
    )
    .then((rows) => rows[0] ?? null);

  const activeRunCount = Number(row?.activeRunCount ?? 0);
  const activeInProgressIssueRunCount = Number(row?.activeInProgressIssueRunCount ?? 0);
  const atCap = activeRunCount >= cap;
  return {
    companyId,
    cap,
    activeRunCount,
    activeInProgressIssueRunCount,
    atCap,
    throttleReason: atCap ? COMPANY_ACTIVE_RUN_CONCURRENCY_BUDGET_THROTTLE_REASON : null,
  };
}

export function getCompanyActiveRunBudgetAvailableSlots(
  state: Pick<CompanyActiveRunBudgetState, "cap" | "activeRunCount">,
) {
  return Math.max(0, state.cap - state.activeRunCount);
}
