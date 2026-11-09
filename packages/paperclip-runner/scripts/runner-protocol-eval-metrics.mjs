import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

// Provider list cost and our pricing estimate are alternative measurements,
// never additive. Missing usage is unknown, not a zero-dollar call.
export function sumAttemptCosts(usages, scope = "all_attempts") {
  const metric = (field) => {
    const values = usages.map((usage) => usage?.[field]).filter((value) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0);
    return {
      nanodollars: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      recordedAttempts: values.length,
    };
  };
  return {
    scope,
    attempts: usages.length,
    estimated: metric("estimatedCostNanodollars"),
    providerReported: metric("providerReportedCostNanodollars"),
  };
}

export function campaignAnalytics(campaign) {
  const results = campaign.results ?? [];
  const cells = results.map((result) => [result.cellId, result.model, result.provider, result.driver]);
  cells.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const comparable = SHA.test(campaign.source?.evals?.sha ?? "")
    && cells.length > 0 && cells.length === campaign.totals?.selected
    && results.every((result) => typeof result.passed === "boolean")
    && results.filter((result) => result.passed).length === campaign.totals.passed
    && new Set(cells.map(([id]) => id)).size === cells.length
    && cells.every((cell) => cell.every((value) => typeof value === "string" && value.length > 0));
  const suiteKey = comparable ? createHash("sha256")
    .update(JSON.stringify([campaign.source.evals.sha, cells])).digest("hex") : null;
  const suppliedCosts = campaign.costs;
  const validCosts = suppliedCosts && ["all_attempts", "final_attempts"].includes(suppliedCosts.scope)
    && Number.isSafeInteger(suppliedCosts.attempts) && suppliedCosts.attempts >= 0
    && ["estimated", "providerReported"].every((field) => {
      const metric = suppliedCosts[field];
      return Number.isSafeInteger(metric?.recordedAttempts) && metric.recordedAttempts >= 0
        && metric.recordedAttempts <= suppliedCosts.attempts
        && (metric.nanodollars === null || typeof metric.nanodollars === "number" && Number.isFinite(metric.nanodollars) && metric.nanodollars >= 0);
    });
  return {
    schema: "paperclip.runner-protocol-eval.analytics/v1",
    suiteKey,
    selection: campaign.selection?.kind === "maintained_full" ? "maintained_full"
      : campaign.selection?.kind === "subset" ? "subset" : "recorded",
    costs: validCosts ? {
      scope: suppliedCosts.scope, attempts: suppliedCosts.attempts,
      estimated: { nanodollars: suppliedCosts.estimated.nanodollars, recordedAttempts: suppliedCosts.estimated.recordedAttempts },
      providerReported: { nanodollars: suppliedCosts.providerReported.nanodollars, recordedAttempts: suppliedCosts.providerReported.recordedAttempts },
    } : sumAttemptCosts(results.map((result) => result.usage), "final_attempts"),
    failedCells: results.filter((result) => !result.passed).map((result) => ({
      cellId: ID.test(result.cellId) ? result.cellId : "unknown",
      caseId: ID.test(result.caseId) ? result.caseId : "unknown",
      rosterId: ID.test(result.rosterId) ? result.rosterId : "unknown",
      disposition: result.disposition === "behavior_failure" ? "behavior_failure" : "infrastructure_failure",
    })),
  };
}

export function compareCampaignAnalytics(current, previous) {
  if (!current?.suiteKey || current.suiteKey !== previous?.suiteKey) return null;
  const before = new Set(previous.failedCells.map((cell) => cell.cellId));
  const after = new Set(current.failedCells.map((cell) => cell.cellId));
  return {
    regressions: current.failedCells.filter((cell) => !before.has(cell.cellId)),
    recoveries: previous.failedCells.filter((cell) => !after.has(cell.cellId)),
  };
}

// History records and campaign bundles stay immutable. This separate, derived
// projection can be backfilled from old bundles or enriched by a report refresh.
export async function enrichProtocolEvalHistory(history, { currentCampaign, loadCampaign }) {
  const analytics = { ...history.analytics };
  const sourceId = currentCampaign.reportRevision?.sourceCampaignId ?? currentCampaign.campaignId;
  for (const record of history.campaigns.filter((item) => !item.reportRevision)) {
    const refresh = record.campaignId === sourceId ? currentCampaign : null;
    if (!refresh && analytics[record.campaignId]?.schema === "paperclip.runner-protocol-eval.analytics/v1") continue;
    const campaign = refresh ?? await loadCampaign(record.campaignId);
    if (!campaign) continue;
    if (!isDeepStrictEqual(campaign.source, record.source)
      || !isDeepStrictEqual(campaign.totals, record.totals))
      throw new Error(`Campaign analytics do not match immutable history: ${record.campaignId}`);
    const projected = campaignAnalytics(campaign);
    const previous = analytics[record.campaignId];
    // Never downgrade an all-attempt measurement with a historical final-only one.
    if (previous?.costs?.scope === "all_attempts" && projected.costs.scope !== "all_attempts")
      projected.costs = previous.costs;
    analytics[record.campaignId] = projected;
  }
  return { ...history, analytics };
}
