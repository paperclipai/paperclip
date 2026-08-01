import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";

// Default alert threshold: the recovery rate that a regression like the 07-06
// week (3.26% of runs) blew past while nobody noticed by feel. See the plan on
// PAP-14080 (Phase 3) and the retrospective on PAP-14098.
export const DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT = 2;
const DEFAULT_WINDOW_WEEKS = 8;
// Upper bound on the reporting window. Caps the per-week array allocation so an
// attacker-supplied `weeks` query param can't trigger an unbounded allocation
// (~2 years of weekly buckets is far beyond any real dashboard use).
export const MAX_WINDOW_WEEKS = 104;

// Weeks are ISO/Monday-anchored to match the retrospective table (2026-06-01 is
// a Monday). Postgres `date_trunc('week', ...)` is Monday-based, so this keeps
// the live report aligned with the numbers in the plan document.

export type WeeklyRecoveryRate = {
  /** Monday (UTC) of the week, `YYYY-MM-DD`. */
  weekStart: string;
  runs: number;
  recoveryActions: number;
  /** recoveryActions / runs, as a percentage (0 when there are no runs). */
  ratePercent: number;
};

export type RecoveryRateAlert = {
  thresholdPercent: number;
  /** True when any complete week in the window exceeded the threshold. */
  breached: boolean;
  breachedWeeks: WeeklyRecoveryRate[];
  latestWeek: WeeklyRecoveryRate | null;
  latestWeekBreached: boolean;
};

export type RecoveryCauseGroup = {
  cause: string;
  latestRunErrorCode: string;
  count: number;
  activeCount: number;
  resolvedCount: number;
  cancelledCount: number;
};

export type RecoveryHandoffSummary = {
  /** Genuine manager takeovers (recovery owner != original assignee) that resolved. */
  resolvedTakeovers: number;
  handedBack: number;
  ownerCompleted: number;
  otherTakeover: number;
  /** Original agent recovered its own issue (owner == original assignee). */
  selfRecovery: number;
  boardOwned: number;
  activeTakeovers: number;
  /** handedBack / (handedBack + ownerCompleted); null when no resolved takeovers. */
  handedBackRatio: number | null;
  ownerCompletedRatio: number | null;
};

export type RecoveryCauseRouting = {
  cause: string;
  total: number;
  active: number;
  /** Original agent recovered its own issue and resolved it. */
  retriedByOriginalSucceeded: number;
  handedBack: number;
  ownerCompleted: number;
  escalated: number;
  falsePositive: number;
  cancelled: number;
};

export type RecoveryObservabilityReport = {
  companyId: string;
  generatedAt: string;
  window: { weeks: number; since: string };
  thresholdPercent: number;
  weekly: WeeklyRecoveryRate[];
  alert: RecoveryRateAlert;
  byCause: RecoveryCauseGroup[];
  handoff: RecoveryHandoffSummary;
  perCauseRouting: RecoveryCauseRouting[];
};

export type HandoffClass =
  | "self_recovery"
  | "handed_back"
  | "owner_completed"
  | "board_owned"
  | "active"
  | "other";

type RecoveryActionFacts = {
  status: string;
  outcome: string | null;
  ownerAgentId: string | null;
  returnOwnerAgentId: string | null;
  finalAssigneeAgentId: string | null;
  finalIssueStatus: string | null;
};

const ACTIVE_STATUSES = new Set(["active", "escalated"]);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "in_review"]);

/**
 * Classify a recovery action by who ended up owning the deliverable work.
 *
 * The plan's `handed_back` vs `owner_completed` outcomes were never added to the
 * outcome vocabulary (recovery track 1 kept `restored`/`cancelled`/…), so we
 * derive the distinction from the durable relationship between the recovery
 * owner, the original assignee (`returnOwnerAgentId`), and where the source
 * issue actually landed. This directly measures the product goal — "managers
 * doing the work becomes rare".
 */
export function classifyRecoveryHandoff(facts: RecoveryActionFacts): HandoffClass {
  if (ACTIVE_STATUSES.has(facts.status)) return "active";
  if (!facts.ownerAgentId) return "board_owned";
  // Original agent recovered its own issue — the ideal per-cause routing, not a takeover.
  if (facts.ownerAgentId === facts.returnOwnerAgentId) return "self_recovery";
  // Genuine takeover: recovery owner differs from the original assignee.
  const landedElsewhere =
    facts.finalAssigneeAgentId != null && facts.finalAssigneeAgentId !== facts.ownerAgentId;
  if (landedElsewhere) return "handed_back";
  const ownerKept = facts.finalAssigneeAgentId === facts.ownerAgentId;
  if (ownerKept && facts.finalIssueStatus && TERMINAL_ISSUE_STATUSES.has(facts.finalIssueStatus)) {
    return "owner_completed";
  }
  return "other";
}

