import { successRate } from "./daily-snapshot.js";
import type {
  DailySnapshotTallyEntry,
  ExitCriteriaInput,
  ExitCriteriaThresholds,
  IsolationIncidentReport,
  LeaseLatencyAggregate,
  OperatorConfidenceComment,
  SecretLeakReport,
} from "./types.js";

export type ExitCriterionId =
  | "lease_success_rate"
  | "cold_start_p95"
  | "lease_ready_p95"
  | "isolation_incidents"
  | "secret_leaks"
  | "monthly_cost"
  | "vendor_uptime"
  | "operator_confidence";

export type ExitCriterionVerdict = "pass" | "fail" | "no_data";

export type ExitCriterionEvaluation = {
  id: ExitCriterionId;
  label: string;
  threshold: string;
  actual: string;
  verdict: ExitCriterionVerdict;
  detail?: string | null;
};

export type ExitCriteriaEvaluation = {
  perCriterion: ExitCriterionEvaluation[];
  overall: "pass" | "fail";
  /** Set when overall = "fail"; lists the criterion ids that failed. */
  failedIds: ExitCriterionId[];
};

const REQUIRED_OPERATOR_ROLES = ["Architect", "QA Validator", "Hermes Orchestrator"] as const;

/**
 * Evaluate every exit-criteria row against the thresholds. Pure function
 * over its inputs — the caller (LET-371) decides what to do with the
 * verdict (pass → ADR §7 issue, fail → revert + incident + ADR addendum).
 */
export function evaluateExitCriteria(input: ExitCriteriaInput): ExitCriteriaEvaluation {
  const t = input.thresholds;
  const tallyRate = successRate(input.windowLeaseTally);
  const perCriterion: ExitCriterionEvaluation[] = [];

  perCriterion.push({
    id: "lease_success_rate",
    label: "Lease success rate",
    threshold: `≥ ${formatRate(t.leaseSuccessRateMin)}`,
    actual: formatRate(tallyRate),
    verdict: tallyRate === null ? "no_data" : tallyRate >= t.leaseSuccessRateMin ? "pass" : "fail",
    detail: tallyAsText(input.windowLeaseTally),
  });

  perCriterion.push(thresholdMaxMs(
    "cold_start_p95",
    "p95 cold start",
    input.windowLeaseTally.coldStartP95Ms,
    t.coldStartP95MsMax,
  ));
  perCriterion.push(thresholdMaxMs(
    "lease_ready_p95",
    "End-to-end lease-ready latency p95",
    input.windowLeaseTally.leaseReadyP95Ms,
    t.leaseReadyP95MsMax,
  ));

  const isoCount = input.isolationIncidents.length;
  perCriterion.push({
    id: "isolation_incidents",
    label: "Isolation incidents",
    threshold: `≤ ${t.isolationIncidentsMax}`,
    actual: String(isoCount),
    verdict: isoCount <= t.isolationIncidentsMax ? "pass" : "fail",
  });

  const leakCount = input.secretLeaks.length;
  perCriterion.push({
    id: "secret_leaks",
    label: "Raw-secret leaks",
    threshold: `≤ ${t.secretLeaksMax}`,
    actual: String(leakCount),
    verdict: leakCount <= t.secretLeaksMax ? "pass" : "fail",
  });

  const monthCents = input.finalBilling.monthToDateCents;
  perCriterion.push({
    id: "monthly_cost",
    label: "Monthly cost",
    threshold: `≤ ${formatUsd(t.monthlyHardCapCents)} hard cap`,
    actual: formatUsd(monthCents),
    verdict: monthCents > t.monthlyHardCapCents || input.finalBilling.monthState === "hard_cap_disabled" ? "fail" : "pass",
    detail: `month state: ${input.finalBilling.monthState}`,
  });

  perCriterion.push({
    id: "vendor_uptime",
    label: "Vendor uptime",
    threshold: `≥ ${formatRate(t.vendorUptimeMin)}`,
    actual: formatRate(input.vendorUptimeRatio),
    verdict: input.vendorUptimeRatio === null ? "no_data" : input.vendorUptimeRatio >= t.vendorUptimeMin ? "pass" : "fail",
  });

  perCriterion.push(operatorConfidenceVerdict(input.operatorConfidenceComments));

  const failedIds = perCriterion
    .filter((row) => row.verdict === "fail" || row.verdict === "no_data")
    .map((row) => row.id);
  return {
    perCriterion,
    overall: failedIds.length === 0 ? "pass" : "fail",
    failedIds,
  };
}

