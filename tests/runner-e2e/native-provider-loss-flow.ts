import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { createDeniedTargetFixture, exists, observeRunProcesses, injectObservedRunLoss } from "./native-local-fixtures.js";
import { assertNativeRemoteRetirement, nativeRemoteDeniedSample, prepareNativeRemoteAction, type NativeRemoteBootstrap, type NativeRemoteFixture, type NativeRemoteSnapshot } from "./native-remote-evidence.js";
import { cursorDeniedCommand } from "./cursor-native-evidence.js";
import { readActiveStopCaller, observeActiveStopPending, type ActiveStopPending, type ActiveStopScope } from "./native-active-stop-evidence.js";
import type { BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };

/** Transport loss must never turn an unanswered native mutation into success. */
export function assertProviderLossSettlement(run: Row, issue: Row, events: readonly Row[], pending: ActiveStopPending) {
  const fail = (ok: boolean, reason: string) => { if (!ok) throw new Error(`Native provider loss: ${reason}`); };
  fail(run.id === pending.scope.runId && run.companyId === pending.scope.companyId && run.nativeIssueId === pending.scope.issueId
    && run.status === "failed" && run.runtimeMode === "native" && typeof run.error === "string" && run.error.length > 0
    && issue.id === pending.scope.issueId && issue.companyId === pending.scope.companyId && issue.status === "blocked"
    && run.resultJson?.nativeCancellation == null, "failure must leave the task open without claiming Stop or success");
  const frames = events.flatMap(row => row.payload?.prpEvent ? [row.payload.prpEvent] : []);
  const closures = frames.filter(frame => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(frame.eventType)
    && frame.payload?.requestId === pending.requestId);
  fail(closures.length === 1 && ["runtime_request.cancelled", "runtime_request.expired"].includes(closures[0].eventType)
    && closures[0].payload.turnId === pending.turnId && closures[0].payload.requestKind === "permission_approval"
    && closures[0].payload.action === undefined && closures[0].payload.response === undefined && closures[0].payload.replayAllowed !== true,
    "undeliverable permission must close without acceptance or replay");
  fail(!frames.some(frame => frame.eventType === "turn.completed" || frame.eventType === "completion.accepted"
    || frame.eventType === "tool.execution.completed" && frame.payload?.executionId === bootstrapReadExecutionId(pending.toolCallId)
      && frame.payload?.status === "completed"), "no completion or completed mutation after loss");
  return { schema: "paperclip.e2e.native-provider-loss.v1", requestId: pending.requestId, turnId: pending.turnId,
    requestClosure: closures[0].eventType, taskStillOpen: true, failedRun: true, replayAllowed: false };
}

