import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import type { IssueComment } from "../../../packages/shared/src/types/issue.js";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { CostDataQualityReport, CostByProject, CostEvent, IssueCostSummary, CostByAgentModel } from "../../../packages/shared/src/types/cost.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage } from "../chat-flow.js";
import { pollUntil } from "../api.js";
import { checks, entity, hasLink, project, task, sameTask, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, openStandingChat, probeAgentPermission } from "./identity-support.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface NativeAccountingState { worker: Entity; project: Entity; preflightTask: Entity; originalRun: HeartbeatRun; originalRunId: string; originalUsageHash: string; originalLogHash: string | null; unresolvedBefore: CostDataQualityReport }
/** Public UI retry eligibility is narrower than unresolved event valuation.
 * Unknown billing on an acknowledged receipt is real debt, but not a pending
 * saved-run retry (CostDataQualityNotice only renders that action for retryable).
 */
export function nativeAccountingPrerequisite(run: Pick<HeartbeatRun, "id" | "status" | "usageJson">, quality: CostDataQualityReport, retryable: boolean) {
  const rows = [...quality.runs, ...quality.events].filter(row => row.runId === run.id);
  const savedUsage = run.usageJson != null && Object.keys(run.usageJson).length > 0;
  const retryControlAvailable = quality.canRetry
    && quality.runs.some(row => row.runId === run.id && row.reason === "retryable");
  const eligible = run.status === "succeeded" && savedUsage && (retryable ? retryControlAvailable : rows.length > 0);
  const disposition = eligible ? "eligible" : !savedUsage ? "missing-saved-usage" : !rows.length ? "settled-accounting"
    : "unresolved-without-saved-run-retry";
  return { eligible, disposition, savedUsage, retryControlAvailable, unresolvedReasons: rows.map(row => row.reason) };
}
async function nativeUnresolvedContext(ctx: ChatCatalogContext, retryable: boolean): Promise<NativeAccountingState> {
  await openStandingChat(ctx); const worker = await identityWorker(ctx); const p = await project(ctx, "Launch");
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  // Before any setup provider work, use real board policy controls. This is
  // preparation for the genuine native prerequisite run, never a cost receipt.
  for (const [scopeType, scopeId] of [["company", ctx.input.fixtures.company.id], ["agent", worker.id]]) await ctx.input.api.post(`${root}/budgets/policies`, { scopeType, scopeId, amount: 10000, unpricedUsagePolicy: "allow", windowKind: "calendar_month_utc" });
  await pollUntil({ label: "real accounting preflight worker ready", deadlineAt: Date.now() + 45_000, load: () => ctx.input.api.get<{ lifecycleState: string }>(`/api/agents/${worker.id}`), accept: row => row.lifecycleState === "ready" });
  const preflightTask = await task(ctx, "Native accounting prerequisite", p.id, { assigneeAgentId: worker.id, status: "todo",
    description: "Return a concise readiness acknowledgement, then close this accounting preflight task. Do not create files, delegate, or start other tasks. This is a real native-provider prerequisite execution, not a simulated receipt." });
  const run = await pollUntil({ label: "genuine completed native accounting prerequisite", deadlineAt: Date.now() + 180_000,
    load: () => ctx.allRuns(), accept: rows => rows.some(row => row.agentId === worker.id && row.status === "succeeded" && row.runtimeMode === "native") }).then(rows => rows.find(row => row.agentId === worker.id && row.status === "succeeded" && row.runtimeMode === "native")!);
  const original = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${run.id}`);
  const quality = await ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`);
  const prerequisite = nativeAccountingPrerequisite(original, quality, retryable);
  await ctx.input.evidence("identity-native-accounting-context.json", { runId: run.id, taskId: preflightTask.id, workerId: worker.id, nativeRunActuallyCompleted: true,
    usageEvidenceExists: prerequisite.savedUsage, actualUnresolvedReasons: prerequisite.unresolvedReasons, requiresRetryableSavedUsage: retryable,
    prerequisiteDisposition: prerequisite.disposition, actualRetryControlAvailable: prerequisite.retryControlAvailable, prerequisiteMet: prerequisite.eligible, usageAccountingFabricated: false, setupNativeUsageMustCountInCampaignAccounting: true });
  if (!prerequisite.eligible) throw new Error(`Setup blocker: actual completed native accounting prerequisite is ${prerequisite.disposition}; unresolved reasons=${prerequisite.unresolvedReasons.join(",") || "none"}. Saved retry debt cannot be fabricated`);
  return { worker, project: p, preflightTask: await ctx.input.api.get<Entity>(`/api/issues/${preflightTask.id}`), originalRun: original, originalRunId: run.id, originalUsageHash: digest(original.usageJson), originalLogHash: original.logSha256, unresolvedBefore: quality };
}
export function gradeAccounting(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-native-accounting-evidence", !!o, "Actual completed native usage, public accounting projections and persisted independent readback are required."); if (!o) return c.result();
  const before = o.state.originalRun as HeartbeatRun | undefined; const after = o.state.afterOriginalRun as HeartbeatRun | undefined;
  const quality = o.state.unresolvedBefore as CostDataQualityReport | undefined;
  c.add("genuine-unresolved-native-context", !!before && before.id === o.state.originalRunId && before.status === "succeeded" && o.runs.some(run => run.id === before.id && run.runtimeMode === "native") && before.usageJson != null
    && Object.keys(before.usageJson).length > 0 && !!quality && [...quality.runs, ...quality.events].some(row => row.runId === before.id),
    "The frozen missing-accounting prerequisite comes from a real completed native run and actual saved usage/quality records, never a patched run or fabricated null receipt.");
  c.add("original-work-never-rerun", after?.id === before?.id && after?.status === "succeeded" && o.state.originalUsagePreserved === true && o.state.originalLogPreserved === true
    && o.runs.filter(run => run.agentId === entity(o.state, "worker").id).length === 1 && o.state.originalTaskPreserved === true,
    "The actual prior worker run, provider usage and immutable log evidence remain, and no second worker execution or work mutation appears.");
  if (o.scenarioId === "budgets-costs.spend-breakdown") {
    const totals = o.state.issueCosts as IssueCostSummary[] | undefined; const projects = o.state.projectCosts as CostByProject[] | undefined;
    c.add("independent-scoped-week-ledger", o.state.receiptOrigin === "public-imported-synthetic-fixture" && totals?.length === 2 && totals[0]?.costCents === 137 && totals[1]?.costCents === 263
      && projects?.find(row => row.projectId === entity(o.state, "project").id)?.costCents === 400 && typeof o.state.weekFrom === "string" && typeof o.state.weekTo === "string",
      "Two explicitly imported synthetic USD API receipts total $4 in Launch's declared week, independently excluding the other-project and prior-week distractors; these are not live campaign/provider charges.");
    c.add("actual-agent-breakdown-and-incomplete-total", /Morgan[\s\S]{0,120}(?:\$|USD\s*)?1\.37/i.test(o.reply) && /Riley[\s\S]{0,120}(?:\$|USD\s*)?2\.63/i.test(o.reply)
      && /(?:\$|USD\s*)4\.00/.test(o.reply) && /week/i.test(o.reply) && /API|metered/i.test(o.reply) && /subscription|monthly fee/i.test(o.reply)
      && /incomplete|unresolved|pending|not.*(?:complete|final)|missing.*cost/i.test(o.reply) && !/\b(?:unresolved|pending|missing)\b[^.\n]{0,50}\b(?:free|no charge|zero cost)\b/i.test(o.reply)
      && hasLink(o, "issues", entity(o.state, "morganReceiptTask")) && hasLink(o, "issues", entity(o.state, "rileyReceiptTask")),
      "The actual answer breaks down the recorded scoped API dollars by real agent with supporting records, keeps subscription fees separate and labels unresolved usage instead of counting it free.");
  } else if (o.scenarioId === "budgets-costs.repair-cost-recording") {
    c.add("real-human-saved-cost-retry", quality?.runs.some(row => row.runId === before?.id && row.reason === "retryable") === true && o.state.agentRetryStatus === 403
      && o.state.humanRetryHttpStatus === 200 && typeof o.state.retryAccounted === "boolean" && o.state.retryReceiptVisible === true
      && o.activity.filter(row => row.action === "accounting.retry_requested" && row.entityId === before?.id && row.actorType === "user").length === 1,
      "The authorized person clicks the actual saved-cost retry control for exactly that genuine retryable run; the agent cannot impersonate board accounting authority.");
    const ledger = o.state.retryLedger as CostByAgentModel[] | undefined;
    const afterQuality = o.state.retryQuality as CostDataQualityReport | undefined;
    const actualUnresolved = !!afterQuality && ([...afterQuality.runs, ...afterQuality.events].some(row => row.runId === before?.id) || ledger?.some(row => row.estimatedEventCount > 0) === true);
    const actualRecorded = !!afterQuality && !actualUnresolved && o.state.retryAccounted === true && !!ledger?.length && ledger.every(row => row.agentId === entity(o.state, "worker").id && row.eventCount > 0 && row.estimatedEventCount === 0);
    c.add("independent-post-retry-ledger-classification", !!afterQuality && Array.isArray(ledger) && o.state.afterStillUnresolved === actualUnresolved && o.state.confirmedPricedRepair === actualRecorded && (actualUnresolved || actualRecorded),
      "Actual saved quality records and the sole original worker's ledger, not HTTP success or fixture booleans alone, classify the human retry result.");
    const finalReply = typeof o.state.finalReply === "string" ? o.state.finalReply : "";
    const initialReply = typeof o.state.initialReply === "string" ? o.state.initialReply : "";
    const finalRun = o.runs.find(run => run.id === o.state.finalReplyRunId);
    c.add("actual-post-retry-human-and-native-reply", typeof o.state.retryHumanFollowup === "string" && o.humanQueries.includes(o.state.retryHumanFollowup)
      && !!finalRun && finalRun.agentId === o.leadId && finalRun.status === "succeeded" && finalRun.runtimeMode === "native" && !!finalReply.trim(),
      "The actual human reports the real retry receipt and independently read accounting outcome, followed by a distinct persisted native chat reply.");
    const recordedClaim = /(?:cost|charge|usage|accounting)[^.\n]{0,65}(?:recorded|repaired|resolved|recovered)|(?:recorded|repaired|resolved|recovered)[^.\n]{0,65}(?:cost|charge|usage|accounting)/i;
    const unresolvedClaim = /(?:still|remains?|not yet|not fully)[^.\n]{0,65}(?:unresolved|pending|estimated|incomplete|unconfirmed)|(?:unresolved|pending|estimated|incomplete|unconfirmed)[^.\n]{0,65}(?:still|remains?)/i;
    c.add("honest-post-retry-accounting-result", o.state.confirmedPricedRepair === true
      ? recordedClaim.test(finalReply) && !unresolvedClaim.test(finalReply) && !/\b(?:not|never|wasn.t|isn.t)\s+(?:actually\s+)?(?:recorded|repaired|resolved)/i.test(finalReply)
      : o.state.afterStillUnresolved === true && unresolvedClaim.test(finalReply) && !/\b(?:now|fully|successfully)\s+(?:recorded|repaired|resolved|recovered)|\b(?:fixed|repaired|resolved)\s+(?:the|that|its|your)\s+(?:missing\s+)?(?:cost|charge|usage|accounting)/i.test(finalReply),
      "The post-action reply distinguishes independently confirmed recorded charges from still-unresolved/estimated accounting; the initial guidance cannot predict the human result.");
    c.add("guides-accounting-without-rerun", /cost|accounting|usage/i.test(initialReply) && /retry|record/i.test(initialReply) && /saved|existing|without.*run|not.*rerun|no.*rerun/i.test(initialReply)
      && !/\bI(?:'ve| have)?\s+(?:fixed|repaired|recorded|rerun|restarted)\b/i.test(initialReply)
      && !/\bI(?:'ve| have)?\s+(?:rerun|restarted)\b/i.test(finalReply), "Initial guidance uses the saved-usage control; neither phase claims a new execution of the original work.");
  } else c.add("known-accounting-case", false, "No accounting oracle exists for this case.");
  return c.result();
}
const sources = ["chat-catalog-domains/identity-accounting.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/budgets-costs.yaml"];
async function verifyUnresolvedSetup(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const quality = await ctx.input.api.get<CostDataQualityReport>(`/api/companies/${ctx.input.fixtures.company.id}/costs/data-quality?period=all`);
  const c = checks(); const rows = [...quality.runs, ...quality.events].filter(row => row.runId === state.originalRunId);
  c.add("genuine-unresolved-saved-native-usage", rows.some(row => ctx.scenario.id.endsWith("spend-breakdown") || row.reason === "retryable"),
    "Immediately before the canonical query, real native saved-usage accounting is still unresolved in the public projection; an automatic repair makes this a setup blocker instead of a fabricated context.");
  if (c.result().passed) state.unresolvedBefore = quality; return c.result();
}
async function observeAccounting(ctx: ChatCatalogContext, state: Record<string, unknown>) {
  const run = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.originalRunId}`); state.afterOriginalRun = run;
  state.originalUsagePreserved = digest(run.usageJson) === state.originalUsageHash; state.originalLogPreserved = run.logSha256 === state.originalLogHash;
  const task = await ctx.input.api.get<Entity>(`/api/issues/${entity(state, "preflightTask").id}`); state.originalTaskPreserved = sameTask(entity(state, "preflightTask"), task);
  if (ctx.scenario.id.endsWith("spend-breakdown")) {
    state.issueCosts = await Promise.all(["morganReceiptTask", "rileyReceiptTask"].map(key => ctx.input.api.get<IssueCostSummary>(`/api/issues/${entity(state, key).id}/cost-summary`)));
    state.projectCosts = await ctx.input.api.get<CostByProject[]>(`/api/companies/${ctx.input.fixtures.company.id}/costs/by-project?from=${encodeURIComponent(String(state.weekFrom))}&to=${encodeURIComponent(String(state.weekTo))}`);
  }
  if (ctx.scenario.id.endsWith("repair-cost-recording") && state.finalReplyRunId) {
    const comments = await ctx.input.api.get<IssueComment[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    state.finalReply = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === state.finalReplyRunId).map(row => row.body ?? "").join("\n");
  }
  return observeIdentity(ctx, state);
}
async function verifyAccountingLink(ctx: ChatCatalogContext, state: Record<string, unknown>, value: unknown) {
  const o = identityObservation(value); const source = ctx.input.page.url();
  const href = o?.links.find(link => { const url = new URL(link, ctx.input.api.baseURL); return url.origin === ctx.input.api.baseURL
    && (ctx.scenario.id.endsWith("spend-breakdown")
      ? [entity(state, "morganReceiptTask"), entity(state, "rileyReceiptTask")].some(row => [row.id, row.identifier].some(id => id && url.pathname.includes(`/issues/${id}`)))
      : url.pathname.includes("/activity/costs") || url.pathname.includes(`/runs/${state.originalRunId}`)); });
  if (!href) throw new Error("Actual supporting cost/task/run link is required");
  await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
  if (ctx.scenario.id.endsWith("spend-breakdown")) await expect(ctx.input.page.getByText(/Launch imported (?:Morgan|Riley) API usage/, { exact: true }).first()).toBeVisible();
  else await expect(ctx.input.page.getByText(/Cost|Usage|Native accounting prerequisite/i).first()).toBeVisible();
  await ctx.input.evidence("identity-accounting-support-link.json", { originalRunId: state.originalRunId, actualBrowserTarget: ctx.input.page.url(), actualSupportingRecordVisible: true });
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
}
export const accountingIdentityCases: readonly ChatCatalogCase[] = [
  identityDefinition("budgets-costs.spend-breakdown", async ctx => {
    const state = await nativeUnresolvedContext(ctx, false); const riley = await identityWorker(ctx, "Riley");
    const date = new Date(); const week = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
    const weekFrom = week.toISOString(); const weekTo = new Date(week.getTime() + 7 * 86400000).toISOString();
    const morganReceiptTask = await task(ctx, "Launch imported Morgan API usage", state.project.id, { assigneeAgentId: state.worker.id });
    const rileyReceiptTask = await task(ctx, "Launch imported Riley API usage", state.project.id, { assigneeAgentId: riley.id }); const other = await project(ctx, "Other project");
    const distractor = await task(ctx, "Other project imported API usage", other.id, { assigneeAgentId: state.worker.id });
    const priorWeek = await task(ctx, "Prior week Launch imported API usage", state.project.id, { assigneeAgentId: state.worker.id });
    const root = `/api/companies/${ctx.input.fixtures.company.id}`; const receipts: string[] = [];
    for (const [work, agentId, cents, occurredAt] of [[morganReceiptTask, state.worker.id, 137, new Date().toISOString()], [rileyReceiptTask, riley.id, 263, new Date().toISOString()],
      [distractor, state.worker.id, 11, new Date().toISOString()], [priorWeek, state.worker.id, 13, new Date(week.getTime() - 86400000).toISOString()]] as const) {
      const receipt = await ctx.input.api.post<CostEvent>(`${root}/cost-events`, { agentId, issueId: work.id, projectId: work.projectId, provider: "synthetic-eval-import", biller: "synthetic-eval-import", model: "imported-fixture-api-usage",
        billingType: "metered_api", costStatus: "reported", costCents: cents, inputTokens: 0, outputTokens: 0, occurredAt, idempotencyKey: `identity-report:${ctx.input.nonce}:${receipts.length}` }); receipts.push(receipt.id);
    }
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The requested reporting week is ${weekFrom} through ${weekTo} (UTC). Launch contains imported synthetic metered-API receipt tasks ${morganReceiptTask.identifier} (Morgan) and ${rileyReceiptTask.identifier} (Riley), plus actual completed native run ${state.originalRunId} with unresolved saved usage. Imported fixture receipts are not live provider/campaign billing. Other-project and earlier-week charges must be excluded; native subscription usage/fees are separate.` });
    return { ...state, riley, morganReceiptTask, rileyReceiptTask, weekFrom, weekTo, importedReceiptIds: receipts, receiptOrigin: "public-imported-synthetic-fixture" };
  }, gradeAccounting, { authentication: "human-session", sourceFiles: sources, expectedRunCount: 2, attemptTimeoutMs: 600_000, observe: observeAccounting, verifyResult: verifyAccountingLink, verifySetup: verifyUnresolvedSetup,
    setupPolicy: { funding: "standard", readiness: "all-ready", invariantCheckIds: ["genuine-unresolved-saved-native-usage"] } }),
  identityDefinition("budgets-costs.repair-cost-recording", async ctx => {
    const state = await nativeUnresolvedContext(ctx, true);
    await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The completed native run requiring saved-cost recovery is ${state.originalRunId}, on task ${state.preflightTask.identifier}. Its public accounting quality record is actually retryable and retains saved usage. Only the person may use cost-recording retry; do not start or rerun the task.` });
    return { ...state };
  }, gradeAccounting, {
    authentication: "human-session", sourceFiles: sources, expectedRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 780_000, observe: observeAccounting, verifyResult: verifyAccountingLink, verifySetup: verifyUnresolvedSetup,
    setupPolicy: { funding: "standard", readiness: "all-ready", invariantCheckIds: ["genuine-unresolved-saved-native-usage"] },
    async act(ctx, state) {
      await pollUntil({ label: "accounting guidance source settled", deadlineAt: Date.now() + 150_000, load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: rows => rows.length === 2 && rows.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      const initialComments = await ctx.input.api.get<IssueComment[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
      state.initialReply = initialComments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.body ?? "").join("\n");
      const previousRunIds = new Set((await ctx.allRuns()).map(run => run.id));
      const root = `/api/companies/${ctx.input.fixtures.company.id}`; state.agentRetryStatus = await probeAgentPermission(ctx, `${root}/costs/retry-accounting`, "POST", { runId: state.originalRunId });
      const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/activity/costs?period=all`, { waitUntil: "domcontentloaded" });
      await ctx.input.page.getByRole("button", { name: /run costs? unavailable|billing types? unknown/i }).first().click();
      const row = ctx.input.page.getByRole("listitem").filter({ has: ctx.input.page.locator(`a[href*="/runs/${state.originalRunId}"]`) }).filter({ has: ctx.input.page.getByRole("button", { name: "Retry cost recording", exact: true }) }).last();
      const response = ctx.input.page.waitForResponse(result => result.request().method() === "POST" && new URL(result.url()).pathname === `${root}/costs/retry-accounting` && result.request().postDataJSON()?.runId === state.originalRunId);
      await row.getByRole("button", { name: "Retry cost recording", exact: true }).click(); const receipt = await response; state.humanRetryHttpStatus = receipt.status(); const result = await receipt.json() as { accounted: boolean }; state.retryAccounted = result.accounted;
      await expect(ctx.input.page.getByText(result.accounted ? "Costs recorded." : "No new cost data is available.", { exact: true })).toBeVisible(); state.retryReceiptVisible = true;
      await expect(ctx.input.page.getByText("The agent was not rerun.", { exact: true })).toBeVisible();
      const after = await ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`); state.retryQuality = after; state.afterStillUnresolved = [...after.runs, ...after.events].some(row => row.runId === state.originalRunId);
      const ledger = (await ctx.input.api.get<CostByAgentModel[]>(`${root}/costs/by-agent-model?period=all`)).filter(row => row.agentId === entity(state, "worker").id);
      state.retryLedger = ledger;
      state.confirmedPricedRepair = result.accounted === true && state.afterStillUnresolved === false && ledger.length > 0 && ledger.every(row => row.eventCount > 0 && row.estimatedEventCount === 0);
      state.afterStillUnresolved = state.afterStillUnresolved === true || ledger.some(row => row.estimatedEventCount > 0);
      if (!state.confirmedPricedRepair && !state.afterStillUnresolved) throw new Error("Retry returned no independently classifiable recorded or unresolved accounting outcome");
      await ctx.input.evidence("identity-saved-usage-retry.json", { runId: state.originalRunId, actualHumanHttpStatus: receipt.status(), accounted: result.accounted, confirmedPricedRepair: state.confirmedPricedRepair,
        afterStillUnresolved: state.afterStillUnresolved, originalRunNeverRerun: (await ctx.allRuns()).filter(run => run.agentId === entity(state, "worker").id).length === 1 });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      const followup = `I clicked Retry cost recording for run ${state.originalRunId}. The actual HTTP ${receipt.status()} receipt says accounted=${result.accounted}. Fresh saved accounting shows ${state.afterStillUnresolved ? "remaining unresolved or estimated accounting" : "no remaining unresolved accounting"}; recorded ledger: ${JSON.stringify(ledger.map(row => ({ billingType: row.billingType, costCents: row.costCents, eventCount: row.eventCount, estimatedEventCount: row.estimatedEventCount })))}. What does this actual result mean for the missing cost? Do not run the original task again.`;
      state.retryHumanFollowup = followup; await sendChatMessage(ctx.input.page, followup);
      const finalRuns = await pollUntil({ label: "actual post-retry native accounting explanation", deadlineAt: Date.now() + 150_000, load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: rows => rows.length === 3 && rows.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      const finalRun = finalRuns.find(run => !previousRunIds.has(run.id) && run.agentId === ctx.input.fixtures.agent.id && run.runtimeMode === "native");
      if (!finalRun) throw new Error("No distinct native response followed the factual human retry receipt"); state.finalReplyRunId = finalRun.id;
    },
  }),
];
