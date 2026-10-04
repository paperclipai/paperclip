import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { persistedFinalRunMessage } from "./matchers.js";
import { createDeniedTargetFixture, exists, observeRunProcesses } from "./copilot-local-fixtures.js";
import { assertCopilotRemoteRetirement, copilotRemoteDeniedSample, prepareCopilotRemoteAction, type CopilotRemoteBootstrap, type CopilotRemoteFixture, type CopilotRemoteSnapshot } from "./copilot-protection-evidence.js";
import { assertActiveStopRetirement, readActiveStopRemoteRetirement, readActiveStopCaller, type ActiveStopCaller, type ActiveStopRemoteObservation } from "./native-active-stop-evidence.js";
import { assertSamePiPending, observePiControlPending, readPiStopSettlement, readPiSteeringAcknowledgement, readPiSteeringSettlement, type PiControlPending, type PiControlScope, type PiControlState } from "./pi-controls-evidence.js";
import { piNativeFinish } from "./pi-native-cases.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };

/** Await the evidence write and reread the actual pending state before Stop.
 * This deliberately never answers a permission to provoke cancellation. */
export async function stopPiAtPendingPermission(input: {
  scope: PiControlScope; caller: ActiveStopCaller; deadlineAt: number;
  load(): Promise<PiControlState>; retain(value: unknown): Promise<void>;
  stop(runId: string, cancellationRequestId: string): Promise<Row>;
}) {
  const pending = observePiControlPending({ ...await input.load(), scope: input.scope });
  const cancellationRequestId = randomUUID();
  await input.retain({ pending, caller: input.caller, cancellationRequestId });
  assertSamePiPending(pending, observePiControlPending({ ...await input.load(), scope: input.scope }));
  if (Date.now() >= input.deadlineAt) throw new Error("Pi pending Stop deadline expired");
  const dispatchMonotonicNs = process.hrtime.bigint().toString();
  const response = await input.stop(input.scope.runId, cancellationRequestId);
  if (response.id !== input.scope.runId || response.resultJson?.nativeCancellation?.intentId !== `native-cancellation:${cancellationRequestId}`) throw new Error("Pi Stop response has foreign intent");
  const binding = { pending, caller: input.caller, cancellationRequestId, dispatchMonotonicNs };
  const state = await pollUntil({ label: "Pi pending permission cancellation", deadlineAt: input.deadlineAt, intervalMs: 200,
    load: async () => { const value = await input.load(); if (["succeeded", "failed", "timed_out"].includes(value.run.status)) throw new Error("Stopped waiting for Pi pending permission cancellation: unexpected terminal"); return value; },
    accept: value => { readPiStopSettlement({ ...value, ...binding }); return true; } });
  return { ...binding, settlement: readPiStopSettlement({ ...state, ...binding }) };
}

