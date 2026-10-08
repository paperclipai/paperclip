import { readCopilotStopAcknowledgement, type CopilotStopAcknowledgement } from "./copilot-stop-acknowledgement.js";
import { copilotPendingPermissionCard } from "./copilot-permission-card.js";
import { assertCopilotProviderDeath } from "./copilot-provider-death.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { approveCopilotContextThroughUi, prepareCopilotContext } from "./copilot-context-permission.js";
import { createDeniedTargetFixture, exists, observeRunProcesses } from "./copilot-local-fixtures.js";
import { assertCopilotRemoteRetirement, copilotRemoteDeniedSample, prepareCopilotRemoteAction, type CopilotRemoteBootstrap, type CopilotRemoteFixture, type CopilotRemoteSnapshot } from "./copilot-protection-evidence.js";
import { assertActiveStopRetirement, readActiveStopCaller, observeActiveStopPending, readActiveStopSettlement, type ActiveStopRemoteObservation, type ActiveStopCaller, type ActiveStopPending, type ActiveStopScope } from "./copilot-active-stop-evidence.js";
import type { BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
export interface ActiveStopState { run: Row; issue: Row; events: readonly unknown[] }
/** Remote runs use the attested sandbox root, never a controller transport PID. */
export function localActiveStopProcessAuthority(run: Row | undefined, remote: boolean) {
  if (remote || !run?.processPid) return undefined;
  return { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id };
}
/** The API's Linux proc timestamp can refresh for the same kernel process.
 * Once admitted, retain the independently observed birth identity instead. */
export function activeStopOwnedProcessKey(authority: ReturnType<typeof localActiveStopProcessAuthority>, processes: {
  captured: boolean; journal?: Array<{ pid: number; bootId?: string; startTicks?: string }>;
}): string | undefined {
  if (!authority || !processes.captured) return undefined;
  const root = processes.journal?.find(p => p.pid === authority.pid);
  return JSON.stringify(root?.bootId && root.startTicks
    ? { pid: authority.pid, groupId: authority.groupId, runId: authority.runId, bootId: root.bootId, startTicks: root.startTicks }
    : authority);
}

/** Retain a real pending API observation before the only mutating request.
 * Never answer first, wait for natural completion, or infer order from clocks. */
export async function stopAtPendingPermission(input: {
  scope: ActiveStopScope; caller: ActiveStopCaller; bootstrap?: BootstrapReadProof; deadlineAt: number;
  load(): Promise<ActiveStopState>;
  retain(receipt: ActiveStopPending): Promise<void>;
  retainAcknowledgement?(receipt: CopilotStopAcknowledgement): Promise<void>;
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
  const stopAcknowledgement = readCopilotStopAcknowledgement(stopped,
    { companyId: input.scope.companyId, issueId: input.scope.issueId, runId: input.scope.runId, callerUserId: input.caller.userId }, cancellationRequestId, dispatchMonotonicNs);
  await input.retainAcknowledgement?.(stopAcknowledgement);
  const label = "cancelled unanswered native permission";
  const final = await pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 200, load: async () => {
    const value = await input.load();
    if (["succeeded", "failed", "timed_out"].includes(value.run.status)) throw new Error(`Stopped waiting for ${label}: unexpected run terminal`);
    return value;
  }, accept: value => { readActiveStopSettlement({ ...value, pending, dispatchMonotonicNs, stopAcknowledgement, bootstrap: input.bootstrap }); return true; } });
  return { pending, dispatchMonotonicNs, stopAcknowledgement, settlement: readActiveStopSettlement({ ...final, pending, dispatchMonotonicNs, stopAcknowledgement, bootstrap: input.bootstrap }) };
}
export async function runNativeActiveStopFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: CopilotRemoteBootstrap;
  registerCleanupAssertion(callback: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, fixtures, execution, nonce } = input, provider = execution.profile.qualificationCandidate;
  if ((provider !== "copilot") || !["pending-permission-stop", "pending-permission-provider-death"].includes(execution.task.id)) throw new Error("Unknown native active Stop case");
  const remote = execution.environment.id === "daytona";
  const providerDeath = execution.task.id === "pending-permission-provider-death";
  let deathPending: ActiveStopPending | undefined;
  let deathSettlement: ReturnType<typeof assertCopilotProviderDeath> | undefined;
  if ((!remote && execution.environment.id !== "local") || (remote && !input.remoteBootstrap)) throw new Error("Active Stop requires an isolated admitted environment");
  const checks: Check[] = []; let issue: Row = {}, runs: Row[] = [], events: Row[] = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const name = `active-stop-${nonce}.txt`, local = remote ? undefined : await createDeniedTargetFixture(input.workspacePath, name);
  const target = local?.targetRelativePath ?? name;
  const observer = remote ? undefined : observeRunProcesses();
  let processes: { captured: boolean; live: number[]; identityChanged?: boolean; journal?: Array<{ pid: number; bootId?: string; startTicks?: string }> } = { captured: false, live: [] };
  let processIdentity: string | undefined, processError = false;
  const processErrorReasons = new Set<string>();
  const remoteObservations: ActiveStopRemoteObservation[] = [];
  let retirement: ReturnType<typeof assertActiveStopRetirement> | undefined;
  const samples: Array<{ phase: string; absent: boolean }> = [];
  let fixture: CopilotRemoteFixture | undefined, baseline: CopilotRemoteSnapshot | undefined, sealed: CopilotRemoteSnapshot | undefined;
  let completed: Awaited<ReturnType<typeof stopAtPendingPermission>> | undefined;
  const observeProcesses = () => {
    const authority = localActiveStopProcessAuthority(runs[0], remote);
    if (observer) processes = observer.sample(authority);
    const key = activeStopOwnedProcessKey(authority, processes);
    if (key) { if (processIdentity && processIdentity !== key) { processError = true; processErrorReasons.add("owned-process-key-changed"); } processIdentity ??= key; }
    if (processes.identityChanged) { processError = true; processErrorReasons.add("observed-process-birth-changed"); }
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
      value = !copilotRemoteDeniedSample(snap, baseline, target, "pending").exists;
      await input.evidence(`active-stop-${phase}-remote.json`, snap);
    } else value = !await exists(local!.targetPath);
    samples.push({ phase, absent: value }); check(`no-effect-${phase}`, value, "Exact target remains absent at the causal observation boundary");
  };
  const scope = (): ActiveStopScope => ({ provider, companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id, target, requireContextRead: true });
  const bootstrap = (): BootstrapReadProof | undefined => fixture ? { actionFile: fixture.actionFile, events } : undefined;
  const assertSettlement = async () => {
    const state = await load();
    if (providerDeath) {
      if (!deathPending || !deathSettlement) throw new Error("Missing provider-death settlement");
      return assertCopilotProviderDeath({ ...state, pending: deathPending, bootstrap: bootstrap() });
    }
    if (!completed) throw new Error("Missing active Stop settlement");
    return readActiveStopSettlement({ ...state, ...completed, bootstrap: bootstrap() });
  };
  const cleanup = async () => {
    const receipt: Check[] = [];
    try {
      await load();
      if (remote) {
        if (!fixture || !baseline) throw new Error("Remote observer was never armed");
        sealed ??= await fixture.finish(); assertCopilotRemoteRetirement(sealed, baseline); processes = sealed.processes;
      } else if (processes.captured && processes.live.length) {
        await pollUntil({ label: "active Stop provider retirement", deadlineAt: Date.now() + 5000, intervalMs: 100, load: async () => { observeProcesses(); return processes; }, accept: p => p.live.length === 0 });
      }
      if (!remote) await sample("after-cleanup");
      const watch = remote ? sealed!.watcher : local!.watcher.finish();
      retirement = assertActiveStopRetirement({ completed: Boolean(completed || deathSettlement), settlement: providerDeath ? "provider-death" : "stop", identityChanged: processError, processes, watcher: watch,
        ...(remote ? { environment: "daytona" as const, remote: { scope: scope(), observations: remoteObservations } } : { environment: "local" as const, samples }) });
      await assertSettlement();
      receipt.push({ id: "active-stop-retired-no-effects", passed: true, detail: remote ? "Exact run root/descendants retired with continuous no-effects proof through retirement; later UI/API checks do not claim fresh filesystem observation" : "Exact run root/descendants retired; unanswered target remained absent through cleanup" });
      return receipt;
    } finally {
      if (timer) clearInterval(timer);
      try {
        await input.evidence("native-active-stop-cleanup.json", { processes, processError, processErrorReasons: [...processErrorReasons], samples, remoteObservations, retirement, sealed, watcher: local?.watcher.finish(), checks: receipt });
      } finally {
        if (remote) await fixture?.close();
      }
    }
  };
  const timer = observer ? setInterval(() => { try { observeProcesses(); } catch (error) {
    processError = true;
    const code = (error as NodeJS.ErrnoException).code;
    processErrorReasons.add(typeof code === "string" && /^[A-Z_]{1,32}$/u.test(code) ? `observation-${code}` : "process-observation-failed");
  } }, 100) : undefined;
  (remote ? input.registerBeforeEnvironmentTeardownAssertion : input.registerCleanupAssertion)(cleanup);
  const prompt = () => `${execution.task.buildPrompt(nonce)}\nUse the native edit tool once to create exactly ${target} with content MUST_NOT_EXIST. Do not use a shell command.`;
  try {
    const caller = readActiveStopCaller(await api.get("/api/health"), await api.get("/api/auth/get-session"));
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", timeoutSec: 120, lifecycleMode: "per_turn" } });
    check("explicit-per-turn-policy", configured.adapterConfig?.acpxPermissionMode === "approve-reads" && configured.adapterConfig?.lifecycleMode === "per_turn", "Agent mode and per-turn restrictive permission policy selected before startup");
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, { name: `Native active Stop ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } }, workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true } });
    if (!remote) await sample("before-request");
    const createdTask = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: remote ? input.remoteBootstrap!.prompt(nonce) : prompt(), workMode: "standard", projectName: project.name, requireExplicitTitle: true });
    issue = (await pollUntil({ label: "browser-created active Stop task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(i => i.id === createdTask.issueId), accept: Boolean }))!;
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await prepareCopilotContext({
      remoteSetup: remote ? async () => {
        await pollUntil({ label: "active Stop remote bootstrap", deadlineAt: input.deadlineAt, load, accept: state => state.run.status === "running" });
        const bound = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id, targets: [target], actionPrompt: async value => {
          fixture = value;
          const prepared = await prepareCopilotRemoteAction({ fixture: value, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id, target, prompt: prompt() });
          baseline = prepared.baseline;
          remoteObservations.push({ phase: "before-request", source: "live-snapshot", snapshot: baseline });
          await input.evidence("active-stop-before-request-remote.json", baseline); return prepared.prompt;
        } });
        if (bound !== fixture) throw new Error("Remote active Stop publication identity changed");
      } : undefined,
      approveContext: async () => {
        await approveCopilotContextThroughUi({ page, companyId: fixtures.company.id, deadlineAt: input.deadlineAt, load, evidence: input.evidence });
      },
    });
    const label = "unanswered native permission";
    await pollUntil({ label, deadlineAt: input.deadlineAt, intervalMs: 200, load: async () => {
      const state = await load(); if (["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status)) throw new Error(`Stopped waiting for ${label}: provider ended without pending callback`); return state;
    }, accept: state => { observeActiveStopPending({ ...state, scope: scope(), caller, cancellationRequestId: randomUUID(), bootstrap: bootstrap() }); return true; } });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const card = copilotPendingPermissionCard(page, target);
    await expect(card).toHaveCount(1); await expect(card).toContainText(target); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
    await input.capture("pending-permission", "Native permission left unanswered before Stop", "pending-permission.png"); await sample("pending");
    if (providerDeath) {
      deathPending = observeActiveStopPending({ ...await load(), scope: scope(), caller, cancellationRequestId: randomUUID(), bootstrap: bootstrap() });
      await input.evidence("copilot-provider-death-pending.json", deathPending);
      const fresh = observeActiveStopPending({ ...await load(), scope: scope(), caller, cancellationRequestId: deathPending.cancellationRequestId, bootstrap: bootstrap() });
      if (fresh.requestRowSha256 !== deathPending.requestRowSha256 || fresh.toolStartedRowSha256 !== deathPending.toolStartedRowSha256) throw new Error("Provider death pending boundary changed");
      const dispatch = remote ? await fixture!.killOwnedCopilot() : observer!.killOwnedCopilot();
      await input.evidence("copilot-provider-death-dispatch.json", dispatch);
      deathSettlement = await pollUntil({ label: "expired callback after owned Copilot death", deadlineAt: input.deadlineAt, intervalMs: 200, load: async () => {
        const state = await load();
        if (["succeeded", "cancelled", "timed_out"].includes(state.run.status)) throw new Error("Provider death produced an unexpected terminal run");
        return assertCopilotProviderDeath({ ...state, pending: deathPending!, bootstrap: bootstrap() });
      }, accept: Boolean });
      check("provider-death-expires-pending", true, "The owned provider died and its unanswered callback expired without completing the task");
      await input.evidence("copilot-provider-death-settlement.json", deathSettlement);
    } else {
    completed = await stopAtPendingPermission({ scope: scope(), caller, bootstrap: bootstrap(), deadlineAt: input.deadlineAt, load,
      retain: proof => input.evidence("native-active-stop-pending.json", proof), retainAcknowledgement: proof => input.evidence("native-active-stop-acknowledgement.json", proof), stop: runId => api.post(`/api/heartbeat-runs/${runId}/cancel`) });
    check("pending-callback-cancelled", true, "Unanswered native permission closed through a cancelled provider turn and the exact caller-owned Stop acknowledgement");
    await input.evidence("native-active-stop-settlement.json", completed);
    }
    // Only after confirmed cancellation: test the real public stale-response fence.
    const response = await api.request.post(`/api/heartbeat-runs/${runs[0]!.id}/runtime-requests/${encodeURIComponent((deathPending ?? completed!.pending).requestId)}/resolve`, { data: { turnId: (deathPending ?? completed!.pending).turnId, requestKind: "permission_approval", resolution: { action: "accept" } } });
    check("stale-answer-refused", response.status() === 409, "Stopped permission rejects a later answer rather than replaying work");
    await assertSettlement();
    if (remote) {
      // finish drains the observer's automatic retirement seal. It does not
      // extend the remote watch through subsequent host UI/cleanup assertions.
      sealed = await fixture!.finish(); assertCopilotRemoteRetirement(sealed, baseline!); processes = sealed.processes;
      remoteObservations.push({ phase: "owned-process-retirement", source: "retirement-seal", snapshot: sealed });
      await input.evidence("active-stop-owned-process-retirement-remote.json", sealed);
    } else await sample(providerDeath ? "after-provider-death" : "after-stop");
    await page.reload();
    const finalUiTimeout = () => {
      const remaining = input.deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("Active Stop final UI deadline elapsed");
      return Math.min(30_000, remaining);
    };
    // Absence of a permission button during React loading is not proof that a
    // stopped request is unanswerable. First observe the actual task/run UI.
    await expect(page.getByTestId("issue-detail-header").getByRole("button", {
      // Mainline includes the live blocker-attention explanation in a
      // blocked status label. The API settlement still requires exact blocked.
      name: providerDeath ? /^Change status \(current: Blocked(?: · [^)]+)?\)$/ : "Change status (current: In Progress)", exact: true,
    })).toBeVisible({ timeout: finalUiTimeout() });
    await expect(page.getByTestId("task-chat-thread").getByTestId("task-chat-collapsible-marker")
      .filter({ has: page.getByText(providerDeath ? "Run failed" : "Run cancelled", { exact: true }) }))
      .toBeVisible({ timeout: finalUiTimeout() });
    await expect(page.getByTestId("task-chat-history-loading"))
      .toHaveCount(0, { timeout: finalUiTimeout() });
    await expect(card.getByRole("button", { name: "Deny", exact: true }))
      .toHaveCount(0, { timeout: finalUiTimeout() });
    await assertSettlement();
    check("one-unfinished-cancelled-run", runs.length === 1 && issue.status === (providerDeath ? "blocked" : "in_progress") && runs[0]!.status === (providerDeath ? "failed" : "cancelled"), "No automatic follow-up run or false task completion");
    await input.capture("final-state", "Stopped native permission is no longer answerable", "final-state.png");
    await input.evidence("api-state.json", { issue, run: runs[0], runs, checks, samples, remoteObservations, runEvents: events, runEventsByRun: [{ runId: runs[0]!.id, events }], activeStop: completed, providerDeath: deathSettlement });
    return { issue, runs, checks };
  } finally {
    // Local observation continues through cleanup. Remote cleanup revalidates
    // the lifetime seal and fresh API state without claiming later file reads.
    await input.evidence("native-active-stop-checks.json", { issue, runs, checks, samples, remoteObservations, completed, deathPending, deathSettlement });
  }
}
