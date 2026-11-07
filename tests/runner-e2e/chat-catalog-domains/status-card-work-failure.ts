import { createHash } from "node:crypto";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import type { ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
import type { StatusCard, StatusCardUpdate } from "../../../packages/shared/src/validators/status-card.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatRun } from "../chat-flow.js";
import { connectNotes, startNotesProvider, type NotesProvider, type ProviderCall, notesReadResponse } from "./external-provider.js";
import type { Entity } from "./internal-support.js";
import type { InstructionFile } from "./runtime-support.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v !== "unknown";
const millis = (v: unknown) => v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
const time = (v: unknown) => Number.isFinite(millis(v));
const natural = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
export interface CardRecipe { companyId: string; workerId: string; connectionId: string; readEntryId: string; instructionRevisionId: string; instructionSha256: string; interestPrompt: string }
export interface CardWorkRun extends ChatRun { usageJson?: Record<string, unknown>; finishedAt?: string | null; costAccountingPending?: boolean; costAccountedAt?: string | null }
export interface CardWorkEvidence { recipe: CardRecipe; instruction: InstructionFile; runs: CardWorkRun[]; overview: BudgetOverview; generation: Entity; decisions: ToolRunDecisionLookup; comments: Entity[]; activity: Array<Entity & { runId?: string }>; calls: ProviderCall[]; checklistSource: Entity }
const owned = new WeakMap<ChatCatalogContext, { provider: NotesProvider; connectionId?: string; recipe?: CardRecipe; source: Entity }>();
export function cardChecklistSourceData(source: Entity) {
  return JSON.stringify({ syntheticDependency: "Synthetic Launch Notes", companyId: source.companyId, sourceTaskId: source.id, title: source.title, status: source.status, description: source.description });
}
export function updateCardChecklistSource(ctx: ChatCatalogContext, source: Entity) {
  const state = owned.get(ctx);
  if (!state || source.id !== state.source.id || source.companyId !== state.source.companyId) throw new Error("Card checklist source identity changed");
  state.source = structuredClone(source);
}
export function cardChecklistPurpose(projectId: string) {
  return `Summarize the biggest blockers for Launch project ${projectId}, citing actual source tasks. This card requires current Synthetic Launch Notes checklist verification of the same source-task facts; older verification is not current. Include only blockers grounded in the saved Launch tasks.`;
}
export function cardChecklistInstructions(connectionId: string) {
  return `\n\n## Launch card source verification\nThis card uses an explicitly synthetic test dependency, Synthetic Launch Notes. For every generation, use its authorized read action on connection ${connectionId} to obtain current checklist verification of the saved Launch task facts. A previous generation's verification is not current input. If the required current source cannot be read, explain the actual blocker rather than presenting an unverified summary as fresh. Preserve the assigned task's company-search scope, bounded changed-issue facts, source visibility and required query/summary write-back sequence; do not add unrelated work or writes.\n`;
}
export function cardUsageComplete(run: CardWorkRun) {
  const u = run.usageJson;
  return run.status === "succeeded" && run.runtimeMode === "native" && time(run.finishedAt) && run.costAccountingPending === false && time(run.costAccountedAt)
    && record(record(run.resultJson).executionRecovery).providerWorkStarted !== false && !!u
    && u.accountingReceiptReady === true && u.accountingCaptureFailed !== true && u.accountingProviderWorkStarted !== false
    && text(u.accountingReceiptId) && text(u.accountingReceiptSourceId) && natural(u.accountingReceiptSequence) && Number(u.accountingReceiptSequence) > 0
    && time(u.accountingReceiptReceivedAt) && u.usageSource === "per_run" && text(u.provider) && text(u.biller) && text(u.model)
    && ["metered_api", "subscription_included"].includes(String(u.billingType)) && natural(u.inputTokens) && natural(u.outputTokens) && Number(u.inputTokens) + Number(u.outputTokens) > 0;
}
export function cardAccountingReady(companyId: string, workerId: string, leadId: string, runs: CardWorkRun[], overview: BudgetOverview) {
  if (!runs.length || runs.some(run => run.companyId !== companyId || ![workerId, leadId].includes(run.agentId ?? "") || !cardUsageComplete(run)) || overview.companyId !== companyId) return false;
  const scopes = [{ scopeType: "company", scopeId: companyId }, { scopeType: "agent", scopeId: workerId }, { scopeType: "agent", scopeId: leadId }];
  return scopes.every(scope => {
    const policies = overview.policies.filter(p => p.isActive && p.scopeType === scope.scopeType && p.scopeId === scope.scopeId);
    return policies.length > 0 && policies.every(p => p.companyId === companyId && p.hardStopEnabled && p.amount > 0 && p.unpricedUsagePolicy === "allow" && p.pendingRunCount === 0 && !p.paused && p.status !== "hard_stop" && p.remainingAmount > 0);
  });
}
function generationPayload(task: Entity) {
  try { return JSON.parse(task.description?.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null") as Record<string, unknown> | null; } catch { return null; }
}
export function boundCardChecklistRead(recipe: CardRecipe, run: CardWorkRun, decisions: ToolRunDecisionLookup, calls: ProviderCall[], failed: boolean, source: Entity, failedProjectionAt?: unknown) {
  const relevant = calls.filter(call => call.method === "tools/call" && call.name === "launch_read" && typeof call.receivedAt === "number" && typeof call.respondedAt === "number"
    && Number.isFinite(call.receivedAt) && Number.isFinite(call.respondedAt) && call.receivedAt <= call.respondedAt
    && call.receivedAt >= millis(run.startedAt!) && call.respondedAt <= millis(run.finishedAt!));
  if (source.companyId !== recipe.companyId || !source.id || !relevant.length || !relevant.every(call => call.authorized && call.responseHttpStatus === 200 && call.toolError === failed
    && call.responseSha256 === hash(JSON.stringify(notesReadResponse(cardChecklistSourceData(source), failed))))) return false;
  let causalReadCompleted = false;
  const bound = decisions.runId === run.id && relevant.every(call => decisions.decisions.some(({ invocation: v, auditEvents }) => v.companyId === recipe.companyId && v.agentId === recipe.workerId
    && v.issueId === run.contextSnapshot?.issueId && v.runId === run.id && v.connectionId === recipe.connectionId && v.catalogEntryId === recipe.readEntryId
    && v.policyDecision === "allow" && v.status === (failed ? "failed" : "succeeded") && v.errorCode === (failed ? "tool_error" : null)
    && time(v.startedAt) && time(v.completedAt) && !!v.argumentsHash && (failed || !!v.resultHash)
    && auditEvents.some(a => {
      const e = record(record(a.metadata).execution), request = record(e.request), response = record(e.response);
      const matched = a.invocationId === v.id && a.companyId === recipe.companyId && a.agentId === recipe.workerId && a.issueId === v.issueId && a.runId === run.id
        && a.connectionId === recipe.connectionId && a.catalogEntryId === recipe.readEntryId && a.outcome === (failed ? "failure" : "success")
        && a.decision === (failed ? "deny" : "allow") && a.reasonCode === (failed ? "tool_error" : "tool_completed")
        && e.transport === "mcp_remote" && request.dispatched === true && request.upstreamToolName === "launch_read" && request.mcpMethod === "tools/call" && response.httpStatus === 200
        && typeof request.requestId === "string" && call.requestIdSha256 === hash(request.requestId)
        && call.receivedAt! >= millis(v.startedAt!) && call.respondedAt! <= millis(v.completedAt!);
      if (matched && time(failedProjectionAt) && millis(failedProjectionAt) >= millis(v.completedAt) && millis(failedProjectionAt) >= call.respondedAt!) causalReadCompleted = true;
      return matched;
    })));
  return bound && (!failed || causalReadCompleted);
}
export function genuineCardWorkFailure(card: StatusCard, update: StatusCardUpdate, runId: string, leadId: string, evidence: CardWorkEvidence | undefined) {
  if (!evidence) return false;
  const { recipe, instruction, generation, runs, decisions, calls, comments, activity } = evidence;
  const run = runs.find(row => row.id === runId), payload = generationPayload(generation);
  if (!run || !cardUsageComplete(run) || !time(run.startedAt) || card.state !== "error" || !card.failureReason || card.generatingIssueId || card.companyId !== recipe.companyId || card.agentId !== recipe.workerId || card.interestPrompt !== recipe.interestPrompt
    || instruction.revision.companyId !== recipe.companyId || instruction.revision.agentId !== recipe.workerId || instruction.revision.id !== recipe.instructionRevisionId || hash(instruction.content) !== recipe.instructionSha256
    || generation.id !== update.generationIssueId || generation.companyId !== recipe.companyId || generation.assigneeAgentId !== recipe.workerId || generation.status !== "blocked"
    || payload?.companyId !== recipe.companyId || payload.statusCardId !== card.id || payload.generationIssueId !== generation.id
    || update.cardId !== card.id || update.status !== "failed" || !update.error || !time(update.finishedAt) || !time(update.startedAt)
    || millis(update.startedAt) > millis(run.startedAt) || millis(update.finishedAt!) < millis(run.startedAt)
    || run.companyId !== recipe.companyId || run.agentId !== recipe.workerId || run.contextSnapshot?.issueId !== generation.id
    || !boundCardChecklistRead(recipe, run, decisions, calls, true, evidence.checklistSource, update.finishedAt) || !cardAccountingReady(recipe.companyId, recipe.workerId, leadId, runs, evidence.overview)) return false;
  return comments.some(c => c.companyId === recipe.companyId && c.issueId === generation.id && c.authorAgentId === recipe.workerId && c.createdByRunId === run.id
    && /checklist|source/i.test(c.body ?? "") && /unavailable|could not|couldn't|fail|error|blocked/i.test(c.body ?? ""))
    && activity.some(a => a.companyId === recipe.companyId && a.entityId === generation.id && a.runId === run.id && a.action === "issue.updated"
      && (a.actorType === "agent" && a.actorId === recipe.workerId && a.details?.status === "blocked"
        || a.actorType === "system" && a.actorId === "native-status-committer" && a.details?.source === "native_status_decision" && a.details?.toStatus === "blocked"));
}
export async function prepareCardChecklist(ctx: ChatCatalogContext, workerId: string, projectId: string, source: Entity) {
  const current = { source: structuredClone(source) };
  const provider = await startNotesProvider(cardChecklistSourceData(source), { readContent: () => cardChecklistSourceData(current.source) });
  const state = { provider, connectionId: undefined as string | undefined, recipe: undefined as CardRecipe | undefined, get source() { return current.source; }, set source(value: Entity) { current.source = value; } }; owned.set(ctx, state);
  try {
    const connection = await connectNotes(ctx, provider, "read-only"); state.connectionId = connection.connectionId;
    await ctx.input.api.post(`${root(ctx)}/tools/apps/${connection.connectionId}/finish`, { enabledCatalogEntryIds: connection.read, askFirstCatalogEntryIds: [], access: { agentIds: [workerId] } });
    await ctx.input.api.putSensitive(`/api/tool-connections/${connection.connectionId}/installs`, { installs: [{ targetType: "agent", targetId: workerId }] });
    const url = `/api/agents/${workerId}/instructions-bundle/file`, current = await ctx.input.api.get<InstructionFile>(`${url}?path=AGENTS.md`);
    const saved = await ctx.input.api.putSensitive<InstructionFile>(url, { path: "AGENTS.md", content: current.content + cardChecklistInstructions(connection.connectionId), baseRevisionId: current.revision.id });
    const readback = await ctx.input.api.get<InstructionFile>(`${url}?path=AGENTS.md`);
    if (saved.revision.id !== readback.revision.id || saved.content !== readback.content || !readback.content.startsWith(current.content)) throw new Error("Card recipe instructions were not saved through the public revision path");
    state.recipe = { companyId: ctx.input.fixtures.company.id, workerId, connectionId: connection.connectionId, readEntryId: connection.read[0]!, instructionRevisionId: readback.revision.id, instructionSha256: hash(readback.content), interestPrompt: cardChecklistPurpose(projectId) };
    return state.recipe;
  } catch (error) { await cleanupCardChecklist(ctx); throw error; }
}
export function cardChecklistCalls(ctx: ChatCatalogContext) {
  return owned.get(ctx)?.provider.calls.map(({ method, name, authorized, sequence, requestIdSha256, responseHttpStatus, toolError, receivedAt, respondedAt, responseSha256 }) => ({ method, name, authorized, sequence, requestIdSha256, responseHttpStatus, toolError, receivedAt, respondedAt, responseSha256 })) ?? [];
}
export function failCardChecklist(ctx: ChatCatalogContext) { const state = owned.get(ctx); if (!state?.recipe) throw new Error("Missing saved card recipe"); state.provider.failReads(); }
export async function observeCardWork(ctx: ChatCatalogContext, recipe: CardRecipe, issueId: string): Promise<CardWorkEvidence> {
  const all = await ctx.allRuns();
  const runs = await Promise.all(all.map(run => ctx.input.api.get<CardWorkRun>(`/api/heartbeat-runs/${run.id}`)));
  const workerRuns = runs.filter(run => run.agentId === recipe.workerId && run.contextSnapshot?.issueId === issueId);
  if (workerRuns.length > 1) throw new Error("Card generation exceeded its single declared native turn");
  const run = workerRuns[0];
  const [instruction, overview, generation, decisions, comments, activity] = await Promise.all([
    ctx.input.api.get<InstructionFile>(`/api/agents/${recipe.workerId}/instructions-bundle/file?path=AGENTS.md`), ctx.input.api.get<BudgetOverview>(`${root(ctx)}/budgets/overview`),
    ctx.input.api.get<Entity>(`/api/issues/${issueId}`), run ? ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${run.id}/decisions`) : Promise.resolve({ runId: "", decisions: [] }),
    ctx.input.api.get<Entity[]>(`/api/issues/${issueId}/comments?order=asc`), ctx.input.api.get<Array<Entity & { runId?: string }>>(`/api/issues/${issueId}/activity`),
  ]);
  return { recipe, instruction, runs, overview, generation, decisions, comments, activity, calls: cardChecklistCalls(ctx), checklistSource: structuredClone(owned.get(ctx)!.source) };
}
export function genuineCardChecklistSuccess(cardId: string, recipe: CardRecipe, update: StatusCardUpdate, evidence: CardWorkEvidence | undefined) {
  if (!evidence || !update.runId || !update.generationIssueId || update.status !== "ok" || update.cardId !== cardId) return false;
  const run = evidence.runs.find(row => row.id === update.runId), payload = generationPayload(evidence.generation);
  return !!run && cardUsageComplete(run) && time(run.startedAt) && run.companyId === recipe.companyId && run.agentId === recipe.workerId && run.contextSnapshot?.issueId === update.generationIssueId
    && evidence.generation.companyId === recipe.companyId && evidence.generation.id === update.generationIssueId && evidence.generation.assigneeAgentId === recipe.workerId && evidence.generation.status === "done"
    && payload?.companyId === recipe.companyId && payload.statusCardId === cardId && payload.generationIssueId === update.generationIssueId
    && boundCardChecklistRead(recipe, run, evidence.decisions, evidence.calls, false, evidence.checklistSource)
    && evidence.instruction.revision.companyId === recipe.companyId && evidence.instruction.revision.agentId === recipe.workerId
    && evidence.instruction.revision.id === recipe.instructionRevisionId && hash(evidence.instruction.content) === recipe.instructionSha256;
}
export async function observeCardChecklistSuccess(ctx: ChatCatalogContext, recipe: CardRecipe, update: StatusCardUpdate) {
  if (!update?.generationIssueId) throw new Error("Card checklist success needs actual saved generation work");
  return observeCardWork(ctx, recipe, update.generationIssueId);
}
export async function cleanupCardChecklist(ctx: ChatCatalogContext) {
  const state = owned.get(ctx); if (!state) return; owned.delete(ctx);
  try { if (state.connectionId) await ctx.input.api.delete(`/api/tool-connections/${state.connectionId}`); }
  finally { await state.provider.close(); }
}