export async function runPiControlsFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: CopilotRemoteBootstrap;
  registerCleanupAssertion(callback: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, fixtures, execution, nonce } = input;
  if (execution.suite.id !== "pi-controls" || execution.profile.qualificationCandidate !== "pi"
    || !["pending-permission-stop", "same-turn-steering"].includes(execution.task.id)) throw new Error("Unknown Pi control case");
  const stopCase = execution.task.id === "pending-permission-stop", remote = execution.environment.id === "daytona";
  if ((!remote && execution.environment.id !== "local") || (remote && !input.remoteBootstrap)) throw new Error("Pi controls require an isolated admitted environment");
  const checks: Check[] = []; let issue: Row = {}, runs: Row[] = [], events: Row[] = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const name = `pi-control-${nonce}.txt`, local = remote ? undefined : await createDeniedTargetFixture(input.workspacePath, name), target = local?.targetRelativePath ?? name;
  const observer = remote ? undefined : observeRunProcesses();
  let processes: { captured: boolean; live: number[] } = { captured: false, live: [] }, processIdentity: string | undefined, processError = false;
  const samples: Array<{ phase: string; absent: boolean }> = [], remoteObservations: ActiveStopRemoteObservation[] = [];
  let fixture: CopilotRemoteFixture | undefined, baseline: CopilotRemoteSnapshot | undefined, sealed: CopilotRemoteSnapshot | undefined;
  let stopped: Awaited<ReturnType<typeof stopPiAtPendingPermission>> | undefined;
  let steered: { pending: PiControlPending; commentId: string; queueId: string; marker: string } | undefined;
  let completed = false;
  const observeProcesses = () => {
    const run = runs[0], authority = run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined;
    if (authority) { const key = JSON.stringify(authority); if (processIdentity && processIdentity !== key) processError = true; processIdentity ??= key; }
    if (observer) processes = observer.sample(authority);
  };
  const load = async (): Promise<PiControlState> => {
    if (issue.id) issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const list = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(list.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    if (runs.length > 1) throw new Error("Stopped waiting for Pi controls: extra provider run");
    events = runs[0] ? await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : [];
    observeProcesses(); input.observe(issue, runs); return { run: runs[0] ?? {}, issue, events };
  };
  const scope = (): PiControlScope => ({ companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id, target });
  const readPresentation = async (state: PiControlState) => {
    const commentsApiPath = `/api/issues/${state.issue.id}/comments`;
    const comments = await api.get<Array<{ id: string; createdByRunId?: string | null; body?: string | null }>>(commentsApiPath);
    return { ...state, commentsApiPath, comments };
  };
  const finalMessage = (presentation: Awaited<ReturnType<typeof readPresentation>>) => persistedFinalRunMessage(presentation.comments, presentation.run as Row & { id: string });
  const assertSettled = async (phase: "final" | "after-cleanup" = "final") => {
    const state = await load();
    if (stopped) return readPiStopSettlement({ ...state, ...stopped });
    if (steered) {
      const presentation = await readPresentation(state);
      // Retain the public source records, including the run's presentation
      // decision, before grading. A marker or derived string cannot replace
      // the persisted comment selected by the Product.
      await input.evidence(`pi-steering-presentation${phase === "after-cleanup" ? "-after-cleanup" : ""}.json`, {
        schema: "paperclip.e2e.pi-steering-presentation.v1", phase,
        companyId: fixtures.company.id, issueId: state.issue.id, runId: state.run.id, ...presentation,
      });
      return readPiSteeringSettlement({ ...presentation, ...steered, finalMessage: finalMessage(presentation) });
    }
    throw new Error("Pi controls settlement is missing");
  };
  const sample = async (phase: string) => {
    let absent: boolean;
    if (remote) {
      if (!fixture || !baseline || phase !== "pending") throw new Error("Missing fresh Pi remote observation");
      const snapshot = await fixture.snapshot(phase);
      remoteObservations.push({ phase, source: "live-snapshot", snapshot });
      absent = !copilotRemoteDeniedSample(snapshot, baseline, target, "pending").exists;
      await input.evidence(`pi-control-${phase}-remote.json`, snapshot);
    } else absent = !await exists(local!.targetPath);
    samples.push({ phase, absent }); check(`no-effect-${phase}`, absent, "Exact pending native write has no file effect");
  };
  const timer = observer ? setInterval(() => { try { observeProcesses(); } catch { processError = true; } }, 100) : undefined;
  (remote ? input.registerBeforeEnvironmentTeardownAssertion : input.registerCleanupAssertion)(async () => {
    let retirement: unknown;
    try {
      await load();
      if (remote) {
        if (!fixture || !baseline) throw new Error("Pi remote observer was not armed");
        sealed ??= await fixture.finish(); assertCopilotRemoteRetirement(sealed, baseline); processes = sealed.processes;
      } else {
        if (processes.captured && processes.live.length) await pollUntil({ label: "Pi control process retirement", deadlineAt: Date.now() + 5000, intervalMs: 100,
          load: async () => { observeProcesses(); return processes; }, accept: value => value.live.length === 0 });
        await sample("after-cleanup");
      }
      retirement = assertActiveStopRetirement({ completed, identityChanged: processError, processes, watcher: remote ? sealed!.watcher : local!.watcher.finish(),
        ...(remote ? { environment: "daytona" as const, remote: { scope: scope(), observations: remoteObservations } }
          : { environment: "local" as const, samples: samples.map(s => ({ ...s, phase: s.phase === "after-control" ? "after-stop" : s.phase })) }) });
      await assertSettled("after-cleanup");
      return [{ id: "pi-control-retired-no-effects", passed: true, detail: remote ? "Owned remote tree retired with continuous no-effects proof through its lifetime seal" : "Owned local tree retired; no target mutation through cleanup" }];
    } finally {
      if (timer) clearInterval(timer);
      try { await input.evidence("pi-control-cleanup.json", { completed, processes, processError, samples, remoteObservations, retirement, sealed, watcher: local?.watcher.finish() }); }
      finally { if (remote) await fixture?.close(); }
    }
  });
  const prompt = `${execution.task.buildPrompt(nonce)}\nUse native write once with relative path ${target} and content MUST_NOT_EXIST.`;
  try {
    const caller = readActiveStopCaller(await api.get("/api/health"), await api.get("/api/auth/get-session"));
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", lifecycleMode: "per_turn", timeoutSec: 120 } });
    check("explicit-per-turn-policy", configured.adapterConfig?.acpxPermissionMode === "approve-reads" && configured.adapterConfig?.lifecycleMode === "per_turn", "Native write requires a human decision before startup");
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, { name: `Pi controls ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } }, workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true } });
    if (!remote) await sample("before-request");
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: remote ? input.remoteBootstrap!.prompt(nonce) : prompt, workMode: "standard", projectName: project.name });
    issue = (await pollUntil({ label: "browser-created Pi control task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(i => i.title === execution.task.buildTitle(nonce)), accept: Boolean }))!;
    if (remote) {
      await pollUntil({ label: "Pi control remote bootstrap", deadlineAt: input.deadlineAt, load, accept: state => state.run.status === "running" });
      const bound = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id, targets: [target], actionPrompt: async value => {
        fixture = value;
        const prepared = await prepareCopilotRemoteAction({ fixture: value, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id, target, prompt });
        baseline = prepared.baseline; remoteObservations.push({ phase: "before-request", source: "live-snapshot", snapshot: baseline });
        await input.evidence("pi-control-before-request-remote.json", baseline); return prepared.prompt;
      } });
      if (bound !== fixture) throw new Error("Pi remote action identity changed");
    }
    await pollUntil({ label: "Pi unanswered native write", deadlineAt: input.deadlineAt, intervalMs: 200,
      load: async () => { const state = await load(); if (["failed", "timed_out", "cancelled", "succeeded"].includes(state.run.status)) throw new Error("Stopped waiting for Pi unanswered native write: no active pending permission"); return state; },
      accept: state => { observePiControlPending({ ...state, scope: scope() }); return true; } });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true });
    await expect(card).toHaveCount(1); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
    await input.capture("pending-permission", "Pi write waits for a human decision", "pending-permission.png"); await sample("pending");
    if (stopCase) {
      stopped = await stopPiAtPendingPermission({ scope: scope(), caller, deadlineAt: input.deadlineAt, load,
        retain: value => input.evidence("pi-control-pending.json", value), stop: (runId, cancellationRequestId) => api.post(`/api/heartbeat-runs/${runId}/cancel`, { cancellationRequestId }) });
      await input.evidence("pi-stop-settlement.json", stopped);
      // A stale decline is sufficient to test the response fence. Never send
      // an allow choice, even after a proven cancellation.
      const response = await api.request.post(`/api/heartbeat-runs/${runs[0]!.id}/runtime-requests/${encodeURIComponent(stopped.pending.requestId)}/resolve`, { data: { turnId: stopped.pending.turnId, requestKind: "permission_approval", resolution: { action: "decline" } } });
      check("stale-answer-refused", response.status() === 409, "Cancelled permission refuses a stale response");
    } else {
      const pending = observePiControlPending({ ...await load(), scope: scope() });
      await input.evidence("pi-control-pending.json", pending);
      const marker = `PI-STEER-${randomBytes(16).toString("hex")}`;
      const message = `After the actual native denial, complete this negative test. Do not write or invoke any other native tool. ${piNativeFinish(marker)}`;
      const commentRoutes = new Set([issue.id, issue.identifier].filter(Boolean).map(id => `/api/issues/${id}/comments`));
      const submitted = page.waitForRequest(request => commentRoutes.has(new URL(request.url()).pathname) && request.method() === "POST");
      await submitTaskReply(page, message);
      // The production rich-text editor serializes plain input as Markdown.
      // Bind the queued comment to the exact body actually sent by the browser.
      const submittedBody = (await submitted).postDataJSON()?.body;
      check("browser-steering-content", typeof submittedBody === "string" && submittedBody.startsWith("After the actual native denial, complete this negative test. Do not write or invoke any other native tool. ") && submittedBody.includes(marker), "Browser submitted the hidden instruction while permission remains pending");
      const queue = await pollUntil({ label: "Pi browser comment queued for steering", deadlineAt: input.deadlineAt, intervalMs: 200,
        load: () => api.get<Row>(`/api/issues/${issue.id}/queued-comments`), accept: q => q.steeringDisposition === "available" && q.entries?.some((entry: Row) => entry.comment.body === submittedBody) });
      const entries = queue.entries.filter((entry: Row) => entry.comment.body === submittedBody);
      check("one-browser-steering-message", entries.length === 1 && queue.entries.length === 1 && queue.targetRunId === pending.scope.runId, "One browser-originated comment targets the pending run");
      const commentId = entries[0].comment.id, queueId = queue.queueId;
      assertSamePiPending(pending, observePiControlPending({ ...await load(), scope: scope() }));
      await input.evidence("pi-steering-queued.json", { pending, queue, commentId, marker });
      const route = `/api/issues/${issue.id}/queued-comments/${commentId}/steer`;
      const posted = page.waitForRequest(request => new URL(request.url()).pathname === route && request.method() === "POST");
      await page.getByTestId(`task-chat-queued-steer-${commentId}`).click();
      const steeringRequest = await posted;
      const body = steeringRequest.postDataJSON();
      check("exact-browser-steer", body.queueId === queueId && body.revision === queue.revision && body.targetRunId === pending.scope.runId, "Browser steers the exact queued comment into the active run");
      const response = await steeringRequest.response();
      if (!response?.ok()) throw new Error(`Pi native steering rejected: HTTP ${response?.status() ?? "missing"}`);
      steered = { pending, commentId, queueId, marker };
      await pollUntil({ label: "Pi same-turn steering acknowledgement", deadlineAt: input.deadlineAt, intervalMs: 200, load,
        accept: state => { assertSamePiPending(pending, observePiControlPending({ ...state, scope: scope() })); readPiSteeringAcknowledgement({ ...state, ...steered! }); return true; } });
      await input.evidence("pi-steering-ack.json", readPiSteeringAcknowledgement({ ...await load(), ...steered }));
      await input.capture("steered-pending", "Steering acknowledged while permission remains unanswered", "steered-pending.png");
      const declineRoute = `/api/heartbeat-runs/${pending.scope.runId}/runtime-requests/${encodeURIComponent(pending.requestId)}/resolve`;
      const declined = page.waitForRequest(request => new URL(request.url()).pathname === declineRoute && request.method() === "POST");
      await card.getByRole("button", { name: "Deny", exact: true }).click();
      const decision = (await declined).postDataJSON();
      check("exact-browser-decline", decision.turnId === pending.turnId && decision.requestKind === "permission_approval" && decision.resolution?.action === "decline", "Browser denied the still-pending original native write");
      await pollUntil({ label: "Pi consumed same-turn steering", deadlineAt: input.deadlineAt, intervalMs: 200,
        load: async () => { const state = await load(); if (["cancelled", "failed", "timed_out"].includes(state.run.status)) throw new Error("Stopped waiting for Pi consumed same-turn steering: provider failed"); const presentation = await readPresentation(state); return { ...state, finalMessage: finalMessage(presentation) }; },
        accept: state => { readPiSteeringSettlement({ ...state, ...steered! }); return true; } });
      await input.evidence("pi-steering-settlement.json", await assertSettled());
    }
    check("control-settled", true, stopCase ? "Exact active permission closed under the caller-owned Stop" : "Hidden steering marker consumed in the original denied-write turn");
    if (remote) {
      sealed = await fixture!.finish(); assertCopilotRemoteRetirement(sealed, baseline!); processes = sealed.processes;
      remoteObservations.push({ phase: "owned-process-retirement", source: "retirement-seal", snapshot: sealed });
      await input.evidence("pi-control-owned-retirement-remote.json", sealed);
      readActiveStopRemoteRetirement({ scope: scope(), observations: remoteObservations });
    } else await sample("after-control");
    await page.reload();
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: `Change status (current: ${stopCase ? "In Progress" : "Done"})`, exact: true })).toBeVisible();
    if (stopCase) await expect(page.getByTestId("task-chat-thread").getByTestId("task-chat-collapsible-marker").filter({ has: page.getByText("Run cancelled", { exact: true }) })).toBeVisible();
    else await expect(page.getByTestId("task-chat-thread").getByText(steered!.marker, { exact: true }).last()).toBeVisible();
    await expect(page.getByTestId("task-chat-history-loading")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await assertSettled(); completed = true;
    await input.capture("final-state", "Pi control verified through the production task UI", "final-state.png");
    await input.evidence("api-state.json", { issue, run: runs[0], runs, checks, samples, remoteObservations, runEvents: events, runEventsByRun: [{ runId: runs[0]!.id, events }], stopped, steered });
    return { issue, runs, checks };
  } finally { await input.evidence("pi-control-checks.json", { issue, runs, checks, samples, remoteObservations, completed }); }
}
