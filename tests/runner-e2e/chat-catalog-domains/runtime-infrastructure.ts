import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { Issue, IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { readRecord, recordParams } from "./api-read-receipts.js";
import { checks, hasLink, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { faultOwnedNativeProcess, NATIVE_INFRASTRUCTURE_FAULT_CODES, type NativeFaultRun } from "./runtime-native-fault.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent, type RuntimeObservation } from "./runtime-support.js";
export const INFRASTRUCTURE_RECOVERY_ORACLE = "paperclip.chat-catalog.runtime.infrastructure-recovery.v5";
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/**
 * The chat run read the source task's saved recovery record through a product
 * tool: its recovery actions, its runs, the failed run itself, or the task
 * whose execution blocker names that failed run. Tool outputs
 * are product data and are matched exactly; the agent's wording never is.
 */
export function readSourceRecoveryRecord(events: readonly Record<string, unknown>[], taskId: string, failedRunId: string, identifier?: string | null) {
  // call_api bodies are redacted before saving: bind those reads by their input digest and a successful result.
  const task = recordParams("id", taskId, identifier);
  if (taskId && failedRunId && readRecord(events, [
    { operationId: "GET /api/issues/{id}/recovery-actions", pathParams: task, paged: true },
    { operationId: "GET /api/issues/{id}/runs", pathParams: task, paged: true },
    { operationId: "GET /api/issues/{id}", pathParams: task },
    { operationId: "GET /api/heartbeat-runs/{runId}", pathParams: recordParams("runId", failedRunId) },
  ])) return true;
  return !!taskId && !!failedRunId && events.some(row => {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), payload = objectRecord(envelope.payload);
    const output = typeof payload.output === "string" ? payload.output : "";
    return row.eventType === "tool.execution.completed" && envelope.sourceKind === "runner" && payload.status === "completed"
      && (/apiOperationId\\*"\s*:\s*\\*"GET \/api\/issues\/\{id\}\/(?:recovery-actions|runs)(?![\w/{])/.test(output) && output.includes(taskId)
        || /apiOperationId\\*"\s*:\s*\\*"GET \/api\/heartbeat-runs\/\{runId\}(?![\w/{])/.test(output) && output.includes(failedRunId)
        // The task read carries its execution blocker: the saved recovery
        // record, bound to the failed run it stopped on.
        || /apiOperationId\\*"\s*:\s*\\*"GET \/api\/issues\/\{id\}\\*"/.test(output) && output.includes(taskId) && output.includes(failedRunId));
  });
}
/** Whether one controller run read the recovery record; computed from its own retained events. */
export async function controllerReadRecovery(ctx: ChatCatalogContext, runId: string | undefined, taskId: string, failedRunId: string, identifier?: string | null) {
  if (!runId) return false;
  const events = await collectRunEvents<Record<string, unknown>>(afterSeq => ctx.input.api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=1000`));
  return readSourceRecoveryRecord(events, taskId, failedRunId, identifier);
}
/** The reply links the original task, where its recovery and Retry controls live. */
export function linksSourceTask(o: RuntimeObservation, task: Entity) { return hasLink(o, "issues", task); }
/** The product either keeps the exhausted action active, or settles it for
 * this run as `blocked` under its preserve-without-replay policy, leaving the
 * human Retry on the blocked source task. Any other settlement is not it. */
function exhaustedActionLive(action: IssueRecoveryAction, run: NativeFaultRun) {
  if (action.status !== "resolved") return action.status === undefined || action.status === "active" || action.status === "escalated";
  const automatic = objectRecord(action.evidence.automaticRecovery);
  return action.outcome === "blocked" && automatic.policy === "preserve_without_replay_v1" && automatic.runId === run.id;
}
export function isExhaustedNativeRecovery(action: IssueRecoveryAction | undefined, run: NativeFaultRun, companyId: string, issueId: string, agentId: string) {
  return !!action && exhaustedActionLive(action, run) && action.companyId === companyId && action.sourceIssueId === issueId && action.kind === "active_run_watchdog" && action.cause === "native_session_retry_exhausted"
    && action.ownerType === "board" && action.ownerAgentId == null && action.returnOwnerAgentId === agentId && action.recoveryIssueId == null
    && action.evidence.runId === run.id && action.evidence.coordinatorAttempt === 3 && action.evidence.recoveryDisposition === "native_session_retry_exhausted"
    && action.maxAttempts === 3 && action.wakePolicy == null && action.nextAction.trim().length > 0 && run.status === "failed" && run.nativePhase === "terminal_failure";
}
export type SourceRecoveryActions = { active?: IssueRecoveryAction | null; actions?: IssueRecoveryAction[] };
const newest = (actions: readonly IssueRecoveryAction[]) => [...actions].sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)))[0];
/** The source task's exhausted action: the active one, or else its newest
 * action. The task itself must be blocked, where the human Retry lives. */
export function exhaustedSourceRecovery(recovery: SourceRecoveryActions, task: Pick<Issue, "status">, run: NativeFaultRun, companyId: string, issueId: string, agentId: string) {
  const action = recovery.active ?? newest(recovery.actions ?? []);
  return task.status === "blocked" && isExhaustedNativeRecovery(action, run, companyId, issueId, agentId) ? action : undefined;
}
/** The same action, read again by ID, so a replaced or duplicated action is detected. */
export function sameRecoveryAction(recovery: SourceRecoveryActions, id: string) {
  return [recovery.active, ...(recovery.actions ?? [])].find(action => action?.id === id) ?? undefined;
}
/** Three actual coordinator attempts on the SAME native heartbeat; never status patches or fake event rows. */
export async function exhaustedNativeInfrastructure(ctx: ChatCatalogContext) {
  const state = await busyRuntimeWorker(ctx), task = state.task as Entity;
  const faults: Array<{ runId: string; pid: number | null; errorCode: string | null }> = [];
  let previousPid: number | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const active = await pollUntil({ label: `Real native coordinator attempt ${attempt} on the owned original heartbeat`, deadlineAt: Date.now() + 120_000,
      load: () => ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      accept: run => run.status === "running" && !!run.processPid && run.processPid !== previousPid,
      reject: run => run.nativePhase === "terminal_failure" ? "Native infrastructure became terminal before three real bounded attempts; this is not retry exhaustion" : undefined });
    const failed = await faultOwnedNativeProcess(ctx, { runId: active.id, issueId: task.id, agentId: state.worker.id });
    faults.push({ runId: failed.id, pid: failed.processPid, errorCode: failed.errorCode }); previousPid = active.processPid;
    await ctx.input.evidence(`runtime-infrastructure-attempt-${attempt}.json`, { runId: active.id, attempt, processPid: active.processPid, errorCode: failed.errorCode, status: failed.status, nativePhase: failed.nativePhase });
    if ((await ctx.allRuns()).length !== 1) throw new Error("Infrastructure setup created an undeclared replacement heartbeat instead of same-run coordinator recovery");
  }
  const result = await pollUntil({ label: "Actual exhausted source recovery action with no automatic wake", deadlineAt: Date.now() + 30_000,
    load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), run: await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      recovery: await ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${task.id}/recovery-actions`) }),
    accept: v => !!exhaustedSourceRecovery(v.recovery, v.task, v.run, ctx.input.fixtures.company.id, task.id, state.worker.id) });
  const recoveryBefore = exhaustedSourceRecovery(result.recovery, result.task, result.run, ctx.input.fixtures.company.id, task.id, state.worker.id)!;
  return { ...state, task: result.task, failure: result.run, recoveryBefore, setupFaults: faults };
}
export function gradeInfrastructureRecovery(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-infrastructure-and-source-action-evidence", !!o, "Three actual verified native Runner losses and the resulting public source-scoped recovery action are required."); if (!o) return c.result();
  const s = o.state, task = s.task as Issue, run = s.failure as NativeFaultRun, before = s.recoveryBefore as IssueRecoveryAction, after = s.recoveryAfter as IssueRecoveryAction;
  c.add("genuine-bounded-infrastructure-exhaustion", !!run && isExhaustedNativeRecovery(before, run, o.companyId, task.id, (s.worker as Entity).id)
    && Array.isArray(s.setupFaults) && s.setupFaults.length === 3 && new Set(s.setupFaults.map(row => (row as { pid: number }).pid)).size === 3
    && (s.setupFaults as Array<{ runId: string; errorCode: string }>).every(row => row.runId === run.id && NATIVE_INFRASTRUCTURE_FAULT_CODES.includes(row.errorCode)),
  "The actual original native run exhausts three coordinator attempts with real process loss evidence; model failure, cancellation or a fabricated attempt counter cannot qualify.");
  c.add("retained-source-owner-cause-and-next-action", !!after && after.id === before.id && after.sourceIssueId === task.id && after.recoveryIssueId == null
    && after.ownerType === "board" && after.cause === before.cause && after.nextAction === before.nextAction && after.evidence.runId === run.id
    && s.sourceRecoveryVisible === true && o.tasks.length === 1 && o.runs.length === 2
    && o.runs.find(row => row.id === run.id)?.status === "failed" && o.runs.filter(row => row.agentId === o.leadId).every(row => row.status === "succeeded"),
  "The original task retains its exact recovery action, responsible operator and failure; explanatory chat creates no duplicate repair chain or premature worker.");
  // Reply wording is not graded. The controller must have read the saved
  // recovery record, and the reply must link the original task where the
  // recovery lives. A person reads the reply for meaning.
  c.add("read-actual-recovery-record", s.queryRecoveryRead === true,
    "The controller's own run read the original task's saved recovery record or the failed run before answering.");
  c.add("links-original-task", linksSourceTask(o, s.task as Entity),
    "The reply links the original task that holds the recovery action, rather than a new repair task.");
  return c.result();
}
function infrastructureCase(id: "recovery.explain-stall" | "recovery.source-action") {
  return runtimeDefinition(id, exhaustedNativeInfrastructure, gradeInfrastructureRecovery, {
    oracleVersion: INFRASTRUCTURE_RECOVERY_ORACLE, expectedRunCount: 2, attemptTimeoutMs: 1_200_000,
    runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 1 } },
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-native-infrastructure-exhaustion", "original-source-action-owner"] },
    async verifySetup(ctx, state) { const c = checks(), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
      const run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`), task = state.task as Issue;
      const recovery = await ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${task.id}/recovery-actions`);
      const current = await ctx.input.api.get<Issue>(`/api/issues/${task.id}`);
      const action = exhaustedSourceRecovery(recovery, current, run, ctx.input.fixtures.company.id, task.id, (state.worker as Entity).id);
      c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual controller remains independently admitted.");
      c.add("real-native-infrastructure-exhaustion", !!action && action.id === (state.recoveryBefore as IssueRecoveryAction).id, "The saved native run really exhausted its own three attempts.");
      c.add("original-source-action-owner", action?.sourceIssueId === task.id && action.ownerType === "board" && action.recoveryIssueId == null, "The original task exposes the real operator-owned recovery without a separate repair task."); return c.result(); },
    sourceFiles: ["chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
    async act(ctx, state) {
      await pollUntil({ label: "Canonical source explanation while native infrastructure remains failed", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
        load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
        accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "failed") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
      const answered = await observeRuntime(ctx, state); state.queryReply = answered.reply;
      state.queryRecoveryRead = await controllerReadRecovery(ctx, answered.runs.find(row => row.agentId === ctx.input.fixtures.agent.id)?.id, (state.task as Issue).id, String(state.workerRunId), (state.task as Issue).identifier);
      const source = ctx.input.page.url(), task = state.task as Issue;
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible();
      await expect(ctx.input.page.getByText(/recovery|retry|failed|interrupted/i).first()).toBeVisible(); state.sourceRecoveryVisible = true;
      await ctx.input.capture("actual-exhausted-source-recovery", "Original Website retains actual exhausted native infrastructure and operator recovery", "runtime-infrastructure-recovery.png");
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async observe(ctx, state) { const recovery = await ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${(state.task as Entity).id}/recovery-actions`);
      // A newer action on the source task would be a second repair chain.
      const before = (state.recoveryBefore as IssueRecoveryAction).id, latest = recovery.active ?? newest(recovery.actions ?? []);
      state.recoveryAfter = latest?.id === before ? sameRecoveryAction(recovery, before) : latest; return observeRuntime(ctx, state); },
    async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Issue;
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
    cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
  });
}
export const runtimeInfrastructureCases = [infrastructureCase("recovery.explain-stall"), infrastructureCase("recovery.source-action")];