export async function runNativeProviderLossFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: NativeRemoteBootstrap;
  registerCleanupAssertion(callback: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, fixtures, execution, nonce } = input;
  if (execution.profile.qualificationCandidate !== "cursor" || execution.task.id !== "pending-permission-provider-loss") throw new Error("Unknown provider-loss case");
  const remote = execution.environment.id === "daytona";
  if (remote && !input.remoteBootstrap) throw new Error("Provider loss requires its admitted remote observer");
  const local = remote ? undefined : await createDeniedTargetFixture(input.workspacePath, `provider-loss-${nonce}.txt`);
  const target = local?.targetRelativePath ?? `provider-loss-${nonce}.txt`;
  let command = local ? cursorDeniedCommand(local.targetPath) : undefined;
  const observer = remote ? undefined : observeRunProcesses();
  let issue: Row = {}, runs: Row[] = [], events: Row[] = [];
  let fixture: NativeRemoteFixture | undefined, baseline: NativeRemoteSnapshot | undefined, sealed: NativeRemoteSnapshot | undefined;
  let processes: ReturnType<ReturnType<typeof observeRunProcesses>["sample"]> | undefined;
  let pending: ActiveStopPending | undefined, settled = false;
  const checks: Check[] = [], samples: Array<{ phase: string; absent: boolean }> = [];
  const check = (id: string, ok: boolean, detail: string) => { checks.push({ id, passed: ok, detail }); expect(ok, detail).toBe(true); };
  const scope = (): ActiveStopScope => ({ provider: "cursor", companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id, target, commandSha256: command!.commandSha256 });
  const bootstrap = (): BootstrapReadProof | undefined => fixture ? { actionFile: fixture.actionFile, events } : undefined;
  const authority = () => { const run = runs[0]!; return { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id }; };
  const load = async () => {
    if (issue.id) issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const list = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(list.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    if (runs.length > 1) throw new Error("Provider loss automatically dispatched another run");
    events = runs[0] ? await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : [];
    if (observer && runs[0]?.processPid) processes = observer.sample(authority());
    input.observe(issue, runs); return { run: runs[0] ?? {}, issue, events };
  };
  const sample = async (phase: string) => {
    const absent = !await exists(local!.targetPath); samples.push({ phase, absent }); check(`no-effect-${phase}`, absent, "The exact unapproved target stays absent");
  };
  const cleanup = async () => {
    const receipts: Check[] = [];
    try {
      if (remote) {
        if (!fixture || !baseline) throw new Error("Provider-loss observer was not armed");
        sealed ??= await fixture.finish(); assertNativeRemoteRetirement(sealed, baseline);
        nativeRemoteDeniedSample(sealed, baseline, target, "after-cleanup");
      } else {
        await pollUntil({ label: "lost run's owned processes retire", deadlineAt: Date.now() + 5000, intervalMs: 100,
          load: async () => { await load(); return processes; }, accept: value => Boolean(value?.captured && value.live.length === 0) });
        await sample("after-cleanup"); const watch = local!.watcher.finish();
        if (!watch.complete || watch.targetMutationCount !== 0 || samples.length !== 4 || !samples.every(row => row.absent)) throw new Error("Provider-loss continuous no-effects evidence is incomplete");
      }
      await load(); if (!settled || !pending) throw new Error("Provider-loss settlement was not established");
      assertProviderLossSettlement(runs[0]!, issue, events, pending);
      receipts.push({ id: "provider-loss-retired-no-replay", passed: true, detail: "Owned run and provider processes retired; pending mutation closed without replay or effects" });
      return receipts;
    } finally {
      await input.evidence("native-provider-loss-cleanup.json", { processes, samples, sealed, receipts });
      await fixture?.close();
    }
  };
  (remote ? input.registerBeforeEnvironmentTeardownAssertion : input.registerCleanupAssertion)(cleanup);
  const prompt = () => `${execution.task.buildPrompt(nonce)}\nUse this exact native shell command once:\n${command!.command}`;
  try {
    const caller = readActiveStopCaller(await api.get("/api/health"), await api.get("/api/auth/get-session"));
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    await api.patch(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", acpxSessionMode: "agent", timeoutSec: 120, lifecycleMode: "per_turn" } });
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, { name: `Native provider loss ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } }, workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true } });
    if (!remote) await sample("before-request");
    const createdTask = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: remote ? input.remoteBootstrap!.prompt(nonce) : prompt(), workMode: "standard", projectName: project.name, requireExplicitTitle: true });
    issue = (await pollUntil({ label: "browser-created provider-loss task", deadlineAt: input.deadlineAt,
      load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.id === createdTask.issueId), accept: Boolean }))!;
    if (remote) {
      await pollUntil({ label: "provider-loss bootstrap", deadlineAt: input.deadlineAt, load, accept: value => value.run.status === "running" });
      fixture = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id, targets: [target], actionPrompt: async value => {
        fixture = value; command = cursorDeniedCommand(join(value.remoteCwd, target));
        const prepared = await prepareNativeRemoteAction({ fixture: value, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id, target, prompt: prompt() });
        baseline = prepared.baseline; await input.evidence("provider-loss-baseline.json", baseline); return prepared.prompt;
      } });
    }
    await pollUntil({ label: "unanswered native permission before loss", deadlineAt: input.deadlineAt, intervalMs: 200, load,
      accept: value => { pending = observeActiveStopPending({ ...value, scope: scope(), caller, cancellationRequestId: randomUUID(), bootstrap: bootstrap() }); return true; } });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true });
    await expect(card).toHaveCount(1); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
    await input.capture("pending-before-loss", "Unanswered native mutation before runtime loss", "pending-before-loss.png");
    await input.evidence("provider-loss-pending.json", pending);
    if (remote) {
      const snap = await fixture!.snapshot("pending-before-loss"); nativeRemoteDeniedSample(snap, baseline!, target, "pending");
      await input.evidence("provider-loss-pending-remote.json", snap);
      if (!fixture!.injectOwnedRunLoss) throw new Error("Remote observer cannot inject an owned loss");
      await input.evidence("provider-loss-injection.json", await fixture!.injectOwnedRunLoss());
    } else {
      await sample("pending"); await load();
      if (!processes?.captured) throw new Error("Local run ownership was not observed");
      await input.evidence("provider-loss-injection.json", injectObservedRunLoss(authority(), processes.journal));
    }
    await pollUntil({ label: "failed run after owned transport loss", deadlineAt: input.deadlineAt, intervalMs: 200, load,
      accept: value => { if (["succeeded", "cancelled"].includes(value.run.status)) throw new Error("Provider loss falsely succeeded or became Stop"); return value.run.status === "failed"; } });
    const settlement = assertProviderLossSettlement(runs[0]!, issue, events, pending!); settled = true;
    const response = await api.request.post(`/api/heartbeat-runs/${runs[0]!.id}/runtime-requests/${encodeURIComponent(pending!.requestId)}/resolve`,
      { data: { turnId: pending!.turnId, requestKind: "permission_approval", resolution: { action: "accept" } } });
    check("stale-acceptance-refused", response.status() === 409, "An approval cannot revive the lost provider or replay its mutation");
    if (remote) { sealed = await fixture!.finish(); assertNativeRemoteRetirement(sealed, baseline!); nativeRemoteDeniedSample(sealed, baseline!, target, "terminal"); }
    else await sample("after-loss");
    await page.reload();
    await expect(page.getByTestId("task-chat-thread").getByTestId("task-chat-collapsible-marker").filter({ has: page.getByText("Run failed", { exact: true }) })).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await load(); assertProviderLossSettlement(runs[0]!, issue, events, pending!);
    check("one-unfinished-failed-run", runs.length === 1 && issue.status === "blocked", "A visible blocked task owns the failure; no automatic mutation replay or false completion");
    await input.capture("final-state", "Lost runtime fails clearly and leaves the task open", "final-state.png");
    await input.evidence("api-state.json", { issue, runs, checks, settlement, runEvents: events, runEventsByRun: [{ runId: runs[0]!.id, events }] });
    return { issue, runs, checks };
  } finally { await input.evidence("provider-loss-checks.json", { issue, runs, checks, samples, settled }); }
}
