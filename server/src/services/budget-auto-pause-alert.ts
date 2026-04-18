import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { labels } from "@paperclipai/db";
import type {
  BudgetAutoPauseDetails,
  BudgetEnforcementScope,
} from "./budgets.js";
import type { issueService } from "./issues.js";

type IssueService = ReturnType<typeof issueService>;

const ALERT_LABEL_NAME = "infra-alert";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatUtilization(observedCents: number, limitCents: number) {
  if (limitCents <= 0) return "n/a";
  const pct = (observedCents / limitCents) * 100;
  return `${pct.toFixed(1)}%`;
}

export function buildBudgetAutoPauseIssueHook(db: Db, issues: IssueService) {
  return async function onAutoPaused(
    scope: BudgetEnforcementScope,
    details: BudgetAutoPauseDetails,
  ) {
    const labelRow = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, scope.companyId), eq(labels.name, ALERT_LABEL_NAME)))
      .then((rows) => rows[0] ?? null);

    const title = `Budget auto-pause: ${scope.scopeType} "${details.scopeName}"`;
    const body = [
      `**Auto-pause triggered** — ${scope.scopeType} **${details.scopeName}** has been paused because its ${details.windowKind} budget was exceeded.`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Scope | \`${scope.scopeType}\` \`${scope.scopeId}\` |`,
      `| Pause reason | \`budget\` |`,
      `| Metric | \`${details.metric}\` |`,
      `| Window | \`${details.windowKind}\` |`,
      `| Budget limit | ${formatDollars(details.amountLimit)} |`,
      `| Observed spend | ${formatDollars(details.amountObserved)} |`,
      `| Utilization | ${formatUtilization(details.amountObserved, details.amountLimit)} |`,
      `| Incident | \`${details.incidentId}\` |`,
      `| Policy | \`${details.policyId}\` |`,
      "",
      "Resume by either raising the budget or resolving the incident via the budget approvals flow.",
    ].join("\n");

    await issues.create(scope.companyId, {
      title,
      description: body,
      priority: "critical",
      status: "todo",
      originKind: "manual",
      labelIds: labelRow ? [labelRow.id] : [],
    });
  };
}
