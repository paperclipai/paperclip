import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { Issue, IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { checks, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { faultOwnedNativeProcess, type NativeFaultRun } from "./runtime-native-fault.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
export function isExhaustedNativeRecovery(action: IssueRecoveryAction | undefined, run: NativeFaultRun, companyId: string, issueId: string, agentId: string) {
  return !!action && action.companyId === companyId && action.sourceIssueId === issueId && action.kind === "active_run_watchdog" && action.cause === "native_session_retry_exhausted"
    && action.ownerType === "board" && action.ownerAgentId == null && action.returnOwnerAgentId === agentId && action.recoveryIssueId == null
    && action.evidence.runId === run.id && action.evidence.coordinatorAttempt === 3 && action.evidence.recoveryDisposition === "native_session_retry_exhausted"
    && action.maxAttempts === 3 && action.wakePolicy == null && action.nextAction.trim().length > 0 && run.status === "failed" && run.nativePhase === "terminal_failure";
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
      recovery: await ctx.input.api.get<{ active?: IssueRecoveryAction; actions: IssueRecoveryAction[] }>(`/api/issues/${task.id}/recovery-actions`) }),
    accept: v => v.task.status === "blocked" && isExhaustedNativeRecovery(v.recovery.active, v.run, ctx.input.fixtures.company.id, task.id, state.worker.id) });
  return { ...state, task: result.task, failure: result.run, recoveryBefore: result.recovery.active!, setupFaults: faults };
}
export function gradeInfrastructureRecovery(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("real-infrastructure-and-source-action-evidence", !!o, "Three actual verified native Runner losses and the resulting public source-scoped recovery action are required."); if (!o) return c.result();
  const s = o.state, task = s.task as Issue, run = s.failure as NativeFaultRun, before = s.recoveryBefore as IssueRecoveryAction, after = s.recoveryAfter as IssueRecoveryAction;
  c.add("genuine-bounded-infrastructure-exhaustion", !!run && isExhaustedNativeRecovery(before, run, o.companyId, task.id, (s.worker as Entity).id)
    && Array.isArray(s.setupFaults) && s.setupFaults.length === 3 && new Set(s.setupFaults.map(row => (row as { pid: number }).pid)).size === 3
    && (s.setupFaults as Array<{ runId: string; errorCode: string }>).every(row => row.runId === run.id && ["native_runner_process_exited", "provider_transport_failed", "provider_stdout_closed", "provider_process_output_closed", "native_session_cleanup_quarantined"].includes(row.errorCode)),
  "The actual original native run exhausts three coordinator attempts with real process loss evidence; model failure, cancellation or a fabricated attempt counter cannot qualify.");
  c.add("retained-source-owner-cause-and-next-action", !!after && after.id === before.id && after.sourceIssueId === task.id && after.recoveryIssueId == null
    && after.ownerType === "board" && after.cause === before.cause && after.nextAction === before.nextAction && after.evidence.runId === run.id
    && s.sourceRecoveryVisible === true && o.tasks.length === 1 && o.runs.length === 2
    && o.runs.find(row => row.id === run.id)?.status === "failed" && o.runs.filter(row => row.agentId === o.leadId).every(row => row.status === "succeeded"),
  "The original task retains its exact recovery action, responsible operator and failure; explanatory chat creates no duplicate repair chain or premature worker.");
  const reply = String(s.queryReply ?? o.reply);
  c.add("concrete-honest-operator-next-step", /website|Launch/i.test(reply) && /operator|human|board|you (?:can|need|must|should)/i.test(reply)
    && /retry|inspect|provider trace|configuration|reconcile|recovery action|run details/i.test(reply)
    && !/website (?:is|has been) (?:now )?(?:done|complete|finished)|successfully (?:recovered|repaired)|I (?:created|opened).{0,30}repair task/i.test(reply),
  "The actual controller reply identifies the responsible supported next step and preserves failure instead of calling a filed repair or queued retry success.");
  if (o.scenarioId === "recovery.explain-stall") {
    c.add("recorded-infrastructure-cause-and-actual-attempt-count", /runner|process|native session|infrastructure/i.test(reply) && /exhaust|attempt|retr(?:y|ies)|resume/i.test(reply)
      && /\b3\b|\bthree\b/i.test(reply) && !/(?:stopped|blocked) (?:because|due to).{0,35}(?:budget|missing (?:brief|input)|you (?:paused|stopped))/i.test(reply),
    "Diagnosis uses the real exhausted native infrastructure evidence and three attempts, distinguishing it from invented budget, input or deliberate-stop causes.");
  } else c.add("source-recovery-action-identified", reply.includes(before.id) || /(?:source|original|same|website).{0,60}(?:recovery|repair|retry|action)|(?:recovery|repair).{0,60}(?:source|original|same|website)/i.test(reply),
    "The response identifies the recovery on the actual original task; no independent repair issue is invented where ordinary harness/operator recovery is sufficient.");
  return c.result();
}
function infrastructureCase(id: "recovery.explain-stall" | "recovery.source-action") {
  return runtimeDefinition(id, exhaustedNativeInfrastructure, gradeInfrastructureRecovery, {
    expectedRunCount: 2, attemptTimeoutMs: 1_200_000,
    runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 1 } },
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-native-infrastructure-exhaustion", "original-source-action-owner"] },
    async verifySetup(ctx, state) { const c = checks(), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
      const run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`), task = state.task as Issue;
      const recovery = await ctx.input.api.get<{ active?: IssueRecoveryAction }>(`/api/issues/${task.id}/recovery-actions`);
      c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual controller remains independently admitted.");
      c.add("real-native-infrastructure-exhaustion", isExhaustedNativeRecovery(recovery.active, run, ctx.input.fixtures.company.id, task.id, (state.worker as Entity).id), "The saved native run really exhausted its own three attempts.");
      c.add("original-source-action-owner", recovery.active?.sourceIssueId === task.id && recovery.active.ownerType === "board" && recovery.active.recoveryIssueId == null, "The original task exposes the real operator-owned recovery without a separate repair task."); return c.result(); },
    sourceFiles: ["chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
    async act(ctx, state) {
      await pollUntil({ label: "Canonical source explanation while native infrastructure remains failed", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
        load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
        accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "failed") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
      state.queryReply = (await observeRuntime(ctx, state)).reply;
      const source = ctx.input.page.url(), task = state.task as Issue;
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible();
      await expect(ctx.input.page.getByText(/recovery|retry|failed|interrupted/i).first()).toBeVisible(); state.sourceRecoveryVisible = true;
      await ctx.input.capture("actual-exhausted-source-recovery", "Original Website retains actual exhausted native infrastructure and operator recovery", "runtime-infrastructure-recovery.png");
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async observe(ctx, state) { const recovery = await ctx.input.api.get<{ active?: IssueRecoveryAction }>(`/api/issues/${(state.task as Entity).id}/recovery-actions`); state.recoveryAfter = recovery.active; return observeRuntime(ctx, state); },
    async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Issue;
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByRole("heading", { name: task.title, exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
    cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
  });
}
export const runtimeInfrastructureCases = [infrastructureCase("recovery.explain-stall"), infrastructureCase("recovery.source-action")];
