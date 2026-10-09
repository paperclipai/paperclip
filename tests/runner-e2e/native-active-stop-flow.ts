import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { createDeniedTargetFixture, exists, observeRunProcesses } from "./native-local-fixtures.js";
import { assertNativeRemoteRetirement, nativeRemoteDeniedSample, prepareNativeRemoteAction, type NativeRemoteBootstrap, type NativeRemoteFixture, type NativeRemoteSnapshot } from "./native-remote-evidence.js";
import { cursorDeniedCommand } from "./cursor-native-evidence.js";
import { assertActiveStopRetirement, readActiveStopCaller, observeActiveStopPending, readActiveStopSettlement, type ActiveStopRemoteObservation, type ActiveStopCaller, type ActiveStopPending, type ActiveStopScope } from "./native-active-stop-evidence.js";
import type { BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
export interface ActiveStopState { run: Row; issue: Row; events: readonly unknown[] }
/** Retain a real pending API observation before the only mutating request.
 * Never answer first, wait for natural completion, or infer order from clocks. */
export async function stopAtPendingPermission(input: {
  scope: ActiveStopScope; caller: ActiveStopCaller; bootstrap?: BootstrapReadProof; deadlineAt: number;
  load(): Promise<ActiveStopState>;
  retain(receipt: ActiveStopPending): Promise<void>;
  stop(runId: string, cancellationRequestId: string): Promise<Row>;
}) {
  const cancellationRequestId = randomUUID();
  const state = await input.load();
  const pending = observeActiveStopPending({ ...state, scope: input.scope, caller: input.caller, cancellationRequestId, bootstrap: input.bootstrap });
  await input.retain(pending);
  const fresh = observeActiveStopPending({ ...await input.load(), scope: input.scope, caller: input.caller, cancellationRequestId, bootstrap: input.bootstrap });
  if (fresh.requestRowSha256 !== pending.requestRowSha256 || fresh.permissionRowSha256 !== pending.permissionRowSha256
    || fresh.toolOriginRowSha256 !== pending.toolOriginRowSha256 || fresh.toolStartedRowSha256 !== pending.toolStartedRowSha256
    || Date.now() >= input.deadlineAt) throw new Error("Native active Stop pending boundary changed or expired");
  const dispatchMonotonicNs = process.hrtime.bigint().toString();
  const stopped = await input.stop(input.scope.runId, cancellationRequestId);
  if (stopped.id !== input.scope.runId || stopped.resultJson?.nativeCancellation?.intentId !== `native-cancellation:${cancellationRequestId}`) throw new Error("Native active Stop response has a foreign intent");
  const label = "cancelled unanswered native permission";
  const final = await pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 200, load: async () => {
    const value = await input.load();
    if (["succeeded", "failed", "timed_out"].includes(value.run.status)) throw new Error(`Stopped waiting for ${label}: unexpected run terminal`);
    return value;
  }, accept: value => { readActiveStopSettlement({ ...value, pending, dispatchMonotonicNs, bootstrap: input.bootstrap }); return true; } });
  return { pending, dispatchMonotonicNs, settlement: readActiveStopSettlement({ ...final, pending, dispatchMonotonicNs, bootstrap: input.bootstrap }) };
}
export async function runNativeActiveStopFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: NativeRemoteBootstrap;
  registerCleanupAssertion(callback: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, fixtures, execution, nonce } = input, provider = execution.profile.qualificationCandidate;
  if (provider !== "cursor" || execution.task.id !== "pending-permission-stop") throw new Error("Unknown native active Stop case");
  const remote = execution.environment.id === "daytona";
  if ((!remote && execution.environment.id !== "local") || (remote && !input.remoteBootstrap)) throw new Error("Active Stop requires an isolated admitted environment");
  const checks: Check[] = []; let issue: Row = {}, runs: Row[] = [], events: Row[] = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const name = `active-stop-${nonce}.txt`, local = remote ? undefined : await createDeniedTargetFixture(input.workspacePath, name);
  const target = local?.targetRelativePath ?? name;
  let command = provider === "cursor" && local ? cursorDeniedCommand(local.targetPath) : undefined;
  const observer = remote ? undefined : observeRunProcesses();
  let processes: { captured: boolean; live: number[] } = { captured: false, live: [] };
  let processIdentity: string | undefined, processError = false;
  const remoteObservations: ActiveStopRemoteObservation[] = [];
  let retirement: ReturnType<typeof assertActiveStopRetirement> | undefined;
  const samples: Array<{ phase: string; absent: boolean }> = [];
  let fixture: NativeRemoteFixture | undefined, baseline: NativeRemoteSnapshot | undefined, sealed: NativeRemoteSnapshot | undefined;
  let completed: Awaited<ReturnType<typeof stopAtPendingPermission>> | undefined;
  const observeProcesses = () => {
    // Remote ownership comes from the sandbox boot/start-tick journal. The
    // API PID transitions from the controller command to the remote runner.
    if (!observer) return;
    const run = runs[0], authority = run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined;
    if (authority) { const key = JSON.stringify(authority); if (processIdentity && processIdentity !== key) processError = true; processIdentity ??= key; }
    processes = observer.sample(authority);
  };
  const load = async (): Promise<ActiveStopState> => {
    if (issue.id) issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const list = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(list.map(r => api.get<Row>(`/api/heartbeat-runs/${r.id}`)));
    if (runs.length > 1) throw new Error("Native active Stop dispatched an extra run");
    events = runs[0] ? await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : [];
    observeProcesses(); input.observe(issue, runs); return { run: runs[0] ?? {}, issue, events };
  };
  const sample = async (phase: string) => {
    let value: boolean;
    if (remote) {
      if (!fixture || !baseline) throw new Error("Missing remote active Stop observer");
      if (phase !== "pending") throw new Error("Remote filesystem phase requires a fresh live snapshot");
      const snap = await fixture.snapshot(phase);
      remoteObservations.push({ phase, source: "live-snapshot", snapshot: snap });
      value = !nativeRemoteDeniedSample(snap, baseline, target, "pending").exists;
      await input.evidence(`active-stop-${phase}-remote.json`, snap);
    } else value = !await exists(local!.targetPath);
    samples.push({ phase, absent: value }); check(`no-effect-${phase}`, value, "Exact target remains absent at the causal observation boundary");
  };
  const scope = (): ActiveStopScope => ({ provider, companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id, target, ...(command ? { commandSha256: command.commandSha256 } : {}) });
  const bootstrap = (): BootstrapReadProof | undefined => fixture ? { actionFile: fixture.actionFile, events } : undefined;
  const cleanup = async () => {
    const receipt: Check[] = [];
    try {
      await load();
      if (remote) {
        if (!fixture || !baseline) throw new Error("Remote observer was never armed");
        sealed ??= await fixture.finish(); assertNativeRemoteRetirement(sealed, baseline); processes = sealed.processes;
      } else if (processes.captured && processes.live.length) {
        await pollUntil({ label: "active Stop provider retirement", deadlineAt: Date.now() + 5000, intervalMs: 100, load: async () => { observeProcesses(); return processes; }, accept: p => p.live.length === 0 });
      }
      if (!remote) await sample("after-cleanup");
      const watch = remote ? sealed!.watcher : local!.watcher.finish();
      retirement = assertActiveStopRetirement({ completed: Boolean(completed), identityChanged: processError, processes, watcher: watch,
        ...(remote ? { environment: "daytona" as const, remote: { scope: scope(), observations: remoteObservations } } : { environment: "local" as const, samples }) });
      if (!completed) throw new Error("Missing active Stop settlement");
      readActiveStopSettlement({ ...await load(), ...completed, bootstrap: bootstrap() });
      receipt.push({ id: "active-stop-retired-no-effects", passed: true, detail: remote ? "Exact run root/descendants retired with continuous no-effects proof through retirement; later UI/API checks do not claim fresh filesystem observation" : "Exact run root/descendants retired; unanswered target remained absent through cleanup" });
      return receipt;
    } finally {
      if (timer) clearInterval(timer);
      try {
        await input.evidence("native-active-stop-cleanup.json", { processes, processError, samples, remoteObservations, retirement, sealed, watcher: local?.watcher.finish(), checks: receipt });
      } finally {
        if (remote) await fixture?.close();
      }
    }
  };
  const timer = observer ? setInterval(() => { try { observeProcesses(); } catch { processError = true; } }, 100) : undefined;
  (remote ? input.registerBeforeEnvironmentTeardownAssertion : input.registerCleanupAssertion)(cleanup);
  const prompt = () => provider === "cursor"
    ? `${execution.task.buildPrompt(nonce)}\nUse this exact native shell command once:\n${command!.command}`
    : `${execution.task.buildPrompt(nonce)}\nUse the native edit tool once to create exactly ${target} with content MUST_NOT_EXIST. Do not use a shell command.`;
  try {
    const caller = readActiveStopCaller(await api.get("/api/health"), await api.get("/api/auth/get-session"));
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", ...(provider === "cursor" ? { acpxSessionMode: "agent" } : {}), timeoutSec: 120, lifecycleMode: "per_turn" } });
    check("explicit-per-turn-policy", configured.adapterConfig?.acpxPermissionMode === "approve-reads" && configured.adapterConfig?.lifecycleMode === "per_turn" && (provider !== "cursor" || configured.adapterConfig?.acpxSessionMode === "agent"), "Agent mode and per-turn restrictive permission policy selected before startup");
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, { name: `Native active Stop ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } }, workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true } });
    if (!remote) await sample("before-request");
    const createdTask = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: remote ? input.remoteBootstrap!.prompt(nonce) : prompt(), workMode: "standard", projectName: project.name, requireExplicitTitle: true });
    issue = (await pollUntil({ label: "browser-created active Stop task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(i => i.id === createdTask.issueId), accept: Boolean }))!;
    if (remote) {
      await pollUntil({ label: "active Stop remote bootstrap", deadlineAt: input.deadlineAt, load, accept: state => state.run.status === "running" });
      const bound = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id, targets: [target], actionPrompt: async value => {
        fixture = value; if (provider === "cursor") command = cursorDeniedCommand(join(value.remoteCwd, target));
        const prepared = await prepareNativeRemoteAction({ fixture: value, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id, target, prompt: prompt() });
        baseline = prepared.baseline;
        remoteObservations.push({ phase: "before-request", source: "live-snapshot", snapshot: baseline });
        await input.evidence("active-stop-before-request-remote.json", baseline); return prepared.prompt;
      } });
      if (bound !== fixture) throw new Error("Remote active Stop publication identity changed");
    }
    const label = "unanswered native permission";
    await pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 200, load: async () => {
      const state = await load(); if (["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status)) throw new Error(`Stopped waiting for ${label}: provider ended without pending callback`); return state;
    }, accept: state => { observeActiveStopPending({ ...state, scope: scope(), caller, cancellationRequestId: randomUUID(), bootstrap: bootstrap() }); return true; } });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true });
    await expect(card).toHaveCount(1); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
    await input.capture("pending-permission", "Native permission left unanswered before Stop", "pending-permission.png"); await sample("pending");
    completed = await stopAtPendingPermission({ scope: scope(), caller, bootstrap: bootstrap(), deadlineAt: input.deadlineAt, load,
      retain: proof => input.evidence("native-active-stop-pending.json", proof), stop: (runId, cancellationRequestId) => api.post(`/api/heartbeat-runs/${runId}/cancel`, { cancellationRequestId }) });
    check("pending-callback-cancelled", true, "Unanswered native permission closed through a cancelled provider turn and the exact caller-owned Stop acknowledgement");
    await input.evidence("native-active-stop-settlement.json", completed);
    // Only after confirmed cancellation: test the real public stale-response fence.
    const response = await api.request.post(`/api/heartbeat-runs/${runs[0]!.id}/runtime-requests/${encodeURIComponent(completed.pending.requestId)}/resolve`, { data: { turnId: completed.pending.turnId, requestKind: "permission_approval", resolution: { action: "accept" } } });
    check("stale-answer-refused", response.status() === 409, "Stopped permission rejects a later answer rather than replaying work");
    await load(); readActiveStopSettlement({ ...await load(), ...completed, bootstrap: bootstrap() });
    if (remote) {
      // finish drains the observer's automatic retirement seal. It does not
      // extend the remote watch through subsequent host UI/cleanup assertions.
      sealed = await fixture!.finish(); assertNativeRemoteRetirement(sealed, baseline!); processes = sealed.processes;
      remoteObservations.push({ phase: "owned-process-retirement", source: "retirement-seal", snapshot: sealed });
      await input.evidence("active-stop-owned-process-retirement-remote.json", sealed);
    } else await sample("after-stop");
    await page.reload();
    const finalUiTimeout = () => {
      const remaining = input.deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("Active Stop final UI deadline elapsed");
      return Math.min(30_000, remaining);
    };
    // Absence of a permission button during React loading is not proof that a
    // stopped request is unanswerable. First observe the actual task/run UI.
    await expect(page.getByTestId("issue-detail-header").getByRole("button", {
      name: "Change status (current: In Progress)", exact: true,
    })).toBeVisible({ timeout: finalUiTimeout() });
    await expect(page.getByTestId("task-chat-thread").getByTestId("task-chat-collapsible-marker")
      .filter({ has: page.getByText("Run cancelled", { exact: true }) }))
      .toBeVisible({ timeout: finalUiTimeout() });
    await expect(page.getByTestId("task-chat-history-loading"))
      .toHaveCount(0, { timeout: finalUiTimeout() });
    await expect(card.getByRole("button", { name: "Deny", exact: true }))
      .toHaveCount(0, { timeout: finalUiTimeout() });
    await load(); readActiveStopSettlement({ ...await load(), ...completed, bootstrap: bootstrap() });
    check("one-unfinished-cancelled-run", runs.length === 1 && issue.status === "in_progress" && runs[0]!.status === "cancelled", "No automatic follow-up run or false task completion");
    await input.capture("final-state", "Stopped native permission is no longer answerable", "final-state.png");
    await input.evidence("api-state.json", { issue, run: runs[0], runs, checks, samples, remoteObservations, runEvents: events, runEventsByRun: [{ runId: runs[0]!.id, events }], activeStop: completed });
    return { issue, runs, checks };
  } finally {
    // Local observation continues through cleanup. Remote cleanup revalidates
    // the lifetime seal and fresh API state without claiming later file reads.
    await input.evidence("native-active-stop-checks.json", { issue, runs, checks, samples, remoteObservations, completed });
  }
}
