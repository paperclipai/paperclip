import assert from "node:assert/strict";
import test from "node:test";
import { campaignAnalytics, compareCampaignAnalytics, enrichProtocolEvalHistory, sumAttemptCosts } from "./runner-protocol-eval-metrics.mjs";
import { costLabel, renderProtocolEvalHistoryIndex } from "./runner-protocol-eval-history-view.mjs";
import { emptyProtocolEvalHistory, mergeProtocolEvalHistory, protocolEvalHistoryRecord } from "./publish-runner-protocol-eval-history.mjs";

function campaign(id, failed = [], overrides = {}) {
  const results = ["context", "create", "finish"].map((caseId) => ({
    cellId: `codex--${caseId}`, caseId, rosterId: "codex", model: "mini", provider: "codex", driver: "codex_app_server",
    passed: !failed.includes(caseId), disposition: failed.includes(caseId) ? "behavior_failure" : "passed",
    usage: { estimatedCostNanodollars: 1_000_000, providerReportedCostNanodollars: 2_000_000 },
  }));
  return {
    campaignId: `gha-${id}-1`, generatedAt: `2026-09-${String(id).padStart(2, "0")}T00:00:00.000Z`,
    source: { paperclip: { sha: "a".repeat(40), ref: "refs/heads/master" }, evals: { sha: "b".repeat(40) }, workflowRunUrl: `https://github.com/paperclipai/paperclip/actions/runs/${id}` },
    complete: true, allPassed: failed.length === 0, results,
    selection: { kind: "maintained_full" },
    totals: { selected: 3, passed: 3 - failed.length, behaviorFailures: failed.length, infrastructureFailures: 0 },
    rosters: [{ rosterId: "codex", model: "mini", driver: "codex_app_server", selected: 3, passed: 3 - failed.length }],
    ...overrides,
  };
}

test("costs include retries without adding provider list cost to estimates or inventing missing usage", () => {
  const costs = sumAttemptCosts([{ estimatedCostNanodollars: 2, providerReportedCostNanodollars: 7 }, { estimatedCostNanodollars: 3 }, {}, { estimatedCostNanodollars: -1 }, { estimatedCostNanodollars: Infinity }]);
  assert.equal(costs.scope, "all_attempts");
  assert.deepEqual(costs.estimated, { nanodollars: 5, recordedAttempts: 2 });
  assert.deepEqual(costs.providerReported, { nanodollars: 7, recordedAttempts: 1 });
  assert.equal(costs.attempts, 5);
  assert.match(costLabel(costs), /^≥ /);
  assert.equal(costLabel(sumAttemptCosts([{}, {}])), "Unknown");
  assert.equal(costLabel(sumAttemptCosts([{ estimatedCostNanodollars: 0 }])), "$0.000000");
});

test("regressions and recoveries compare exact suite membership and evals SHA, not count alone", () => {
  const before = campaignAnalytics(campaign(1, ["context"]));
  const after = campaignAnalytics(campaign(2, ["create"]));
  const change = compareCampaignAnalytics(after, before);
  assert.deepEqual(change.regressions.map((cell) => cell.caseId), ["create"]);
  assert.deepEqual(change.recoveries.map((cell) => cell.caseId), ["context"]);
  const differentSha = campaign(2, [], { source: { evals: { sha: "c".repeat(40) } } });
  assert.equal(compareCampaignAnalytics(campaignAnalytics(differentSha), before), null);
  const changedMembership = campaign(2);
  changedMembership.results[0].cellId = "codex--different-case";
  assert.equal(compareCampaignAnalytics(campaignAnalytics(changedMembership), before), null);
  const reordered = campaign(1, ["context"]);
  reordered.results.reverse();
  assert.equal(campaignAnalytics(reordered).suiteKey, before.suiteKey);
});

test("history analytics backfill without rewriting records and refreshes enrich original costs", async () => {
  const source = campaign(1);
  const record = protocolEvalHistoryRecord(source, "https://reports.example/runner-protocol-evals");
  let history = mergeProtocolEvalHistory(emptyProtocolEvalHistory(), record);
  history = await enrichProtocolEvalHistory(history, { currentCampaign: source, loadCampaign: () => assert.fail("current campaign already available") });
  assert.equal(history.analytics[source.campaignId].costs.scope, "final_attempts");
  const refresh = { ...source, campaignId: "gha-1-1-report-theme", reportRevision: { sourceCampaignId: source.campaignId, renderedAt: "2026-09-04T00:00:00.000Z" }, costs: sumAttemptCosts([...source.results.map((r) => r.usage), { estimatedCostNanodollars: 500_000 }]) };
  history = mergeProtocolEvalHistory(history, protocolEvalHistoryRecord(refresh, "https://reports.example/runner-protocol-evals"));
  history = await enrichProtocolEvalHistory(history, { currentCampaign: refresh, loadCampaign: () => assert.fail("refresh already available") });
  assert.equal(history.analytics[source.campaignId].costs.estimated.nanodollars, 3_500_000);
  assert.deepEqual(history.campaigns.find((run) => run.campaignId === source.campaignId), record);
  assert.equal(history.latestCampaignId, source.campaignId);
  await assert.rejects(enrichProtocolEvalHistory(history, { currentCampaign: { ...refresh, totals: { ...source.totals, passed: 0 } }, loadCampaign: () => null }), /do not match/);
});

test("history graphs exclude refreshes, link exact SHAs and Actions, and open the latest presentation", async () => {
  const first = campaign(1, ["context"]);
  const second = campaign(2, ["create"]);
  const refresh = { ...second, campaignId: "gha-2-1-report-theme", reportRevision: { sourceCampaignId: second.campaignId, renderedAt: "2026-09-04T00:00:00.000Z" } };
  let history = emptyProtocolEvalHistory();
  for (const item of [first, second, refresh]) history = mergeProtocolEvalHistory(history, protocolEvalHistoryRecord(item, "https://reports.example/runner-protocol-evals"));
  history = await enrichProtocolEvalHistory(history, { currentCampaign: refresh, loadCampaign: (id) => id === first.campaignId ? first : second });
  const html = renderProtocolEvalHistoryIndex(history, "campaigns/gha-2-1-report-theme/viewer/assets/index.css");
  assert.match(html, /All runs · 2/);
  assert.match(html, /2 recorded runs/);
  assert.match(html, /1 regressions · 1 recoveries/);
  assert.match(html, /Full maintained suite/);
  assert.ok(html.includes(`https://github.com/paperclipai/paperclip/commit/${"a".repeat(40)}`));
  assert.ok(html.includes(`https://github.com/paperclipai/paperclip-evals/commit/${"b".repeat(40)}`));
  assert.match(html, /actions\/runs\/2/);
  assert.match(html, /href="https:\/\/reports.example\/runner-protocol-evals\/campaigns\/gha-2-1-report-theme\/">Latest · gha-2-1/);
  assert.doesNotMatch(html, /<script|NaN|Infinity/);
});