/**
 * Pure renderer. Produces the Markdown body for the
 * `phase-4a-s4-pilot-exit-criteria-YYYY-MM-DD` issue document. The caller
 * (LET-371) takes this string and upserts it; this function never touches
 * the document store.
 */
export function renderExitCriteriaReport(input: ExitCriteriaInput): string {
  const evaluation = evaluateExitCriteria(input);
  const lines: string[] = [];

  lines.push(`# ${input.pilotId} — exit-criteria report`);
  lines.push("");
  lines.push(`> Truth label: \`${input.truthLabel}\` — ${truthLabelExplain(input.truthLabel)}`);
  lines.push(`> Pilot window: ${input.windowStartUtcDay} → ${input.windowEndUtcDay} (UTC, inclusive)`);
  lines.push("");

  if (input.earlyHalt) {
    lines.push("## ⛔ Early halt");
    lines.push("");
    lines.push(`- Triggered at: ${input.earlyHalt.triggeredAt}`);
    lines.push(`- Trigger: \`${input.earlyHalt.trigger}\``);
    lines.push(`- Summary: ${escapeCell(input.earlyHalt.summary)}`);
    if (input.earlyHalt.incidentLink) {
      lines.push(`- Incident link: ${input.earlyHalt.incidentLink}`);
    }
    lines.push("");
  }

  lines.push("## Exit criteria");
  lines.push("");
  lines.push("| Criterion | Threshold | Actual | Verdict | Notes |");
  lines.push("|---|---|---|---|---|");
  for (const row of evaluation.perCriterion) {
    lines.push(`| ${row.label} | ${row.threshold} | ${row.actual} | ${verdictBadge(row.verdict)} | ${escapeCell(row.detail ?? "")} |`);
  }
  lines.push("");

  lines.push("## Total cost vs cap");
  lines.push("");
  lines.push(`- Month-to-date spend at close: ${formatUsd(input.finalBilling.monthToDateCents)}`);
  lines.push(`- Monthly hard cap: ${formatUsd(input.finalBilling.monthlyHardCapCents)} (state: \`${input.finalBilling.monthState}\`)`);
  lines.push(`- Day-of-close spend: ${formatUsd(input.finalBilling.dayToDateCents)} of ${formatUsd(input.finalBilling.dailyHardCapCents)} (state: \`${input.finalBilling.dayState}\`)`);
  lines.push("");

  lines.push("## Vendor uptime");
  lines.push("");
  lines.push(`- Window uptime: ${formatRate(input.vendorUptimeRatio)} (threshold ≥ ${formatRate(input.thresholds.vendorUptimeMin)})`);
  lines.push("");

  lines.push("## Daily snapshot tally");
  lines.push("");
  if (input.dailyTally.length === 0) {
    lines.push("_No daily snapshots recorded._");
  } else {
    lines.push("| UTC day | Success rate | p95 cold start | Day spend | MTD spend | Iso. inc. | Leaks | Vendor uptime | Cap state |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const row of input.dailyTally) {
      lines.push(dailyTallyRow(row));
    }
  }
  lines.push("");

  lines.push("## Incident log");
  lines.push("");
  lines.push("### Isolation incidents");
  lines.push(incidentBlock(input.isolationIncidents));
  lines.push("");
  lines.push("### Raw-secret leaks");
  lines.push(leakBlock(input.secretLeaks));
  lines.push("");

  lines.push("## Operator-confidence comments");
  lines.push("");
  lines.push(operatorConfidenceBlock(input.operatorConfidenceComments));
  lines.push("");

  lines.push("## Recommendation");
  lines.push("");
  lines.push(recommendationBlock(evaluation, input));
  lines.push("");

  return lines.join("\n");
}

function thresholdMaxMs(
  id: ExitCriterionId,
  label: string,
  actual: number | null,
  max: number,
): ExitCriterionEvaluation {
  return {
    id,
    label,
    threshold: `≤ ${max} ms`,
    actual: actual === null ? "_no samples_" : `${actual} ms`,
    verdict: actual === null ? "no_data" : actual <= max ? "pass" : "fail",
  };
}

function operatorConfidenceVerdict(comments: ReadonlyArray<OperatorConfidenceComment>): ExitCriterionEvaluation {
  const byRole = new Map<string, OperatorConfidenceComment>();
  for (const comment of comments) {
    // Last comment per role wins — operators may amend their verdict.
    byRole.set(comment.role, comment);
  }
  const missing: string[] = [];
  const nonGo: string[] = [];
  for (const role of REQUIRED_OPERATOR_ROLES) {
    const comment = byRole.get(role);
    if (!comment) {
      missing.push(role);
      continue;
    }
    if (comment.verdict !== "go") {
      nonGo.push(`${role}=${comment.verdict}`);
    }
  }
  const detail = missing.length === 0 && nonGo.length === 0
    ? `${REQUIRED_OPERATOR_ROLES.length}/${REQUIRED_OPERATOR_ROLES.length} go`
    : `missing: [${missing.join(", ")}]; non-go: [${nonGo.join(", ")}]`;
  return {
    id: "operator_confidence",
    label: "Operator confidence",
    threshold: `${REQUIRED_OPERATOR_ROLES.join(" + ")} each post a written "go"`,
    actual: detail,
    verdict: missing.length === 0 && nonGo.length === 0 ? "pass" : "fail",
  };
}

