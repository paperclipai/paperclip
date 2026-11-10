import { kimiContextRendezvousPrompt, pendingKimiContextPermission, publishKimiContextContinuation, approveKimiContextThroughUi, readKimiContextProof, type KimiContextProof } from "./kimi-context-rendezvous.js";
import { kimiPendingWritePermissionCard } from "./kimi-permission-card.js";
import { createKimiContextCheckpointObserver } from "./kimi-context-checkpoint.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { waitForEvalAgentReady } from "./budgeted-setup.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { createDeniedTargetFixture, exists, observeRunProcesses } from "./native-local-fixtures.js";
import { assertNativeRemoteRetirement, nativeRemoteDeniedSample, prepareNativeRemoteAction, type NativeRemoteSnapshot } from "./native-remote-evidence.js";
import type { RemoteNativeBootstrap } from "./remote-native-bootstrap.js";
import type { RemoteNativeFixture } from "./remote-native-fixtures.js";
import { readActiveStopCaller, type ActiveStopCaller } from "./native-active-stop-evidence.js";
import { assertSameKimiPending, observeKimiLifecyclePending, readKimiLifecycleSettlement, type KimiLifecyclePending, type KimiLifecycleScope, type KimiLifecycleState } from "./kimi-lifecycle-evidence.js";
import { terminateKimiLocalProvider } from "./kimi-local-provider-fault.js";
import { kimiLifecycleTasks } from "./kimi-lifecycle-tasks.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
export async function dispatchKimiLifecycleAction(input: {
  scope: KimiLifecycleScope; branch: "stop" | "loss"; caller: ActiveStopCaller; deadlineAt: number;
  load(): Promise<KimiLifecycleState>; retain(value: KimiLifecyclePending): Promise<void>;
  act(pending: KimiLifecyclePending, cancellationRequestId: string): Promise<unknown>;
}) {
  const pending = observeKimiLifecyclePending({ ...await input.load(), scope: input.scope });
  await input.retain(pending);
  assertSameKimiPending(pending, observeKimiLifecyclePending({ ...await input.load(), scope: input.scope }));
  if (Date.now() >= input.deadlineAt) throw new Error("Kimi native lifecycle: pending action deadline expired");
  const cancellationRequestId = randomUUID(), dispatchMonotonicNs = process.hrtime.bigint().toString();
  const actionReceipt = await input.act(pending, cancellationRequestId);
  const binding = { pending, branch: input.branch, caller: input.caller, cancellationRequestId, dispatchMonotonicNs };
  const state = await pollUntil({ label: `Kimi pending native Write ${input.branch} settlement`, deadlineAt: input.deadlineAt, intervalMs: 200,
    load: input.load, reject: value => ["succeeded", "timed_out", input.branch === "stop" ? "failed" : "cancelled"].includes(value.run.status) ? "Unexpected native lifecycle terminal" : undefined,
    accept: value => { readKimiLifecycleSettlement({ ...value, ...binding }); return true; } });
  return { ...binding, actionReceipt, settlement: readKimiLifecycleSettlement({ ...state, ...binding }) };
}

