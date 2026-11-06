import { createHash } from "node:crypto";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import type { RoutineRunSummary } from "../../../packages/shared/src/types/routine.js";
import type { ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatRun } from "../chat-flow.js";
import { pollUntil } from "../api.js";
import { connectNotes, startNotesProvider, type NotesProvider, type ProviderCall } from "./external-provider.js";
import type { Entity } from "./internal-support.js";

export interface HistoryWorkIdentity { companyId: string; agentId: string; issueId: string; runId: string; routineId: string; invocationId: string; connectionId: string; writeEntryId: string }
export interface AccountedHistoryRun extends ChatRun { finishedAt?: string | null; usageJson?: Record<string, unknown> | null; costAccountingPending?: boolean; costAccountedAt?: string | null }
export interface HistoryWorkSnapshot { run?: AccountedHistoryRun; task: Entity; invocation?: RoutineRunSummary; decisions: ToolRunDecisionLookup; comments: Entity[]; activity: Array<Entity & { runId?: string }> }
export type WorkCall = Pick<ProviderCall, "method" | "name" | "authorized" | "sequence" | "requestIdSha256" | "responseHttpStatus" | "toolError">;
const providers = new WeakMap<ChatCatalogContext, { provider: NotesProvider; connectionId?: string }>();
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value !== "unknown";
export function completeHistoryUsage(run: AccountedHistoryRun | undefined) {
  const u = run?.usageJson;
  return !!run && !!u && run.status === "succeeded" && run.runtimeMode === "native" && !!run.finishedAt
    && run.costAccountingPending === false && typeof run.costAccountedAt === "string" && Number.isFinite(Date.parse(run.costAccountedAt))
    && record(record(run.resultJson).executionRecovery).providerWorkStarted !== false
    && u.accountingReceiptReady === true && u.accountingCaptureFailed !== true && u.accountingProviderWorkStarted !== false
    && text(u.accountingReceiptId) && text(u.accountingReceiptSourceId) && positiveInteger(u.accountingReceiptSequence)
    && typeof u.accountingReceiptReceivedAt === "string" && Number.isFinite(Date.parse(u.accountingReceiptReceivedAt))
    && u.usageSource === "per_run" && text(u.provider) && text(u.biller) && text(u.model)
    && ["metered_api", "subscription_included"].includes(String(u.billingType))
    && nonnegativeInteger(u.inputTokens) && nonnegativeInteger(u.outputTokens) && Number(u.inputTokens) + Number(u.outputTokens) > 0;
}
export function routineHistoryAccountingReady(expected: Pick<HistoryWorkIdentity, "companyId" | "agentId" | "issueId" | "runId">, runs: AccountedHistoryRun[], overview: BudgetOverview) {
  const run = runs.find(row => row.id === expected.runId);
  if (!run || run.companyId !== expected.companyId || run.agentId !== expected.agentId || run.contextSnapshot?.issueId !== expected.issueId
    || !completeHistoryUsage(run) || overview.companyId !== expected.companyId) return false;
  const policies = overview.policies.filter(p => p.isActive && (p.scopeType === "company" && p.scopeId === expected.companyId || p.scopeType === "agent" && p.scopeId === expected.agentId));
  return ["company", "agent"].every(scope => policies.some(p => p.scopeType === scope)) && policies.every(p => p.companyId === expected.companyId
    && p.hardStopEnabled && p.amount > 0 && p.unpricedUsagePolicy === "allow" && p.pendingRunCount === 0 && !p.paused && p.status !== "hard_stop" && p.remainingAmount > 0);
}
export function genuineHistoryWork(expected: HistoryWorkIdentity, snapshot: HistoryWorkSnapshot | undefined, calls: WorkCall[], failed: boolean) {
  if (!expected || !snapshot) return false;
  const { run, task, invocation, decisions, comments, activity } = snapshot;
  const status = failed ? "blocked" : "done";
  if (!run || run.id !== expected.runId || run.companyId !== expected.companyId || run.agentId !== expected.agentId
    || run.status !== "succeeded" || run.runtimeMode !== "native" || !run.startedAt || !run.finishedAt || run.contextSnapshot?.issueId !== expected.issueId
    || task.id !== expected.issueId || task.companyId !== expected.companyId || task.status !== status || task.assigneeAgentId !== expected.agentId
    || !invocation || invocation.id !== expected.invocationId || invocation.companyId !== expected.companyId || invocation.routineId !== expected.routineId
    || invocation.linkedIssueId !== expected.issueId || invocation.status !== (failed ? "failed" : "completed") || !invocation.completedAt || invocation.source !== "manual") return false;
  const writes = calls.filter(call => call.method === "tools/call" && call.name === "launch_update");
  if (!writes.length || !writes.every(call => call.authorized && call.responseHttpStatus === 200 && call.toolError === failed)) return false;
  const receipt = decisions.runId === expected.runId && decisions.decisions.some(({ invocation: v, auditEvents }) =>
    v.companyId === expected.companyId && v.agentId === expected.agentId && v.issueId === expected.issueId && v.runId === expected.runId
    && v.connectionId === expected.connectionId && v.catalogEntryId === expected.writeEntryId && v.policyDecision === "allow"
    && v.status === (failed ? "failed" : "succeeded") && (failed ? v.errorCode === "tool_error" : v.errorCode === null)
    && !!v.startedAt && !!v.completedAt && !!v.argumentsHash && (failed || !!v.resultHash)
    && auditEvents.some(a => a.invocationId === v.id && a.companyId === expected.companyId && a.agentId === expected.agentId && a.issueId === expected.issueId
      && a.runId === expected.runId && a.connectionId === expected.connectionId && a.catalogEntryId === expected.writeEntryId
      && a.outcome === (failed ? "failure" : "success") && a.decision === (failed ? "deny" : "allow")
      && a.reasonCode === (failed ? "tool_error" : "tool_completed") && record(record(a.metadata).execution).response != null
      && record(record(record(a.metadata).execution).response).httpStatus === 200
      && record(a.metadata).execution != null && record(record(a.metadata).execution).transport === "mcp_remote"
      && record(record(record(a.metadata).execution).request).dispatched === true
      && record(record(record(a.metadata).execution).request).upstreamToolName === "launch_update"
      && record(record(record(a.metadata).execution).request).mcpMethod === "tools/call"
      && typeof record(record(record(a.metadata).execution).request).requestId === "string"
      && writes.some(call => call.requestIdSha256 === createHash("sha256").update(String(record(record(record(a.metadata).execution).request).requestId)).digest("hex"))));
  return !!receipt && comments.some(c => c.issueId === task.id && c.authorAgentId === expected.agentId && c.createdByRunId === run.id && !!c.body?.trim()
    && (!failed || /\b(?:fail\w*|error|blocked)\b/i.test(c.body)))
    && activity.some(a => a.companyId === expected.companyId && a.entityId === expected.issueId && a.runId === expected.runId && a.action === "issue.updated"
      && (a.actorType === "agent" && a.actorId === expected.agentId && a.details?.status === status
        || a.actorType === "system" && a.actorId === "native-status-committer" && a.details?.source === "native_status_decision" && a.details?.toStatus === status));
}
export async function prepareHistoryNotes(ctx: ChatCatalogContext, workerId: string) {
  const provider = await startNotesProvider("Synthetic Launch project: payment approval remains pending; no other active work.");
  const owned = { provider, connectionId: undefined as string | undefined }; providers.set(ctx, owned); provider.failWrites();
  try {
    const connection = await connectNotes(ctx, provider, "all"); owned.connectionId = connection.connectionId;
    const agentIds = [ctx.input.fixtures.agent.id, workerId];
    await ctx.input.api.post(`${root(ctx)}/tools/apps/${connection.connectionId}/finish`, { enabledCatalogEntryIds: [...connection.read, ...connection.write], askFirstCatalogEntryIds: [], access: { agentIds } });
    await ctx.input.api.putSensitive(`/api/tool-connections/${connection.connectionId}/installs`, { installs: agentIds.map(targetId => ({ targetType: "agent", targetId })) });
    return { connectionId: connection.connectionId, writeEntryId: connection.write[0]! };
  } catch (error) { await cleanupHistoryNotes(ctx); throw error; }
}
export function historyNotesCalls(ctx: ChatCatalogContext, afterSequence = -1): WorkCall[] {
  return providers.get(ctx)!.provider.calls.filter(c => c.sequence > afterSequence).map(({ method, name, authorized, sequence, requestIdSha256, responseHttpStatus, toolError }) => ({ method, name, authorized, sequence, requestIdSha256, responseHttpStatus, toolError }));
}
export function historyNotesPhase(ctx: ChatCatalogContext, recover = false) {
  const provider = providers.get(ctx)!.provider;
  if (recover) provider.allowWrites();
  return { lastSequence: provider.calls.at(-1)?.sequence ?? -1, written: provider.written() ?? null };
}
export async function readHistoryWork(ctx: ChatCatalogContext, expected: Omit<HistoryWorkIdentity, "runId">): Promise<HistoryWorkSnapshot> {
  const runs = (await ctx.allRuns()).filter(run => run.contextSnapshot?.issueId === expected.issueId);
  if (runs.length > 1) throw new Error("Routine work exceeded its single declared native invocation");
  const run = runs[0] ? await ctx.input.api.get<AccountedHistoryRun>(`/api/heartbeat-runs/${runs[0].id}`) : undefined;
  const [task, history, comments, activity, decisions] = await Promise.all([
    ctx.input.api.get<Entity>(`/api/issues/${expected.issueId}`), ctx.input.api.get<RoutineRunSummary[]>(`/api/routines/${expected.routineId}/runs`),
    ctx.input.api.get<Entity[]>(`/api/issues/${expected.issueId}/comments?order=asc`), ctx.input.api.get<Array<Entity & { runId?: string }>>(`/api/issues/${expected.issueId}/activity`),
    run ? ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${run.id}/decisions`) : Promise.resolve({ runId: "", decisions: [] }),
  ]);
  return { run, task, invocation: history.find(row => row.id === expected.invocationId), comments, activity, decisions };
}
export async function waitHistoryWork(ctx: ChatCatalogContext, expected: Omit<HistoryWorkIdentity, "runId">, failed: boolean, afterSequence: number, durationMs: number, accounting = false) {
  return pollUntil({ label: failed ? "actual failed routine work and native blocked decision" : "actual recovered routine work and complete normal usage", deadlineAt: Date.now() + durationMs, intervalMs: 1000,
    load: async () => ({ snapshot: await readHistoryWork(ctx, expected), calls: historyNotesCalls(ctx, afterSequence), overview: accounting ? await ctx.input.api.get<BudgetOverview>(`${root(ctx)}/budgets/overview`) : undefined }),
    accept: v => !!v.snapshot.run && genuineHistoryWork({ ...expected, runId: v.snapshot.run.id }, v.snapshot, v.calls, failed)
      && (!accounting || routineHistoryAccountingReady({ ...expected, runId: v.snapshot.run!.id }, [v.snapshot.run!], v.overview!)),
    reject: v => v.snapshot.run && ["failed", "cancelled", "timed_out"].includes(v.snapshot.run.status) ? "Routine provider prerequisite did not yield a normally completed native turn" : undefined });
}
export async function cleanupHistoryNotes(ctx: ChatCatalogContext) {
  const owned = providers.get(ctx); if (!owned) return; providers.delete(ctx);
  try { if (owned.connectionId) await ctx.input.api.delete(`/api/tool-connections/${owned.connectionId}`); }
  finally { await owned.provider.close(); }
}