function recommendationBlock(evaluation: ExitCriteriaEvaluation, input: ExitCriteriaInput): string {
  if (evaluation.overall === "pass" && !input.earlyHalt) {
    return [
      "✅ **PASS — graduate to Phase 4B.**",
      "",
      "- Open a new ADR §7 gate issue for the Phase 4B rollout.",
      "- Carry the lease-success-rate, cold-start p95, lease-ready p95, monthly spend, and vendor uptime numbers above into the gate issue as the prior-phase evidence.",
      "- Keep the kill-switch, billing cap, isolation guard, and secret-egress guard layers armed through the rollout.",
    ].join("\n");
  }
  const failedList = evaluation.failedIds.length === 0
    ? "_early halt (no per-criterion failure)_"
    : evaluation.failedIds.map((id) => `\`${id}\``).join(", ");
  return [
    "🛑 **FAIL — revert and escalate.**",
    "",
    `- Failed criteria: ${failedList}`,
    "- Flip `SANDBOX_PROVIDER_ALLOW_LIVE` back to `false` for the pilot agent role.",
    "- Write a Phase 4A-S4 incident on LET-365 referencing this report.",
    "- Append an ADR addendum capturing the failure mode and next-step decision (extend pilot vs. abandon E2B vs. switch provider).",
  ].join("\n");
}

function dailyTallyRow(row: DailySnapshotTallyEntry): string {
  return [
    `| ${row.utcDay}`,
    formatRate(row.leaseSuccessRate),
    row.coldStartP95Ms === null ? "_no samples_" : `${row.coldStartP95Ms} ms`,
    formatUsd(row.daySpendCents),
    formatUsd(row.monthToDateCents),
    String(row.isolationIncidents),
    String(row.secretLeaks),
    formatRate(row.vendorUptimeRatio),
    `\`${row.capState}\` |`,
  ].join(" | ");
}

function incidentBlock(incidents: ReadonlyArray<IsolationIncidentReport>): string {
  if (incidents.length === 0) return "_None — green log._";
  return incidents.map((incident) => {
    const link = incident.link ? ` ([link](${incident.link}))` : "";
    return `- \`${incident.id}\` (${incident.detectedAt}) — ${escapeCell(truncate(incident.summary, 240))}${link}`;
  }).join("\n");
}

function leakBlock(leaks: ReadonlyArray<SecretLeakReport>): string {
  if (leaks.length === 0) return "_None — green log._";
  return leaks.map((leak) => {
    const link = leak.link ? ` ([link](${leak.link}))` : "";
    return `- \`${leak.id}\` (${leak.detectedAt}) — ${escapeCell(truncate(leak.summary, 240))}${link}`;
  }).join("\n");
}

function operatorConfidenceBlock(comments: ReadonlyArray<OperatorConfidenceComment>): string {
  if (comments.length === 0) return "_No operator-confidence comments recorded._";
  const rows = comments.map((c) => {
    const excerpt = c.excerpt ? ` — ${escapeCell(truncate(c.excerpt, 240))}` : "";
    return `- **${c.role}** (${c.operator}) — \`${c.verdict}\` at ${c.postedAt} (comment \`${c.commentId}\`)${excerpt}`;
  });
  return rows.join("\n");
}

function verdictBadge(verdict: ExitCriterionVerdict): string {
  switch (verdict) {
    case "pass":
      return "✅ pass";
    case "fail":
      return "🛑 fail";
    case "no_data":
      return "⚠️ no data";
  }
}

function tallyAsText(tally: LeaseLatencyAggregate): string {
  return `${tally.successCount} success / ${tally.failureCount} failure`;
}

function truthLabelExplain(label: "preview" | "live"): string {
  return label === "live"
    ? "live pilot data — G2 has fired."
    : "preview / stub data — G2 has NOT fired yet.";
}

function formatRate(rate: number | null): string {
  if (rate === null) return "_no samples_";
  return `${(rate * 100).toFixed(2)}%`;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export type { ExitCriteriaThresholds };