export async function runKimiLifecycleFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: RemoteNativeBootstrap;
  registerCleanupAssertion(callback: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, execution, fixtures, nonce } = input;
  if (execution.suite.id !== "kimi-qualification" || execution.profile.qualificationCandidate !== "kimi"
    || !kimiLifecycleTasks.some(task => task.id === execution.task.id)) throw new Error("Unknown Kimi native lifecycle task");
  const branch = execution.task.id === "native-write-permission-stop" ? "stop" : "loss", remote = execution.environment.id === "daytona";
  if ((!remote && execution.environment.id !== "local") || remote && !input.remoteBootstrap) throw new Error("Kimi lifecycle requires its admitted isolated environment");
  const checks: Check[] = [], samples: Array<{ phase: string; absent: boolean }> = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const name = `kimi-${branch}-${nonce}.txt`, local = remote ? undefined : await createDeniedTargetFixture(input.workspacePath, name), target = local?.targetRelativePath ?? name;
  const observer = remote ? undefined : observeRunProcesses();
  let issue: Row = {}, runs: Row[] = [], events: Row[] = [], processIdentity: string | undefined, processError = false;
  let processes: ReturnType<ReturnType<typeof observeRunProcesses>["sample"]> = { captured: false, journal: [], live: [] };
  let fixture: RemoteNativeFixture | undefined, baseline: NativeRemoteSnapshot | undefined, pendingSnapshot: NativeRemoteSnapshot | undefined, sealed: NativeRemoteSnapshot | undefined;
  let completed: Awaited<ReturnType<typeof dispatchKimiLifecycleAction>> | undefined;
  let contextProof: KimiContextProof | undefined, publishedAction: string | undefined;
  const authority = () => { const run = runs[0]!; return { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id }; };
  const observeProcesses = () => {
    if (!observer || !runs[0]?.processPid) return;
    const value = authority(), identity = JSON.stringify(value);
    if (processIdentity && processIdentity !== identity) processError = true;
    processIdentity ??= identity; processes = observer.sample(value);
  };
  const load = async (): Promise<KimiLifecycleState> => {
    if (issue.id) issue = await api.get(`/api/issues/${issue.id}`);
    const list = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(list.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    if (runs.length > 1) throw new Error("Kimi native lifecycle dispatched an extra run");
    events = runs[0] ? await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : [];
    observeProcesses(); input.observe(issue, runs); return { issue, run: runs[0] ?? {}, events };
  };
  const scope = (): KimiLifecycleScope => ({ companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id, target, ...(fixture ? { actionFile: fixture.actionFile } : {}), ...(contextProof ? { contextProof } : {}) });
  const sample = async (phase: string) => {
    const absent = !await exists(local!.targetPath); samples.push({ phase, absent }); check(`no-effect-${phase}`, absent, "Exact unapproved Write target remains absent");
  };
  const timer = observer ? setInterval(() => { try { observeProcesses(); } catch { processError = true; } }, 100) : undefined;
  (remote ? input.registerBeforeEnvironmentTeardownAssertion : input.registerCleanupAssertion)(async () => {
    const receipts: Check[] = [];
    try {
      await load();
      if (!completed) throw new Error("Kimi native lifecycle settlement was not established");
      if (remote) {
        if (!fixture || !baseline || !pendingSnapshot) throw new Error("Kimi remote watcher was not armed before the native action");
        sealed ??= await fixture.finish(); assertNativeRemoteRetirement(sealed, baseline); assertNativeRemoteRetirement(sealed, pendingSnapshot);
        for (const snapshot of [baseline, pendingSnapshot, sealed]) if (nativeRemoteDeniedSample(snapshot, baseline, target, "terminal").exists) throw new Error("Kimi native Write had a remote file effect");
        if (!(BigInt(baseline.observedMonotonicNs) < BigInt(pendingSnapshot.observedMonotonicNs) && BigInt(pendingSnapshot.observedMonotonicNs) < BigInt(sealed.observedMonotonicNs))) throw new Error("Kimi remote causal samples were reused or reordered");
        for (const snapshot of [baseline, pendingSnapshot]) if (!snapshot.processes.journal.every(p => sealed!.processes.journal.some(q => p.pid === q.pid && p.startTicks === q.startTicks && p.bootId === q.bootId))) throw new Error("Kimi remote process journal lost a native descendant");
      } else {
        await pollUntil({ label: "Kimi native owned process retirement", deadlineAt: Date.now() + 5000, intervalMs: 100,
          load: async () => { observeProcesses(); return processes; }, accept: value => value.captured && value.live.length === 0 });
        await sample("after-cleanup");
        const watcher = local!.watcher.finish();
        if (processError || !watcher.complete || watcher.targetMutationCount !== 0 || samples.map(row => row.phase).join(",") !== "before-request,pending,terminal,after-cleanup" || !samples.every(row => row.absent)) throw new Error("Kimi local physical retirement or continuous no-effects proof is incomplete");
      }
      readKimiLifecycleSettlement({ ...await load(), ...completed });
      receipts.push({ id: "native-worker-retired-without-effects", passed: true, detail: remote ? "Exact owned run tree retired with continuous remote no-effects coverage through its retirement seal" : "Exact owned run tree retired and watched target remained absent through cleanup" });
      return receipts;
    } finally {
      if (timer) clearInterval(timer);
      try { await input.evidence("kimi-native-lifecycle-cleanup.json", { processes, processError, samples, baseline, pendingSnapshot, sealed, watcher: local?.watcher.finish(), receipts }); }
      finally { await fixture?.close(); }
    }
  });
  const prompt = () => `${execution.task.buildPrompt(nonce)}\nThe exact absolute native Write path is ${remote ? join(fixture!.remoteCwd, target) : local!.targetPath}.`;
  try {
    const caller = readActiveStopCaller(await api.get("/api/health"), await api.get("/api/auth/get-session"));
    await waitForEvalAgentReady({ environmentId: execution.environment.id, agentId: fixtures.agent.id, companyId: fixtures.company.id,
      deadlineAt: input.deadlineAt, api, observe: observations => input.evidence("kimi-lifecycle-agent-ready.json", { observations }) });
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", lifecycleMode: "per_turn", timeoutSec: 120 } });
    check("per-turn-native-policy", configured.adapterConfig?.acpxPermissionMode === "approve-reads" && configured.adapterConfig?.lifecycleMode === "per_turn", "Restrictive native permission policy and per-turn ownership selected before dispatch");
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, { name: `Kimi native lifecycle ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } }, workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true } });
    if (!remote) await sample("before-request");
    if (remote) input.remoteBootstrap!.prompt(nonce);
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce),
      prompt: remote ? kimiContextRendezvousPrompt() : prompt(), workMode: "standard", projectName: project.name, requireExplicitTitle: true });
    issue = (await pollUntil({ label: "browser-created Kimi lifecycle task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.id === created.issueId), accept: Boolean }))!;
    if (remote) {
      await pollUntil({ label: "Kimi native remote bootstrap", deadlineAt: input.deadlineAt, load, accept: value => value.run.status === "running" });
      const bound = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id, targets: [target], actionPrompt: async value => {
        fixture = value;
        const prepared = await prepareNativeRemoteAction({ fixture: value, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id, target, prompt: prompt() });
        baseline = prepared.baseline; publishedAction = prepared.prompt; await input.evidence("kimi-native-before-action-remote.json", baseline); return prepared.prompt;
      } });
      if (bound !== fixture) throw new Error("Kimi native action publication changed its fixture identity");
      const contextScope = { companyId: fixtures.company.id, agentId: fixtures.agent.id, environmentId: fixtures.environment.id, issueId: issue.id, runId: runs[0]!.id };
      const pending = await pollUntil({ label: "exact scoped Kimi context permission", deadlineAt: input.deadlineAt, intervalMs: 200,
        load: async () => pendingKimiContextPermission((await load()).events, contextScope), accept: Boolean });
      if (!pending || publishedAction === undefined) throw new Error("Kimi context rendezvous lacks its exact action publication");
      const publication = await publishKimiContextContinuation({ pending, action: publishedAction, fixture: fixture!, api });
      await input.evidence("kimi-context-publication.json", publication);
      await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
      const contextObserver = await createKimiContextCheckpointObserver(publication);
      try {
        await approveKimiContextThroughUi({ page, publication, load, evidence: input.evidence });
        contextProof = await pollUntil({ label: "delivered scoped Kimi context result", deadlineAt: input.deadlineAt, intervalMs: 200,
          load: async () => {
            const state = await load(), authority = await contextObserver.read();
            return readKimiContextProof(state.events, publication, authority);
          }, accept: Boolean });
      } finally { await contextObserver.close(); }
      if (!contextProof) throw new Error("Kimi context rendezvous result was not delivered");
      await input.evidence("kimi-context-delivered-proof.json", contextProof);
    }
    const pendingState = await pollUntil({ label: "unanswered actual Kimi Write permission", deadlineAt: input.deadlineAt, intervalMs: 200, load,
      reject: value => ["succeeded", "failed", "cancelled", "timed_out"].includes(value.run.status) ? "Provider ended before actual native Write approval" : undefined,
      accept: value => { observeKimiLifecyclePending({ ...value, scope: scope() }); return true; } });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const card = await kimiPendingWritePermissionCard({ page,
      pending: observeKimiLifecyclePending({ ...pendingState, scope: scope() }),
      readPending: async () => observeKimiLifecyclePending({ ...await load(), scope: scope() }),
    });
    await input.capture("kimi-native-write-pending", "Actual native Kimi Write permission remains unanswered", "tool-review-pending.png");
    if (remote) {
      pendingSnapshot = await fixture!.snapshot("pending-native-write");
      check("remote-pending-no-effect", !nativeRemoteDeniedSample(pendingSnapshot, baseline!, target, "pending").exists, "Remote native Write is pending without an effect");
      await input.evidence("kimi-native-pending-remote.json", pendingSnapshot);
    } else await sample("pending");
    completed = await dispatchKimiLifecycleAction({ scope: scope(), branch, caller, deadlineAt: input.deadlineAt, load,
      retain: value => input.evidence("kimi-native-write-pending.json", value), act: async (_pending, cancellationRequestId) => {
        if (branch === "stop") {
          const response = await api.post<Row>(`/api/heartbeat-runs/${runs[0]!.id}/cancel`, { cancellationRequestId });
          if (response.id !== runs[0]!.id || response.resultJson?.nativeCancellation?.intentId !== `native-cancellation:${cancellationRequestId}`) throw new Error("Kimi Stop response names a foreign intent");
          return { intentId: response.resultJson.nativeCancellation.intentId };
        }
        if (remote) {
          const run = runs[0]!, workspace = run.contextSnapshot?.executionWorkspaceId;
          if (typeof workspace !== "string" || run.runnerProfileJson?.nativeExecutionInput?.binding?.executionWorkspaceId !== workspace
            || run.contextSnapshot?.paperclipEnvironment?.leaseId !== fixture!.binding.leaseId || fixture!.baseline.scope.observedPrpEnvironmentLeaseId !== workspace
            || !fixture!.terminateKimiProvider) throw new Error("Kimi fault lacks exact public run/workspace/lease authority");
          return fixture!.terminateKimiProvider(workspace);
        }
        if (!processes.captured) throw new Error("Kimi local fault lacks an observed native tree");
        return terminateKimiLocalProvider({ authority: authority(), journal: processes.journal, workspacePath: input.workspacePath });
      } });
    check("original-pending-callback-settled", true, branch === "stop" ? "Caller-owned Stop cancelled the unanswered native callback" : "Exact spontaneous native worker loss expired the unanswered callback and failed the original run");
    await input.evidence("kimi-native-write-settlement.json", completed);
    const stale = await api.request.post(`/api/heartbeat-runs/${runs[0]!.id}/runtime-requests/${encodeURIComponent(completed.pending.requestId)}/resolve`, {
      data: { turnId: completed.pending.turnId, requestKind: "permission_approval", resolution: { action: "accept" } },
    });
    check("stale-allow-refused", stale.status() === 409, "A late Allow cannot revive the ended provider or replay its Write");
    if (remote) { sealed = await fixture!.finish(); assertNativeRemoteRetirement(sealed, baseline!); await input.evidence("kimi-native-retirement-remote.json", sealed); }
    else await sample("terminal");
    await page.reload();
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: `Change status (current: ${branch === "stop" ? "In Progress" : "Blocked"}`, exact: false })).toBeVisible();
    const thread = page.getByTestId("task-chat-thread");
    await expect(thread.getByTestId("task-chat-turn-summary").getByText(/^Stopped(?: for .+)?$/)).toBeVisible();
    await expect(card.getByText(`Change file: ${target}`, { exact: true })).toBeVisible();
    await expect(card.getByText(branch === "stop" ? "cancelled" : "expired", { exact: true })).toBeVisible();
    await expect(thread.getByTestId("task-chat-current-activity")).toHaveCount(0);
    await expect(thread.getByTestId("task-chat-live-turn")).toHaveCount(0);
    await expect(thread.getByTestId("task-chat-live-run-pill")).toHaveCount(0);
    await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    readKimiLifecycleSettlement({ ...await load(), ...completed });
    check("no-replacement-run-or-false-completion", runs.length === 1 && issue.status === (branch === "stop" ? "in_progress" : "blocked"), "One unfinished task retains the original terminal; no automatic follow-up or completed mutation");
    await input.capture("final-state", "Ended native Write is no longer answerable", "final-state.png");
    await input.evidence("api-state.json", { issue, run: runs[0], runs, runEvents: events, runEventsByRun: [{ runId: runs[0]!.id, events }], checks, completed });
    return { issue, runs, checks };
  } finally { await input.evidence("kimi-native-lifecycle-checks.json", { issue, runs, samples, checks, completed }); }
}
