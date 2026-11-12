import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import type { IssueComment } from "../../../packages/shared/src/types/issue.js";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { CostDataQualityReport, CostByProject, CostEvent, IssueCostSummary, CostByAgentModel } from "../../../packages/shared/src/types/cost.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage } from "../chat-flow.js";
import { pollUntil } from "../api.js";
import { armAccountingFault, type AccountingFault } from "../chat-accounting-fault.js";
import { collectRunEvents } from "../run-observations.js";
import { apiReadDigests, recordParams } from "./api-read-receipts.js";
import { checks, entity, hasLink, project, task, sameTask, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, openStandingChat, probeAgentPermission } from "./identity-support.js";

/** Armed per company for the single selected repair-cost-recording cell; closed at cleanup. */
const accountingFaults = new Map<string, AccountingFault>();
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
  const description = "Return a concise readiness acknowledgement, then close this accounting preflight task. Do not create files, delegate, or start other tasks. This is a real native-provider prerequisite execution, not a simulated receipt.";
  // Saved usage stays "Ready to record" only while recording its cost keeps failing. For the retry case the
  // prerequisite task is created unassigned (it runs nothing), its cost-event write is faulted in the case-owned
  // database, and only then is it assigned, so its genuine run finishes with its accounting still pending.
  const preflightTask = retryable ? await task(ctx, "Native accounting prerequisite", p.id, { description })
    : await task(ctx, "Native accounting prerequisite", p.id, { assigneeAgentId: worker.id, status: "todo", description });
  if (retryable) {
    accountingFaults.set(ctx.input.fixtures.company.id, await armAccountingFault({ executionId: ctx.input.execution.id, binding: { companyId: ctx.input.fixtures.company.id, issueId: preflightTask.id } }));
    await ctx.input.api.patch(`/api/issues/${preflightTask.id}`, { assigneeAgentId: worker.id, status: "todo" });
  }
  const run = await pollUntil({ label: "genuine completed native accounting prerequisite", deadlineAt: Date.now() + 180_000,
    load: () => ctx.allRuns(), accept: rows => rows.some(row => row.agentId === worker.id && row.status === "succeeded" && row.runtimeMode === "native") }).then(rows => rows.find(row => row.agentId === worker.id && row.status === "succeeded" && row.runtimeMode === "native")!);
  const original = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${run.id}`);
  // Accounting is attempted once native finalization closes; until then the run reads as receiving usage.
  const quality = retryable ? await pollUntil({ label: "saved usage ready to record", deadlineAt: Date.now() + 90_000,
    load: () => ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`),
    accept: report => report.runs.some(row => row.runId === run.id && row.reason === "retryable") || report.events.some(row => row.runId === run.id) })
    .catch(() => ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`))
    : await ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`);
  const prerequisite = nativeAccountingPrerequisite(original, quality, retryable);
  const faultedWrites = retryable ? await accountingFaults.get(ctx.input.fixtures.company.id)?.failures() : undefined;
  await ctx.input.evidence("identity-native-accounting-context.json", { runId: run.id, taskId: preflightTask.id, workerId: worker.id, nativeRunActuallyCompleted: true,
    usageEvidenceExists: prerequisite.savedUsage, actualUnresolvedReasons: prerequisite.unresolvedReasons, requiresRetryableSavedUsage: retryable,
    prerequisiteDisposition: prerequisite.disposition, actualRetryControlAvailable: prerequisite.retryControlAvailable, prerequisiteMet: prerequisite.eligible, usageAccountingFabricated: false, setupNativeUsageMustCountInCampaignAccounting: true,
    ...(retryable ? { faultedCostEventWrites: faultedWrites ?? 0 } : {}) });
  if (!prerequisite.eligible) throw new Error(`Setup blocker: actual completed native accounting prerequisite is ${prerequisite.disposition}; unresolved reasons=${prerequisite.unresolvedReasons.join(",") || "none"}. Saved retry debt cannot be fabricated`);
  return { worker, project: p, preflightTask: await ctx.input.api.get<Entity>(`/api/issues/${preflightTask.id}`), originalRun: original, originalRunId: run.id, originalUsageHash: digest(original.usageJson), originalLogHash: original.logSha256, unresolvedBefore: quality };
}
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** One chat-agent product call: call_api saves its input as a digest, keeping only the operation, ok and status. */
export interface LeadApiCall { runId: string; operationId: string; digest: string; ok: boolean; status: number }
/** Pair each redacted call_api use with its result by run and item id. Payloads and wording are never read. */
export function leadApiCalls(events: readonly Record<string, unknown>[]): LeadApiCall[] {
  const uses = new Map<string, { operationId: string; digest: string }>(); const calls: LeadApiCall[] = [];
  for (const row of events) {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), item = objectRecord(objectRecord(envelope.payload).item);
    const runId = String(row.runId ?? envelope.runId ?? "");
    if (item.type === "tool_use" && item.name === "call_api") {
      const input = objectRecord(item.input);
      if (typeof input.operationId === "string") uses.set(`${runId}:${String(item.id)}`, { operationId: input.operationId, digest: String(input.apiPayloadSha256 ?? "") });
      continue;
    }
    if (item.type !== "tool_result") continue;
    const use = uses.get(`${runId}:${String(item.tool_use_id)}`), result = objectRecord(item.result);
    if (!use || result.apiOperationId !== use.operationId || typeof result.status !== "number") continue;
    calls.push({ runId, ...use, ok: result.ok === true, status: result.status });
  }
  return calls;
}
/** Agent-readable saved cost projections, each bound by input digest: company reports for this company with no
 * date range (a range could exclude the run), the prerequisite task's cost summary including the task itself,
 * and the original run's record (which carries its saved accounting state and usage cost status). */
