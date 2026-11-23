import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { Issue, IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { readRecord, recordParams } from "./api-read-receipts.js";
import { checks, hasLink, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releasedRetryListener, releaseRuntimeWorker, type RuntimeBriefGate } from "./runtime-busy-worker.js";
import { faultOwnedNativeProcess, NATIVE_INFRASTRUCTURE_FAULT_CODES, type NativeFaultRun } from "./runtime-native-fault.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent, type RuntimeObservation } from "./runtime-support.js";
export const INFRASTRUCTURE_RECOVERY_ORACLE = "paperclip.chat-catalog.runtime.infrastructure-recovery.v7";
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/**
 * The chat run read the source task's saved recovery record through a product
 * tool: its recovery actions, its runs, the failed run itself, or the task
 * whose execution blocker names that failed run. Tool outputs
 * are product data and are matched exactly; the agent's wording never is.
 */
export function readSourceRecoveryRecord(events: readonly Record<string, unknown>[], taskId: string, failedRunId: string, identifier?: string | null, continuationRunId?: string | null) {
  const runIds = [failedRunId, continuationRunId].filter((id): id is string => !!id);
  // call_api bodies are redacted before saving: bind those reads by their input digest and a successful result.
  const task = recordParams("id", taskId, identifier);
  if (taskId && failedRunId && readRecord(events, [
    { operationId: "GET /api/issues/{id}/recovery-actions", pathParams: task, paged: true },
    { operationId: "GET /api/issues/{id}/runs", pathParams: task, paged: true },
    { operationId: "GET /api/issues/{id}", pathParams: task },
    { operationId: "GET /api/heartbeat-runs/{runId}", pathParams: runIds.flatMap(id => recordParams("runId", id)) },
  ])) return true;
  return !!taskId && !!failedRunId && events.some(row => {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), payload = objectRecord(envelope.payload);
    const output = typeof payload.output === "string" ? payload.output : "";
    return row.eventType === "tool.execution.completed" && envelope.sourceKind === "runner" && payload.status === "completed"
      && (/apiOperationId\\*"\s*:\s*\\*"GET \/api\/issues\/\{id\}\/(?:recovery-actions|runs)(?![\w/{])/.test(output) && output.includes(taskId)
        || /apiOperationId\\*"\s*:\s*\\*"GET \/api\/heartbeat-runs\/\{runId\}(?![\w/{])/.test(output) && runIds.some(id => output.includes(id))
        // The task read carries its execution blocker: the saved recovery
        // record, bound to the failed run it stopped on.
        || /apiOperationId\\*"\s*:\s*\\*"GET \/api\/issues\/\{id\}\\*"/.test(output) && output.includes(taskId) && runIds.some(id => output.includes(id)));
  });
}
/** Whether one controller run read the recovery record; computed from its own retained events. */
export async function controllerReadRecovery(ctx: ChatCatalogContext, runId: string | undefined, taskId: string, failedRunId: string, identifier?: string | null, continuationRunId?: string | null) {
  if (!runId) return false;
  const events = await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=1000`));
  return readSourceRecoveryRecord(events, taskId, failedRunId, identifier, continuationRunId);
}
export function linksSourceTask(o: RuntimeObservation, task: Entity) { return hasLink(o, "issues", task); }
export type SourceRecoveryActions = { active?: IssueRecoveryAction | null; actions?: IssueRecoveryAction[] };
export const FRESH_CONTINUATION_SCHEMA = "paperclip.fresh-continuation.v1";
export function sourceRunRecovery(ctx: ChatCatalogContext, taskId: string, runId: string) {
  return ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${taskId}/recovery-actions?inspectSourceRunId=${encodeURIComponent(runId)}`);
}
type FailedRun = Pick<NativeFaultRun, "id" | "status" | "resultJson">;
export function freshContinuationRecord(recovery: SourceRecoveryActions | undefined, run: FailedRun | undefined, companyId: string, issueId: string, agentId: string) {
  if (!run) return undefined;
  const records = (recovery?.actions ?? []).filter(action => objectRecord(objectRecord(action.evidence).freshContinuation).sourceRunId === run.id);
  const action = records.length === 1 ? records[0]! : undefined;
  if (!action) return undefined;
  const fresh = objectRecord(action.evidence.freshContinuation), settlement = objectRecord(action.evidence.freshContinuationSettlement);
  return action.companyId === companyId && action.sourceIssueId === issueId && action.status === "resolved" && action.outcome === "restored"
    && action.ownerType === "system" && action.ownerAgentId == null && action.ownerUserId == null && action.recoveryIssueId == null && action.returnOwnerAgentId === agentId
    && fresh.schema === FRESH_CONTINUATION_SCHEMA && NATIVE_INFRASTRUCTURE_FAULT_CODES.includes(String(fresh.failureCode))
    && settlement.actorType === "system" && settlement.decision === "continue_in_fresh_run" && settlement.replay === "none" && settlement.sourceRunId === run.id
    && run.status === "failed" && typeof objectRecord(run.resultJson).freshContinuationSupersededAt === "string" ? action : undefined;
}
export function continuesFailedRun(run: Pick<HeartbeatRun, "id" | "companyId" | "agentId" | "retryOfRunId" | "contextSnapshot"> | undefined, failedRunId: string, companyId: string, issueId: string, agentId: string) {
  return !!run && run.id !== failedRunId && run.companyId === companyId && run.agentId === agentId && run.retryOfRunId === failedRunId
    && [run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].includes(issueId);
}
export const INFRASTRUCTURE_BRIEF_SOURCE = "The website brief comes from the brief export command below, which can take several minutes to return.";
export async function nativeInfrastructureLoss(ctx: ChatCatalogContext) {
  const state = await busyRuntimeWorker(ctx, { briefSource: INFRASTRUCTURE_BRIEF_SOURCE }), task = state.task as Entity;
  const faults: Array<{ runId: string; pid: number | null; errorCode: string | null }> = [];
  let previousPid: number | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const active = await pollUntil({ label: `Real native coordinator attempt ${attempt} on the owned original heartbeat`, deadlineAt: Date.now() + 120_000,
      load: () => ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      accept: run => run.status === "running" && !!run.processPid && run.processPid !== previousPid,
      reject: run => run.nativePhase === "terminal_failure" ? "Native infrastructure became terminal before three real bounded attempts" : undefined });
    const failed = await faultOwnedNativeProcess(ctx, { runId: active.id, issueId: task.id, agentId: state.worker.id });
    faults.push({ runId: failed.id, pid: failed.processPid, errorCode: failed.errorCode }); previousPid = active.processPid;
    await ctx.input.evidence(`runtime-infrastructure-attempt-${attempt}.json`, { runId: active.id, attempt, processPid: active.processPid, errorCode: failed.errorCode, status: failed.status, nativePhase: failed.nativePhase });
    const others = (await ctx.allRuns()).filter(row => row.id !== state.workerRunId);
    const successor = attempt === 3 && others.length === 1 ? await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${others[0]!.id}`) : undefined;
    if (others.length && !continuesFailedRun(successor, state.workerRunId, ctx.input.fixtures.company.id, task.id, state.worker.id))
      throw new Error("Infrastructure setup created an undeclared replacement heartbeat instead of same-run coordinator recovery");
  }
  return { ...state, setupFaults: faults };
}
export async function freshlyContinuedNativeInfrastructure(ctx: ChatCatalogContext) {
  const state = await nativeInfrastructureLoss(ctx), task = state.task as Entity, worker = state.worker as RuntimeAgent, gate = state.gate as RuntimeBriefGate;
  const companyId = ctx.input.fixtures.company.id, lostAt = Date.now();
  const continued = await pollUntil({ label: "One fresh continuation from saved work starts and waits for the human brief", deadlineAt: Date.now() + 300_000,
    load: async () => {
      const run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`);
      const recovery = await sourceRunRecovery(ctx, task.id, run.id);
      const successors = (await ctx.allRuns()).filter(row => row.agentId === worker.id && row.id !== run.id);
      const detail = successors.length === 1 ? await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${successors[0]!.id}`) : undefined;
      const listener = detail && continuesFailedRun(detail, run.id, companyId, task.id, worker.id)
        ? await releasedRetryListener(detail, { companyId, workerId: worker.id, taskId: task.id, originalRunId: run.id, gateName: gate.gateName! }) : null;
      return { run, recovery, successors: successors.length, detail, listener };
    },
    accept: v => !!freshContinuationRecord(v.recovery, v.run, companyId, task.id, worker.id) && v.successors === 1 && v.detail?.status === "running" && !!v.listener,
    reject: v => v.successors > 1 ? "More than one run continued the interrupted Website run"
      : v.detail && ["failed", "cancelled", "timed_out", "succeeded"].includes(v.detail.status) ? "The fresh continuation ended before its human brief" : undefined });
  const record = freshContinuationRecord(continued.recovery, continued.run, companyId, task.id, worker.id)!, fresh = objectRecord(record.evidence.freshContinuation);
  const current = await ctx.input.api.get<Issue>(`/api/issues/${task.id}`);
  await ctx.input.evidence("runtime-fresh-continuation.json", { sourceRunId: continued.run.id, failureCode: continued.run.errorCode, sourceFinishedAt: continued.run.finishedAt,
    recordedAt: fresh.recordedAt, isolation: fresh.isolation, delivery: fresh.delivery, recoveryActionId: record.id, continuationRunId: continued.detail!.id,
    continuationCreatedAt: continued.detail!.createdAt, continuationStartedAt: continued.detail!.startedAt, listenerObservedMs: Date.now() - lostAt,
    continuationWorkspaceId: continued.listener!.workspaceId, originalWorkspaceId: gate.boundWorkspaceId ?? null });
  return { ...state, task: current, failure: continued.run, continuation: record, continuationRunId: continued.detail!.id,
    continuationGate: continued.listener!.gate, continuationWorkspaceId: continued.listener!.workspaceId };
}
export function gradeInfrastructureRecovery(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-infrastructure-and-continuation-evidence", !!o, "Three actual verified native Runner losses and the resulting public recovery record are required."); if (!o) return c.result();
  const s = o.state, task = s.task as Issue, worker = s.worker as Entity, run = s.failure as NativeFaultRun, recorded = s.continuation as IssueRecoveryAction | undefined;
  const after = freshContinuationRecord(s.recoveryAfter as SourceRecoveryActions | undefined, run, o.companyId, task?.id, worker?.id);
  c.add("genuine-infrastructure-loss", !!run && run.status === "failed" && Array.isArray(s.setupFaults) && s.setupFaults.length === 3
    && new Set(s.setupFaults.map(row => (row as { pid: number }).pid)).size === 3
    && (s.setupFaults as Array<{ runId: string; errorCode: string }>).every(row => row.runId === run.id && NATIVE_INFRASTRUCTURE_FAULT_CODES.includes(row.errorCode)),
  "The actual original native run loses its Runner three times with real process loss evidence; a model failure, cancellation or fabricated attempt cannot qualify.");
  const continuation = s.continuationRun as HeartbeatRun | undefined;
  c.add("one-fresh-continuation-without-person-action", !!after && after.id === recorded?.id && s.taskStatusAtReply !== "blocked"
    && (s.activeHoldAtReply == null || (s.activeHoldAtReply as IssueRecoveryAction).ownerType === "system")
    && continuesFailedRun(continuation, run.id, o.companyId, task.id, worker.id) && continuation?.id === s.continuationRunId
    && o.runs.filter(row => row.agentId === worker.id && row.id !== run.id).length === 1,
  "The system records exactly one fresh continuation of the interrupted run from saved work, owned by the system, and no person must act before it starts.");
  c.add("continuation-finishes-from-saved-work", s.continuationResult === true && o.tasks.length === 1
    && o.tasks.some(row => row.id === task.id && row.status === "done" && row.assigneeAgentId === worker.id)
    && o.runs.length === 3 && o.runs.find(row => row.id === run.id)?.status === "failed" && o.runs.find(row => row.id === s.continuationRunId)?.status === "succeeded"
    && o.runs.filter(row => row.agentId === o.leadId).every(row => row.status === "succeeded"),
  "The continuation actually runs to completion on the original task and saves its result; no repair task, duplicate run or Retry is introduced.");
  c.add("read-actual-recovery-record", s.queryRecoveryRead === true,
    "The controller's own run read the original task's saved recovery record, its runs, or the interrupted or continuing run before answering.");
  c.add("links-original-task", linksSourceTask(o, task as unknown as Entity),
    "The reply links the original task that is continuing, rather than a new repair task.");
  return c.result();
}
function infrastructureCase(id: "recovery.explain-stall" | "recovery.source-action") {
  return runtimeDefinition(id, freshlyContinuedNativeInfrastructure, gradeInfrastructureRecovery, {
    oracleVersion: INFRASTRUCTURE_RECOVERY_ORACLE, expectedRunCount: 3, attemptTimeoutMs: 1_500_000,
    runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 2 } },
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-native-infrastructure-loss", "fresh-continuation-without-person"] },
    async verifySetup(ctx, state) { const c = checks(), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
      const run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`), task = state.task as Issue, worker = state.worker as Entity;
      const record = freshContinuationRecord(await sourceRunRecovery(ctx, task.id, run.id), run, ctx.input.fixtures.company.id, task.id, worker.id);
      const continuation = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.continuationRunId}`);
      c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual controller remains independently admitted.");
      c.add("real-native-infrastructure-loss", run.status === "failed" && NATIVE_INFRASTRUCTURE_FAULT_CODES.includes(String(run.errorCode)), "The saved native run really failed after losing its Runner.");
      c.add("fresh-continuation-without-person", !!record && record.id === (state.continuation as IssueRecoveryAction).id
        && continuesFailedRun(continuation, run.id, ctx.input.fixtures.company.id, task.id, worker.id) && continuation.status === "running",
      "One system-owned fresh continuation of the interrupted run is running."); return c.result(); },
    sourceFiles: ["chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
    async act(ctx, state) {
      const task = state.task as Issue, failedRunId = String(state.workerRunId), continuationRunId = String(state.continuationRunId);
      await pollUntil({ label: "Canonical explanation while the fresh continuation waits for its brief", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
        load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
        accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.some(row => row.id === failedRunId && row.status === "failed")
          && v.runs.some(row => row.id === continuationRunId && row.status === "running") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
      const answered = await observeRuntime(ctx, state); state.queryReply = answered.reply;
      state.queryRecoveryRead = await controllerReadRecovery(ctx, answered.runs.find(row => row.agentId === ctx.input.fixtures.agent.id)?.id, task.id, failedRunId, task.identifier, continuationRunId);
      state.activeHoldAtReply = (await ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${task.id}/recovery-actions`)).active ?? null;
      state.taskStatusAtReply = (await ctx.input.api.get<Issue>(`/api/issues/${task.id}`)).status;
      const source = ctx.input.page.url();
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible();
      await ctx.input.capture("actual-fresh-continuation", "Original Website continues in a fresh run from saved work after the Runner loss", "runtime-infrastructure-recovery.png");
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      await writeFile(String(state.continuationGate), `The human brief is ready. Save a non-plan website-delivery document with the exact reference Continued website ${ctx.input.nonce}, a semantic single-page Acorn website outline and an accessible signup action, then complete this original task normally. Do not create more tasks or external effects.`, "utf8");
      await pollUntil({ label: "The fresh continuation finishes the original Website task", deadlineAt: Date.now() + 240_000,
        load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
        accept: v => v.task.status === "done" && v.runs.length === 3 && v.runs.some(row => row.id === continuationRunId && row.status === "succeeded"),
        reject: v => v.runs.length > 3 || v.runs.some(row => row.id === continuationRunId && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The continuation failed or duplicated Website work" : undefined });
    },
    async observe(ctx, state) {
      const task = state.task as Issue;
      state.recoveryAfter = await sourceRunRecovery(ctx, task.id, String(state.workerRunId));
      state.continuationRun = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.continuationRunId}`);
      const o = await observeRuntime(ctx, state);
      state.continuationResult = o.revisions.some(row => row.createdByRunId === state.continuationRunId && row.createdByAgentId === (state.worker as Entity).id
        && (row.body ?? "").includes(`Continued website ${ctx.input.nonce}`) && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
      return o;
    },
    async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Issue;
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("button", { name: "Change status (current: Done)", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
    cleanup: async (_ctx, state) => { if (state.continuationGate) await writeFile(String(state.continuationGate), "The human ended this disposable fixture. Preserve any saved work and finish normally.", "utf8"); await releaseRuntimeWorker(state); },
  });
}
export const runtimeInfrastructureCases = [infrastructureCase("recovery.explain-stall"), infrastructureCase("recovery.source-action")];