/**
 * Pure alert evaluation over weekly rates. Kept independent of the database so
 * the 2%-crossing regression case can be tested with synthetic data.
 */
export function evaluateRecoveryRateAlert(
  weekly: WeeklyRecoveryRate[],
  thresholdPercent: number = DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
): RecoveryRateAlert {
  const breachedWeeks = weekly.filter((week) => week.ratePercent > thresholdPercent);
  const latestWeek = weekly.length > 0 ? weekly[weekly.length - 1]! : null;
  return {
    thresholdPercent,
    breached: breachedWeeks.length > 0,
    breachedWeeks,
    latestWeek,
    latestWeekBreached: latestWeek != null && latestWeek.ratePercent > thresholdPercent,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function utcWeekStart(now: Date, weeksAgo: number): Date {
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfWeek = new Date(utcMidnight).getUTCDay(); // 0 = Sunday
  const mondayOffset = (dayOfWeek + 6) % 7; // days since Monday
  const thisMonday = utcMidnight - mondayOffset * 24 * 60 * 60 * 1000;
  return new Date(thisMonday - weeksAgo * 7 * 24 * 60 * 60 * 1000);
}

export function recoveryObservabilityService(db: Db) {
  async function report(
    companyId: string,
    opts?: { now?: Date; weeks?: number; thresholdPercent?: number },
  ): Promise<RecoveryObservabilityReport> {
    const now = opts?.now ?? new Date();
    const weeks = Math.min(
      MAX_WINDOW_WEEKS,
      Math.max(1, Math.floor(opts?.weeks ?? DEFAULT_WINDOW_WEEKS)),
    );
    const thresholdPercent = opts?.thresholdPercent ?? DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT;
    const since = utcWeekStart(now, weeks - 1);
    const sinceIso = since.toISOString();

    // Weekly run volume (denominator) — normalizes the recovery rate per run.
    const runRows = (await db.execute(sql`
      SELECT
        to_char(date_trunc('week', ${heartbeatRuns.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
        count(*)::int AS runs
      FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.companyId} = ${companyId}
        AND ${heartbeatRuns.createdAt} >= ${sinceIso}::timestamptz
      GROUP BY week_start
    `)) as unknown as Iterable<{ week_start: string; runs: number | string }>;

    // Weekly recovery-action volume (numerator).
    const actionRows = (await db.execute(sql`
      SELECT
        to_char(date_trunc('week', ${issueRecoveryActions.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
        count(*)::int AS actions
      FROM ${issueRecoveryActions}
      WHERE ${issueRecoveryActions.companyId} = ${companyId}
        AND ${issueRecoveryActions.createdAt} >= ${sinceIso}::timestamptz
      GROUP BY week_start
    `)) as unknown as Iterable<{ week_start: string; actions: number | string }>;

    const runsByWeek = new Map<string, number>();
    for (const row of runRows) runsByWeek.set(String(row.week_start), Number(row.runs));
    const actionsByWeek = new Map<string, number>();
    for (const row of actionRows) actionsByWeek.set(String(row.week_start), Number(row.actions));

    const weekly: WeeklyRecoveryRate[] = Array.from({ length: weeks }, (_, index) => {
      const weekStart = utcWeekStart(now, weeks - 1 - index).toISOString().slice(0, 10);
      const runs = runsByWeek.get(weekStart) ?? 0;
      const recoveryActions = actionsByWeek.get(weekStart) ?? 0;
      return {
        weekStart,
        runs,
        recoveryActions,
        ratePercent: runs > 0 ? round2((recoveryActions / runs) * 100) : 0,
      };
    });

    const alert = evaluateRecoveryRateAlert(weekly, thresholdPercent);

    // Cause + latestRunErrorCode taxonomy (from the action's evidence snapshot).
    const causeRows = (await db.execute(sql`
      SELECT
        ${issueRecoveryActions.cause} AS cause,
        coalesce(${issueRecoveryActions.evidence} ->> 'latestRunErrorCode', '(none)') AS error_code,
        count(*)::int AS count,
        count(*) FILTER (WHERE ${issueRecoveryActions.status} IN ('active', 'escalated'))::int AS active_count,
        count(*) FILTER (WHERE ${issueRecoveryActions.status} = 'resolved')::int AS resolved_count,
        count(*) FILTER (WHERE ${issueRecoveryActions.status} = 'cancelled')::int AS cancelled_count
      FROM ${issueRecoveryActions}
      WHERE ${issueRecoveryActions.companyId} = ${companyId}
        AND ${issueRecoveryActions.createdAt} >= ${sinceIso}::timestamptz
      GROUP BY cause, error_code
      ORDER BY count DESC
    `)) as unknown as Iterable<{
      cause: string;
      error_code: string;
      count: number | string;
      active_count: number | string;
      resolved_count: number | string;
      cancelled_count: number | string;
    }>;

    const byCause: RecoveryCauseGroup[] = Array.from(causeRows).map((row) => ({
      cause: String(row.cause),
      latestRunErrorCode: String(row.error_code),
      count: Number(row.count),
      activeCount: Number(row.active_count),
      resolvedCount: Number(row.resolved_count),
      cancelledCount: Number(row.cancelled_count),
    }));

    // Hand-back accounting + per-cause routing. Recovery actions are inherently
    // low-volume (they are the exception path), so we join to the source issue
    // and classify each action in TS rather than encoding the derivation in SQL.
    const facts = await db
      .select({
        cause: issueRecoveryActions.cause,
        status: issueRecoveryActions.status,
        outcome: issueRecoveryActions.outcome,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
        finalAssigneeAgentId: issues.assigneeAgentId,
        finalIssueStatus: issues.status,
      })
      .from(issueRecoveryActions)
      .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          gte(issueRecoveryActions.createdAt, since),
        ),
      );

    const handoff: RecoveryHandoffSummary = {
      resolvedTakeovers: 0,
      handedBack: 0,
      ownerCompleted: 0,
      otherTakeover: 0,
      selfRecovery: 0,
      boardOwned: 0,
      activeTakeovers: 0,
      handedBackRatio: null,
      ownerCompletedRatio: null,
    };

    const routingByCause = new Map<string, RecoveryCauseRouting>();
    const routingFor = (cause: string): RecoveryCauseRouting => {
      let entry = routingByCause.get(cause);
      if (!entry) {
        entry = {
          cause,
          total: 0,
          active: 0,
          retriedByOriginalSucceeded: 0,
          handedBack: 0,
          ownerCompleted: 0,
          escalated: 0,
          falsePositive: 0,
          cancelled: 0,
        };
        routingByCause.set(cause, entry);
      }
      return entry;
    };

    for (const row of facts) {
      const klass = classifyRecoveryHandoff(row);
      const routing = routingFor(String(row.cause));
      routing.total += 1;

      if (klass === "active") {
        routing.active += 1;
        if (row.status === "escalated") routing.escalated += 1;
        if (row.ownerAgentId && row.ownerAgentId !== row.returnOwnerAgentId) {
          handoff.activeTakeovers += 1;
        }
        continue;
      }

      // Routing verification counters (resolved actions).
      if (row.status === "escalated") routing.escalated += 1;
      if (row.outcome === "false_positive") routing.falsePositive += 1;
      if (row.status === "cancelled" && row.outcome !== "false_positive") routing.cancelled += 1;

      switch (klass) {
        case "self_recovery":
          handoff.selfRecovery += 1;
          if (row.status === "resolved") routing.retriedByOriginalSucceeded += 1;
          break;
        case "handed_back":
          handoff.handedBack += 1;
          handoff.resolvedTakeovers += 1;
          routing.handedBack += 1;
          break;
        case "owner_completed":
          handoff.ownerCompleted += 1;
          handoff.resolvedTakeovers += 1;
          routing.ownerCompleted += 1;
          break;
        case "board_owned":
          handoff.boardOwned += 1;
          break;
        default:
          if (row.ownerAgentId && row.ownerAgentId !== row.returnOwnerAgentId) {
            handoff.otherTakeover += 1;
          }
          break;
      }
    }

    const decided = handoff.handedBack + handoff.ownerCompleted;
    if (decided > 0) {
      handoff.handedBackRatio = round2((handoff.handedBack / decided) * 100);
      handoff.ownerCompletedRatio = round2((handoff.ownerCompleted / decided) * 100);
    }

    const perCauseRouting = Array.from(routingByCause.values()).sort((a, b) => b.total - a.total);

    return {
      companyId,
      generatedAt: now.toISOString(),
      window: { weeks, since: sinceIso.slice(0, 10) },
      thresholdPercent,
      weekly,
      alert,
      byCause,
      handoff,
      perCauseRouting,
    };
  }

  return { report };
}