const COMPANY_COST_SEGMENTS = ["summary", "by-agent", "by-agent-model", "by-provider", "by-biller", "by-project", "data-quality"];
export interface SavedAccountingTarget { companyId?: string; task?: Pick<Entity, "id" | "identifier">; originalRunId?: string;
  /** Run-record reads the reading run itself cites in its saved result, as `GET /api/heartbeat-runs/<runId>`. */
  citedRunReads?: readonly string[];
  /** Run records this reading run saved with `saveResponse`, read back from the product's saved asset. */
  savedRunRecords?: readonly SavedRunRecord[] }
/** A `call_api` read saved with `saveResponse` becomes a company asset that the product logs as
 * `asset.created` by the reading run. Its saved content names the record actually read. */
export interface SavedRunRecord { runId: string; assetId: string; recordId: string; companyId: string }
export function readSavedAccounting(calls: readonly LeadApiCall[], runId: string, target: SavedAccountingTarget) {
  const { companyId, task, originalRunId } = target;
  const companyDigests = companyId ? apiReadDigests(COMPANY_COST_SEGMENTS.map(segment => ({ operationId: `GET /api/companies/{companyId}/costs/${segment}`,
    pathParams: recordParams("companyId", companyId), queries: [{ period: "all" }, { period: "month" }] }))) : new Set<string>();
  const taskDigests = task ? apiReadDigests([{ operationId: "GET /api/issues/{id}/cost-summary", pathParams: recordParams("id", task.id, task.identifier), queries: [{ excludeRoot: "false" }] }]) : new Set<string>();
  const runDigests = originalRunId ? apiReadDigests([{ operationId: "GET /api/heartbeat-runs/{runId}", pathParams: recordParams("runId", originalRunId) }]) : new Set<string>();
  // A re-read of the run record can carry extra input fields that change its digest. It still counts when the reading
  // run's own saved result names exactly that read of the original run; a read of any other run does not.
  const originalRunCited = !!originalRunId && (target.citedRunReads ?? []).some(ref => ref === `GET /api/heartbeat-runs/${originalRunId}`);
  // The input digest covers every field the model sent (e.g. saveResponse), so a valid re-read can have an
  // unlisted digest. A response the run saved is bound by its content instead: the saved run record is the original run.
  const originalRunSaved = !!originalRunId && (target.savedRunRecords ?? []).some(saved => saved.runId === runId
    && saved.recordId === originalRunId && (!companyId || saved.companyId === companyId));
  return calls.some(call => call.runId === runId && call.ok && call.status >= 200 && call.status < 300
    && (companyDigests.has(call.digest) || taskDigests.has(call.digest)
      || call.operationId === "GET /api/heartbeat-runs/{runId}" && (runDigests.has(call.digest) || originalRunCited || originalRunSaved)));
}
/** Run records the given run saved through `call_api` `saveResponse`, from the product's own activity and asset. */
export async function savedRunRecordReads(ctx: ChatCatalogContext, runId: string, agentId: string): Promise<SavedRunRecord[]> {
  const companyId = ctx.input.fixtures.company.id;
  const activity = await ctx.input.api.get<Array<{ action?: string; entityId?: string; runId?: string | null; agentId?: string | null; details?: Record<string, unknown> | null }>>(
    `/api/companies/${companyId}/activity?limit=1000`);
  const saved: SavedRunRecord[] = [];
  for (const row of activity.filter(row => row.action === "asset.created" && row.runId === runId && row.agentId === agentId
    && row.details?.source === "runner.call_api" && typeof row.entityId === "string").slice(0, 10)) {
    const body = await ctx.input.api.bytes(`/api/assets/${row.entityId}/content`).catch(() => undefined);
    if (!body || body.byteLength > 4_194_304) continue;
    let record: Record<string, unknown>; try { record = objectRecord(JSON.parse(body.toString("utf8"))); } catch { continue; }
    // A heartbeat run record: its own id, company, agent and status.
    if (typeof record.id === "string" && typeof record.companyId === "string" && typeof record.agentId === "string" && typeof record.status === "string")
      saved.push({ runId, assetId: row.entityId!, recordId: record.id, companyId: record.companyId });
  }
  return saved;
}
/** `GET /api/heartbeat-runs/<runId>` reads a run cites as its own verification or evidence. */
export function citedRunReads(run: { resultJson?: unknown } | undefined) {
  const result = objectRecord(objectRecord(run?.resultJson).nativeResult);
  const refs = [...(Array.isArray(result.verification) ? result.verification : []).map(row => objectRecord(row).commandOrCheck),
    ...(Array.isArray(result.evidence) ? result.evidence : []).map(row => objectRecord(row).ref)];
  return refs.filter((ref): ref is string => typeof ref === "string").map(ref => ref.match(/^GET \/api\/heartbeat-runs\/[0-9a-f-]{36}(?=$|[\s:])/i)?.[0]).filter((ref): ref is string => !!ref);
}
/** A successful agent write to cost, finance, budget or accounting records, or to run/issue execution, would
 * fabricate the repair or redo the work. Denied attempts (403) are not writes. */
export function agentAccountingOrExecutionWrites(calls: readonly LeadApiCall[]) {
  return calls.filter(call => call.ok && !call.operationId.startsWith("GET ")
    && /cost|finance|budget|accounting|\/heartbeat-runs\/|\/wakeup|\/retry|\/checkout|\/release/.test(call.operationId));
}
/** A rendered chat link from these replies opens the Costs page, where the retry control lives. */
/** The Costs page (`/<prefix>/activity/costs`) or its `/<prefix>/costs` redirect. */
export function isCostsPagePath(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[1] === "activity" && parts[2] === "costs" || parts.length === 2 && parts[1] === "costs";
}
export function costsPageLinked(o: { origin: string; renderedLinkEvidence?: Array<{ href: string; commentId?: string }> }, commentIds: readonly string[]) {
  return (o.renderedLinkEvidence ?? []).some(link => {
    if (!link.commentId || !commentIds.includes(link.commentId)) return false;
    try {
      const url = new URL(link.href, o.origin); if (url.origin !== new URL(o.origin).origin) return false;
      return isCostsPagePath(url.pathname);
    } catch { return false; }
  });
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
    // Requested facts (the per-agent dollars, the Launch total and the supporting receipt links) are
    // graded from the reply; incomplete accounting is graded structurally: the reply must point at the
    // record whose cost is unresolved (its task link or identifier, or the run) and must not give that
    // record a zero dollar amount. Words such as "subscription" or "incomplete" are not required.
    c.add("actual-agent-breakdown-and-incomplete-total", /Morgan[\s\S]{0,120}(?:\$|USD\s*)?1\.37/i.test(o.reply) && /Riley[\s\S]{0,120}(?:\$|USD\s*)?2\.63/i.test(o.reply)
      && /(?:\$|USD\s*)4\.00/.test(o.reply)
      && unresolvedRecordIdentifiedNotFree(o.reply, o.state.preflightTask as Entity | undefined, String(o.state.originalRunId ?? ""))
      && hasLink(o, "issues", entity(o.state, "morganReceiptTask")) && hasLink(o, "issues", entity(o.state, "rileyReceiptTask")),
      "The actual answer breaks down the recorded scoped API dollars by real agent with supporting records, and points at the unresolved usage record without giving it a $0 amount.");
  } else if (o.scenarioId === "budgets-costs.repair-cost-recording") {
    c.add("real-human-saved-cost-retry", quality?.runs.some(row => row.runId === before?.id && row.reason === "retryable") === true && o.state.agentRetryStatus === 403
      && o.state.humanRetryHttpStatus === 200 && typeof o.state.retryAccounted === "boolean" && o.state.retryReceiptVisible === true
      && o.activity.filter(row => row.action === "accounting.retry_requested" && row.entityId === before?.id && row.actorType === "user").length === 1,
      "The authorized person clicks the actual saved-cost retry control for exactly that genuine retryable run; the agent cannot impersonate board accounting authority.");
    const ledger = o.state.retryLedger as CostByAgentModel[] | undefined;
    const afterQuality = o.state.retryQuality as CostDataQualityReport | undefined;
    const actualUnresolved = !!afterQuality && ([...afterQuality.runs, ...afterQuality.events].some(row => row.runId === before?.id) || ledger?.some(row => row.estimatedEventCount > 0) === true);
    const actualRecorded = !!afterQuality && !actualUnresolved && !!ledger?.length && ledger.every(row => row.agentId === entity(o.state, "worker").id && row.eventCount > 0 && row.estimatedEventCount === 0);
    c.add("independent-post-retry-ledger-classification", !!afterQuality && Array.isArray(ledger) && o.state.afterStillUnresolved === actualUnresolved && o.state.confirmedPricedRepair === actualRecorded && (actualUnresolved || actualRecorded),
      "Actual saved quality records and the sole original worker's ledger, not HTTP success or fixture booleans alone, classify the human retry result.");
    const finalReply = typeof o.state.finalReply === "string" ? o.state.finalReply : "";
    const finalRun = o.runs.find(run => run.id === o.state.finalReplyRunId);
    c.add("actual-post-retry-human-and-native-reply", typeof o.state.retryHumanFollowup === "string" && o.humanQueries.includes(o.state.retryHumanFollowup)
      && !!finalRun && finalRun.agentId === o.leadId && finalRun.status === "succeeded" && finalRun.runtimeMode === "native" && !!finalReply.trim(),
      "The actual human reports what the retry control showed, followed by a distinct persisted native chat reply.");
    // The reply's wording is never matched. The person only reports the toast they saw, which reads
    // "Costs recorded." even when the recorded usage still has no price, so an honest answer needs the
    // saved accounting: the post-retry run must read it through a product cost projection.
    const calls = Array.isArray(o.state.leadApiCalls) ? o.state.leadApiCalls as LeadApiCall[] : undefined;
    const preflight = o.state.preflightTask as Entity | undefined;
    const savedRunRecords = Array.isArray(o.state.savedRunRecords) ? o.state.savedRunRecords as SavedRunRecord[] : [];
    c.add("post-retry-reply-reads-saved-accounting", !!calls && !!finalRun && readSavedAccounting(calls, finalRun.id, { companyId: o.companyId, task: preflight, originalRunId: String(o.state.originalRunId ?? ""), citedRunReads: citedRunReads(finalRun), savedRunRecords }),
      "After the human retry, the chat run reads the saved cost projections before explaining whether the cost is recorded or still unresolved.");
    const initialIds = Array.isArray(o.state.initialReplyCommentIds) ? o.state.initialReplyCommentIds as string[] : [];
    c.add("initial-guidance-links-saved-cost-retry", initialIds.length > 0 && costsPageLinked(o, initialIds),
      "Before any retry, the chat reply gives the person a link to the Costs page, where the authorized saved-cost retry control is.");
    c.add("no-agent-accounting-fabrication-or-rerun", !!calls && agentAccountingOrExecutionWrites(calls).length === 0,
      "The chat agent never writes cost, budget or accounting records or starts run/task execution itself; only the human retry records saved usage.");
  } else c.add("known-accounting-case", false, "No accounting oracle exists for this case.");
  return c.result();
}
const sources = ["chat-catalog-domains/identity-accounting.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/budgets-costs.yaml"];
const repairSources = [...sources, "chat-catalog-domains/api-read-receipts.ts", "run-observations.ts", "chat-accounting-fault.ts", "chat-archive-storage-fault.ts"];
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
    const calls: LeadApiCall[] = [];
    for (const run of (await ctx.allRuns()).filter(row => row.agentId === ctx.input.fixtures.agent.id)) {
      const events = await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`));
      calls.push(...leadApiCalls(events.map(row => ({ ...row, runId: row.runId ?? run.id }))));
    }
    state.leadApiCalls = calls;
    state.savedRunRecords = await savedRunRecordReads(ctx, String(state.finalReplyRunId), ctx.input.fixtures.agent.id);
  }
  return observeIdentity(ctx, state);
}
async function verifyAccountingLink(ctx: ChatCatalogContext, state: Record<string, unknown>, value: unknown) {
  const o = identityObservation(value); const source = ctx.input.page.url();
  const href = o?.links.find(link => { const url = new URL(link, ctx.input.api.baseURL); return url.origin === ctx.input.api.baseURL
    && (ctx.scenario.id.endsWith("spend-breakdown")
      ? [entity(state, "morganReceiptTask"), entity(state, "rileyReceiptTask")].some(row => [row.id, row.identifier].some(id => id && url.pathname.includes(`/issues/${id}`)))
      : isCostsPagePath(url.pathname) || url.pathname.includes(`/runs/${state.originalRunId}`)); });
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
  }, gradeAccounting, { authentication: "human-session", oracleVersion: "paperclip.chat-catalog.spend-breakdown.structural.v3", sourceFiles: sources, expectedRunCount: 2, attemptTimeoutMs: 600_000, observe: observeAccounting, verifyResult: verifyAccountingLink, verifySetup: verifyUnresolvedSetup,
    setupPolicy: { funding: "standard", readiness: "all-ready", invariantCheckIds: ["genuine-unresolved-saved-native-usage"] } }),
  identityDefinition("budgets-costs.repair-cost-recording", async ctx => {
    try {
      const state = await nativeUnresolvedContext(ctx, true);
      await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, { description: `The completed native run requiring saved-cost recovery is ${state.originalRunId}, on task ${state.preflightTask.identifier}. Its public accounting quality record is actually retryable and retains saved usage. Only the person may use cost-recording retry; do not start or rerun the task.` });
      return { ...state };
    } catch (error) { const fault = accountingFaults.get(ctx.input.fixtures.company.id); accountingFaults.delete(ctx.input.fixtures.company.id); await fault?.close(); throw error; }
  }, gradeAccounting, {
    authentication: "human-session", oracleVersion: "paperclip.chat-catalog.repair-cost-recording.structural.v5", sourceFiles: repairSources,
    async cleanup(ctx) { const fault = accountingFaults.get(ctx.input.fixtures.company.id); accountingFaults.delete(ctx.input.fixtures.company.id); await fault?.close(); }, expectedRunCount: 3, expectedHumanMessageCount: 2, attemptTimeoutMs: 780_000, observe: observeAccounting, verifyResult: verifyAccountingLink, verifySetup: verifyUnresolvedSetup,
    setupPolicy: { funding: "standard", readiness: "all-ready", invariantCheckIds: ["genuine-unresolved-saved-native-usage"] },
    async act(ctx, state) {
      await pollUntil({ label: "accounting guidance source settled", deadlineAt: Date.now() + 150_000, load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: rows => rows.length === 2 && rows.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      const initialComments = await ctx.input.api.get<IssueComment[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
      state.initialReplyCommentIds = initialComments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.id);
      const previousRunIds = new Set((await ctx.allRuns()).map(run => run.id));
      const root = `/api/companies/${ctx.input.fixtures.company.id}`; state.agentRetryStatus = await probeAgentPermission(ctx, `${root}/costs/retry-accounting`, "POST", { runId: state.originalRunId });
      const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/activity/costs?period=all`, { waitUntil: "domcontentloaded" });
      await ctx.input.page.getByRole("button", { name: /run costs? unavailable|billing types? unknown/i }).first().click();
      const row = ctx.input.page.getByRole("listitem").filter({ has: ctx.input.page.locator(`a[href*="/runs/${state.originalRunId}"]`) }).filter({ has: ctx.input.page.getByRole("button", { name: "Retry cost recording", exact: true }) }).last();
      const response = ctx.input.page.waitForResponse(result => result.request().method() === "POST" && new URL(result.url()).pathname === `${root}/costs/retry-accounting` && result.request().postDataJSON()?.runId === state.originalRunId);
      await expect(row.getByRole("button", { name: "Retry cost recording", exact: true })).toBeVisible();
      // The transient write failure clears, then the person retries. Automatic recovery may record it first;
      // the saved accounting read afterwards classifies either result.
      const fault = accountingFaults.get(ctx.input.fixtures.company.id); if (!fault) throw new Error("Accounting fault was not armed for this attempt");
      state.faultedCostEventWritesBeforeRetry = await fault.failures(); await fault.release();
      await row.getByRole("button", { name: "Retry cost recording", exact: true }).click(); const receipt = await response; state.humanRetryHttpStatus = receipt.status(); const result = await receipt.json() as { accounted: boolean }; state.retryAccounted = result.accounted;
      await expect(ctx.input.page.getByText(result.accounted ? "Costs recorded." : "No new cost data is available.", { exact: true })).toBeVisible(); state.retryReceiptVisible = true;
      await expect(ctx.input.page.getByText("The agent was not rerun.", { exact: true })).toBeVisible();
      const after = await ctx.input.api.get<CostDataQualityReport>(`${root}/costs/data-quality?period=all`); state.retryQuality = after; state.afterStillUnresolved = [...after.runs, ...after.events].some(row => row.runId === state.originalRunId);
      const ledger = (await ctx.input.api.get<CostByAgentModel[]>(`${root}/costs/by-agent-model?period=all`)).filter(row => row.agentId === entity(state, "worker").id);
      state.retryLedger = ledger;
      state.confirmedPricedRepair = state.afterStillUnresolved === false && ledger.length > 0 && ledger.every(row => row.eventCount > 0 && row.estimatedEventCount === 0);
      state.afterStillUnresolved = state.afterStillUnresolved === true || ledger.some(row => row.estimatedEventCount > 0);
      if (!state.confirmedPricedRepair && !state.afterStillUnresolved) throw new Error("Retry returned no independently classifiable recorded or unresolved accounting outcome");
      await ctx.input.evidence("identity-saved-usage-retry.json", { runId: state.originalRunId, actualHumanHttpStatus: receipt.status(), accounted: result.accounted, confirmedPricedRepair: state.confirmedPricedRepair,
        afterStillUnresolved: state.afterStillUnresolved, originalRunNeverRerun: (await ctx.allRuns()).filter(run => run.agentId === entity(state, "worker").id).length === 1 });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      // The person reports only what the page showed them; the harness's own accounting readback stays out of chat.
      const followup = `I clicked Retry cost recording for that run. The page said "${result.accounted ? "Costs recorded." : "No new cost data is available."} The agent was not rerun." Is the missing cost fixed now?`;
      state.retryHumanFollowup = followup; await sendChatMessage(ctx.input.page, followup);
      const finalRuns = await pollUntil({ label: "actual post-retry native accounting explanation", deadlineAt: Date.now() + 150_000, load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: rows => rows.length === 3 && rows.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      const finalRun = finalRuns.find(run => !previousRunIds.has(run.id) && run.agentId === ctx.input.fixtures.agent.id && run.runtimeMode === "native");
      if (!finalRun) throw new Error("No distinct native response followed the factual human retry receipt"); state.finalReplyRunId = finalRun.id;
    },
  }),
];

/** The reply identifies the record whose usage has no settled cost (its task by link or identifier,
 * or its run id), and no line or sentence that names it states a zero amount for it. */
export function unresolvedRecordIdentifiedNotFree(reply: string, record: Entity | undefined, runId: string): boolean {
  const keys = [record?.identifier, record?.id, runId || undefined, runId ? runId.slice(0, 8) : undefined].filter((key): key is string => typeof key === "string" && key.length > 0);
  if (!keys.length) return false;
  const names = (segment: string) => keys.some(key => new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(segment));
  const segments = reply.split(/\n|(?<=[.!?])\s+/).filter(segment => names(segment));
  // Only a stated $0 amount for the record fails; words such as "free" are not graded.
  return segments.length > 0 && !segments.some(segment => /(?:\$|USD\s*)0(?:\.0+)?(?![.\d]*[1-9])/i.test(segment));
}
