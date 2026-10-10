import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { onlyCopilotAttachedOperations, readCopilotSemanticCompletion } from "./copilot-semantic-evidence.js";
import { copilotOrigin, readCopilotToolEvidence, type CopilotToolNotice } from "./copilot-evidence.js";
import { createAttachedCommandFixture, createDeniedTargetFixture, bindDeniedTargetPrompt, exists, observeRunProcesses } from "./copilot-local-fixtures.js";
import { gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite, type CopilotDeniedWriteEvidence } from "./copilot-protection-cases.js";
import { observeCopilotPreStop, type CopilotPreStopObservation, readCopilotDeniedEdit, copilotDenialSampleCursor, readCopilotDenialSettlement, observeCopilotFixtureCommand, readCopilotRemoteMarkerAfterRetirement, prepareCopilotRemoteAction, assertCopilotRemoteRetirement, assertCopilotRemoteAttached, copilotRemoteDeniedSample, copilotActionNotices, type CopilotRemoteBootstrap, type CopilotRemoteFixture, type CopilotRemoteSnapshot, countCopilotToolOrigins, countCopilotEditOriginsForTarget } from "./copilot-protection-evidence.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
/** Each persistence barrier reloads durable rows. Stop cannot overtake the
 * failed edit, and a terminal sample cannot use a pre-terminal event cursor. */
export async function settleCopilotDeniedRun(input: {
  api: Pick<RunnerApi, "post">; request: CopilotToolNotice; deadlineAt: number;
  load(): Promise<{ events: readonly unknown[]; run: Row; issue: Row; retired: boolean }>;
  afterDeniedEdit(): Promise<void>;
  retainPreStop(receipt: CopilotPreStopObservation): Promise<void>;
  afterSettlement(): Promise<void>;
}) {
  const cancellationRequestId = randomUUID();
  const assertBeforeStop = (state: Awaited<ReturnType<typeof input.load>>) => {
    if (state.run.id !== input.request.runId || state.run.status !== "running"
      || state.run.resultJson?.startupCancellation != null || state.run.resultJson?.nativeCancellation != null) {
      throw new Error("Copilot denial observed an earlier Stop or non-running run");
    }
  };
  let stopSent = false;
  const poll = (label: string, accept: (state: Awaited<ReturnType<typeof input.load>>) => boolean) => pollUntil({
    label, deadlineAt: input.deadlineAt, load: async () => {
      const state = await input.load();
      // pollUntil recognizes this definitive rejection before invoking readers.
      if (["failed", "timed_out"].includes(state.run.status)) throw new Error(`Stopped waiting for ${label}: Copilot provider run failed`);
      if (!stopSent) {
        try { assertBeforeStop(state); }
        catch { throw new Error(`Stopped waiting for ${label}: Copilot denial observed an earlier Stop or non-running run`); }
      }
      return state;
    }, accept, intervalMs: 200,
  });
  await poll("persisted correlated failed native edit", state => {
    readCopilotDeniedEdit({ events: state.events, request: input.request, companyId: state.issue.companyId }); return true;
  });
  await input.afterDeniedEdit();
  // This negative case does not qualify active-turn cancellation. Give natural
  // settlement a fixed observation window inside the unchanged case deadline.
  const observeUntil = Math.min(input.deadlineAt, Date.now() + 2000);
  let preStop: CopilotPreStopObservation;
  while (true) {
    const state = await input.load();
    if (["failed", "timed_out"].includes(state.run.status)) throw new Error("Copilot provider run failed before Stop");
    assertBeforeStop(state);
    preStop = observeCopilotPreStop({ events: state.events, request: input.request, companyId: state.issue.companyId, cancellationRequestId });
    if (preStop.terminal || Date.now() >= observeUntil) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(200, observeUntil - Date.now())));
  }
  if (Date.now() >= input.deadlineAt) throw new Error("Copilot denial deadline reached before Stop");
  // Await the artifact write before dispatch. Database createdAt cannot supply
  // this causal boundary, and a later replay must never manufacture it.
  await input.retainPreStop(preStop);
  if (Date.now() >= input.deadlineAt) throw new Error("Copilot denial deadline reached before Stop");
  assertBeforeStop(await input.load());
  if (Date.now() >= input.deadlineAt) throw new Error("Copilot denial deadline reached before Stop");
  const stopDispatchMonotonicNs = process.hrtime.bigint().toString();
  const stopped = await input.api.post<Row>(`/api/heartbeat-runs/${input.request.runId}/cancel`, { cancellationRequestId });
  if (stopped?.id !== input.request.runId || stopped?.resultJson?.nativeCancellation?.intentId !== `native-cancellation:${cancellationRequestId}`) {
    throw new Error("Copilot denial Stop response has a foreign cancellation intent");
  }
  stopSent = true;
  await poll("correlated provider settlement and retired run", state => {
    if (!state.retired) return false;
    readCopilotDenialSettlement({ ...state, request: input.request, preStop, stopDispatchMonotonicNs }); return true;
  });
  await input.afterSettlement();
  return readCopilotDenialSettlement({ ...await input.load(), request: input.request, preStop, stopDispatchMonotonicNs });
}

export async function runCopilotProtectionFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  remoteBootstrap?: CopilotRemoteBootstrap;
  registerBeforeEnvironmentTeardownAssertion?(callback: () => Promise<Check[]>): void;
  observe(issue: Row, runs: Row[]): void; capture(id: string, label: string, file: string): Promise<void>; evidence(name: string, data: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce, workspacePath } = input;
  const remote = execution.environment.id === "daytona";
  if ((!remote && execution.environment.id !== "local") || execution.profile.qualificationCandidate !== "copilot") throw new Error("Copilot protection fixtures require an isolated candidate");
  if (remote && (!input.remoteBootstrap || !input.registerBeforeEnvironmentTeardownAssertion)) throw new Error("Remote Copilot protection requires bootstrap and pre-teardown evidence hooks");
  const deny = execution.task.id === "native-permission-deny-write";
  if (!deny && execution.task.id !== "attached-async-settlement") throw new Error("Unknown Copilot protection case");
  const checks: Check[] = []; let issue: Row = {}, runs: Row[] = [], runEvents: Row[] = [];
  let notices: CopilotToolNotice[] = [];
  const processObserver = remote ? undefined : observeRunProcesses();
  let processes: { captured: boolean; live: number[] } = processObserver?.sample() ?? { captured: false, live: [] };
  let remoteFixture: CopilotRemoteFixture | undefined, baseline: CopilotRemoteSnapshot | undefined, sealed: CopilotRemoteSnapshot | undefined;
  let remoteCommand: { command: string; commandSha256: string } | undefined;
  const remoteMarker = `${randomBytes(24).toString("hex")}\n`;
  const remoteSnapshots: CopilotRemoteSnapshot[] = [];
  async function sealRemote() {
    if (!remoteFixture || !baseline) throw new Error("Remote Copilot evidence was never armed");
    sealed ??= await remoteFixture.finish();
    assertCopilotRemoteRetirement(sealed, baseline); processes = sealed.processes;
    return sealed;
  }
  const targetName = `copilot-denied-${nonce}.txt`;
  const localTarget = deny && !remote ? await createDeniedTargetFixture(workspacePath, targetName) : undefined;
  const target = localTarget?.targetRelativePath ?? targetName, targetPath = localTarget?.targetPath ?? join(workspacePath, target);
  const fileObservations: CopilotDeniedWriteEvidence["fileObservations"] = [];
  let deniedRequest: CopilotToolNotice | undefined;
  const sample = async (phase: CopilotDeniedWriteEvidence["fileObservations"][number]["phase"]) => {
    const providerCursor = phase === "before-request" ? null : copilotDenialSampleCursor(runEvents, deniedRequest!);
    if (remote) {
      if (!remoteFixture || !baseline) throw new Error("Remote denied target has no baseline");
      const snapshot = sealed ?? (phase === "before-request" ? baseline : await remoteFixture.snapshot(phase));
      remoteSnapshots.push(snapshot); fileObservations.push({ ...copilotRemoteDeniedSample(snapshot, baseline, target, phase), providerCursor });
    } else fileObservations.push({ phase, observedAtMs: Date.now(), exists: await exists(targetPath), providerCursor });
  };
  const watcher = localTarget?.watcher;
  const markerPath = join(workspacePath, `copilot-settlement-${nonce}.txt`);
  const command = deny || remote ? undefined : await createAttachedCommandFixture(markerPath);
  const exactCommand = () => remoteCommand ?? command;
  let watchReceipt: CopilotDeniedWriteEvidence["mutationObservation"] | undefined;
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  async function load() {
    if (issue.id) issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(r => api.get<Row>(`/api/heartbeat-runs/${r.id}`)));
    if (runs.length > 1) throw new Error("Copilot protection case dispatched an extra run");
    input.observe(issue, runs);
    runEvents = runs[0] ? await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : [];
    notices = runs[0] ? readCopilotToolEvidence(runEvents, runs[0].id) : [];
    const run = runs[0];
    if (processObserver) processes = processObserver.sample(run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined);
    return { issue, runs, runEvents, notices, processes };
  }
  const wait = (label: string, accept: (state: Awaited<ReturnType<typeof load>>) => boolean) => pollUntil({ label, deadlineAt: input.deadlineAt, load, accept, intervalMs: 200,
    reject: state => state.runs.some(r => ["failed", "timed_out"].includes(r.status)) ? "Copilot provider run failed" : undefined });
  try {
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    await api.patch(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: deny ? "approve-reads" : "approve-all", timeoutSec: 120, lifecycleMode: "per_turn" } });
    check("per-turn-process-lifecycle", (await api.get<Row>(`/api/agents/${fixtures.agent.id}`)).adapterConfig?.lifecycleMode === "per_turn", "This case explicitly requires a per-turn runner process, never a retained warm daemon");
    const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, {
      name: `Copilot protection ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } },
      workspace: { name: "Primary", sourceType: "local_path", cwd: workspacePath, isPrimary: true },
    });
    if (deny && !remote) { await sample("before-request"); check("target-initially-absent", !fileObservations[0]!.exists, "The exact isolated target is absent before dispatch"); }
    const prompt = remote ? input.remoteBootstrap!.prompt(nonce) : `${localTarget ? bindDeniedTargetPrompt(execution.task.buildPrompt(nonce), targetName, target) : execution.task.buildPrompt(nonce)}${command ? `\nThe exact supplied command is:\n${command.command}\nDo not inspect or modify fixture code, fabricate its marker, or launch a substitute command.` : ""}`;
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt, workMode: "standard", projectName: project.name });
    const found = await pollUntil({ label: "browser-created Copilot protection task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(r => r.title === execution.task.buildTitle(nonce)), accept: Boolean });
    if (!found) throw new Error("Browser-created task was not found"); issue = found;
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    if (remote) {
      await wait("exact remote bootstrap run", state => state.runs.length === 1 && state.runs[0]?.status === "running");
      const bound = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: runs[0]!.id,
        targets: [deny ? target : `copilot-settlement-${nonce}.txt`],
        actionPrompt: async fixture => {
          remoteFixture = fixture;
          const prepared = await prepareCopilotRemoteAction({ fixture, companyId: fixtures.company.id, environmentId: fixtures.environment.id, runId: runs[0]!.id,
            target: deny ? target : `copilot-settlement-${nonce}.txt`, prompt: execution.task.buildPrompt(nonce), ...(deny ? {} : { markerText: remoteMarker }) });
          baseline = prepared.baseline; remoteCommand = prepared.command;
          if (deny) { await sample("before-request"); check("target-initially-absent", !fileObservations[0]!.exists, "The actual remote target is absent before action publication"); }
          await input.evidence("copilot-remote-baseline.json", baseline);
          return prepared.prompt;
        } });
      if (bound !== remoteFixture) throw new Error("Remote Copilot fixture changed during publication");
      input.registerBeforeEnvironmentTeardownAssertion!(async () => {
        try {
          const receipt = await sealRemote();
          if (deny) {
            if (copilotRemoteDeniedSample(receipt, baseline!, target, "after-cleanup").exists) throw new Error("Remote denied target exists after retirement");
          }
          else {
            if (!await readCopilotRemoteMarkerAfterRetirement(remoteFixture!, baseline!, `copilot-settlement-${nonce}.txt`, remoteMarker)) throw new Error("Remote sealed marker changed or disappeared");
          }
          await input.evidence("copilot-remote-pre-teardown.json", receipt);
          return [{ id: "remote-sealed-retirement", passed: true, detail: "Exact remote run root and descendants retired; retained pre-deletion filesystem receipt validated" }];
        } finally { await remoteFixture!.close(); }
      });
    }
    if (deny) {
      await wait("exact native write permission", s => s.notices.some(n => n.stage === "permission_requested" && n.operation === "edit" && n.target === target && n.declineOffered && s.runEvents.some(r => r.eventType === "runtime_request.created" && r.payload?.prpEvent?.payload?.request?.requestId === n.requestId)));
      const request = notices.find(n => n.stage === "permission_requested" && n.operation === "edit" && n.target === target)!;
      deniedRequest = request;
      const pending = runEvents.filter(r => r.eventType === "runtime_request.created" && r.payload?.prpEvent?.payload?.request?.requestId === request.requestId).map(r => r.payload.prpEvent.payload.request);
      check("one-bound-permission", pending.length === 1 && pending[0].requestKind === "permission_approval" && pending[0].origin?.method === "session/request_permission", "The notice maps to the exact durable native permission card");
      const retired = new Set(runEvents.filter(r => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(r.eventType)).map(r => r.payload?.prpEvent?.payload?.requestId));
      const activeRequests = runEvents.filter(r => r.eventType === "runtime_request.created" && r.payload?.prpEvent?.payload?.request && !retired.has(r.payload.prpEvent.payload.request.requestId));
      check("only-one-pending-native-request", activeRequests.length === 1, "Only the exact denied edit is awaiting a decision");
      await sample("pending"); await page.reload();
      const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true });
      await expect(card).toHaveCount(1); await input.capture("permission-pending", "Copilot native write awaiting denial", "permission-pending.png");
      const url = `/api/heartbeat-runs/${request.runId}/runtime-requests/${encodeURIComponent(request.requestId!)}/resolve`;
      const sent = page.waitForRequest(r => new URL(r.url()).pathname === url && r.method() === "POST");
      const clickedAtMs = Date.now(); await card.getByRole("button", { name: "Deny", exact: true }).click();
      const posted = (await sent).postDataJSON();
      check("browser-exact-denial", posted.turnId === request.turnId && posted.requestKind === "permission_approval" && posted.resolution?.action === "decline", "Browser submitted denial for the exact run/request/turn");
      const settlement = await settleCopilotDeniedRun({ api, request, deadlineAt: input.deadlineAt,
        load: async () => {
          const state = await load();
          return { events: state.runEvents, run: state.runs[0]!, issue: state.issue,
            retired: remote || (state.processes.captured && state.processes.live.length === 0) };
        },
        afterDeniedEdit: () => sample("after-decision"),
        retainPreStop: receipt => input.evidence("copilot-pre-stop-observation.json", receipt),
        afterSettlement: async () => {
          if (remote) await sealRemote();
          await sample("terminal"); await new Promise(resolve => setTimeout(resolve, 100)); await load(); await sample("after-cleanup");
        },
      });
      watchReceipt = remote ? { startedAtMs: baseline!.observedAtMs, endedAtMs: sealed!.observedAtMs, complete: sealed!.watcher.complete, targetMutationCount: sealed!.watcher.targetMutationCount } : watcher!.finish();
      const toolResult = notices.find(n => n.stage === "tool" && n.toolCallId === request.toolCallId && n.status === "failed")!;
      await input.evidence("copilot-denial-settlement.json", settlement);
      check("correlated-provider-settlement", true, `Exact provider settlement (${settlement.branch}) and audited run Stop; completed does not cover active-turn cancellation`);
      const terminalAt = settlement.providerTerminal.emittedAtMs;
      const evidence: CopilotDeniedWriteEvidence = {
        expected: copilotOrigin(request), requestId: request.requestId!, expectedRelativePath: target,
        request: { ...request, requestId: request.requestId!, targetRelativePath: request.target!, method: "session/request_permission", offeredActions: request.declineOffered ? ["decline"] : [] },
        decision: { ...request, observedAtMs: clickedAtMs, requestId: request.requestId!, browserRequestId: request.requestId!, action: "decline" },
        deliveredDecision: (() => { const n = notices.find(n => n.stage === "permission_delivered" && n.requestId === request.requestId && n.outcome === "reject_once"); return n ? { ...n, requestId: n.requestId!, outcome: n.outcome! } : null; })(),
        toolResult: { ...toolResult, status: "failed" },
        terminal: { runId: settlement.runId, turnId: settlement.turnId, observedAtMs: terminalAt, status: runs[0]!.status },
        settlement,
        cleanup: { observedAtMs: fileObservations.at(-1)!.observedAtMs, ownedProcessesRemaining: processes.live.length }, fileObservations, mutationObservation: watchReceipt,
        nativeAttemptsForTarget: countCopilotEditOriginsForTarget(notices, target),
      };
      await input.evidence("copilot-denial-proof.json", { evidence, processes, notices });
      const grade = gradeCopilotDeniedWrite(evidence); check("denial-without-side-effects", grade.passed, grade.failures.join(", ") || "Exact browser denial, explicit cancellation and absence through process cleanup");
      check("negative-task-unfinished", issue.status === "in_progress", "The negative test does not claim the task is done");
      check("no-extra-native-operation", countCopilotToolOrigins(copilotActionNotices(notices, notices.find(n => n.stage === "tool" && n.toolCallId === request.toolCallId)!, remoteFixture ? { actionFile: remoteFixture.actionFile, events: runEvents } : undefined)) === 1, "No alternate native edit, command or delegated operation is permitted");
    } else {
      await wait("attached command and task settlement", s => s.issue.status === "done" && s.runs[0]?.status === "succeeded" && (remote || (s.processes.captured && s.processes.live.length === 0)));
      // Preserve independent local proof before any command matcher can abort.
      const { external: localExternal, markerMatches: localMarkerMatches, afterCleanupMarkerMatches: localAfterCleanupMarkerMatches, matched } =
        await observeCopilotFixtureCommand(notices, exactCommand()!.command, command ? { fixture: command, markerPath } : undefined);
      await input.evidence("copilot-attached-command-observation.json", { notices, processes, external: localExternal,
        canonicalCommandSha256: exactCommand()!.commandSha256, commandMatch: matched?.match ?? null,
        markerMatches: localMarkerMatches, afterCleanupMarkerMatches: localAfterCleanupMarkerMatches });
      const call = matched?.call;
      check("single-exact-command", Boolean(matched), "Exactly one native execution matches the fixture command with at most eight leading ASCII SPACE/TAB bytes");
      const semantic = readCopilotSemanticCompletion(runEvents, { companyId: fixtures.company.id, runId: call!.runId, turnId: call!.turnId,
        nativeSessionId: call!.sessionId, command: call!, summary: execution.task.buildVisibleMarker(nonce) });
      await input.evidence("copilot-semantic-completion.json", semantic);
      check("accepted-canonical-completion", true, "One exact native finish receipt matches the proposed and control-plane accepted result; transport success alone is insufficient");
      check("no-extra-native-operation", onlyCopilotAttachedOperations(copilotActionNotices(notices, call!, remoteFixture ? { actionFile: remoteFixture.actionFile, events: runEvents } : undefined), call!, semantic), "Only attested setup reads, the exact attached command/result, and one authoritatively correlated accepted finish are allowed");
      const started = notices.find(n => n.toolCallId === call!.toolCallId && n.shellState === "started");
      const result = notices.find(n => n.commandToolCallId === call!.toolCallId && n.shellState === "completed");
      const terminal = runEvents.find(r => r.eventType === "turn.completed" && r.payload?.prpEvent?.turnId === call!.turnId)?.payload.prpEvent;
      if (remote) await sealRemote();
      const remoteAttached = remote ? assertCopilotRemoteAttached(sealed!, baseline!, terminal ? Date.parse(terminal.emittedAt) : NaN) : undefined;
      const external = remoteAttached ? { ...remoteAttached, childGone: true, clientGone: true,
        commandExit: { ...remoteAttached.commandExit!, ownedProcessIdentityVerified: true, commandSha256: exactCommand()!.commandSha256 } } : localExternal!;
      check("trusted-command-exit", !external.failure && external.connections === 1 && external.childGone && external.clientGone, "Fixed controller-owned child exited and its native client is gone");
      const markerMatches = remote ? sealed!.targets[`copilot-settlement-${nonce}.txt`]?.sha256 === `sha256:${createHash("sha256").update(remoteMarker).digest("hex")}` : localMarkerMatches!;
      check("native-client-before-terminal", Boolean(terminal) && external.clientExitedAtMs !== null && external.clientExitedAtMs < Date.parse(terminal.emittedAt), "Independent PID/start observation confirms native client retirement before turn completion");
      check("marker-before-terminal", Boolean(terminal) && external.markerWrittenAtMs !== null && external.markerWrittenAtMs < Date.parse(terminal.emittedAt), "The independent fixture wrote its undisclosed marker before turn completion");
      const afterCleanupMarkerMatches = remote ? await readCopilotRemoteMarkerAfterRetirement(remoteFixture!, baseline!, `copilot-settlement-${nonce}.txt`, remoteMarker) : localAfterCleanupMarkerMatches!;
      const grade = gradeCopilotAttachedSettlement({ expected: copilotOrigin(call!), nativeCall: call ? { ...call, operation: call.operation!, mode: call.mode!, detach: call.detach!, commandSha256: call.commandSha256! } : null,
        expectedCommand: exactCommand()!.command, expectedCommandSha256: exactCommand()!.commandSha256, commandMatch: matched!.match, commandExit: external.commandExit,
        expectedShellId: started?.shellId ?? "", nativeShellResult: result ? { ...result, shellId: result.shellId!, commandToolCallId: result.commandToolCallId!, status: result.status!, exitCode: result.exitCode! } : null,
        terminal: terminal ? { observedAtMs: Date.parse(terminal.emittedAt), runId: terminal.runId, turnId: terminal.turnId, status: "succeeded" } : null,
        cleanup: { observedAtMs: remote ? sealed!.observedAtMs : Date.now(), ownedProcessesRemaining: processes.live.length }, terminalMarkerMatches: markerMatches, afterCleanupMarkerMatches });
      await input.evidence("copilot-attached-proof.json", { external, processes, notices, grade, commandSha256: exactCommand()!.commandSha256, commandMatch: matched!.match, markerMatches, afterCleanupMarkerMatches });
      check("attached-settlement-before-terminal", grade.passed, grade.failures.join(", ") || "Owned finite process and native shell settled before the actual turn terminal");
    }
    await load(); check("one-native-run", runs.length === 1 && runs[0]!.runtimeMode === "native", "Exactly one native run was accounted");
    const comments = await api.get<Row[]>(`/api/issues/${issue.id}/comments`), interactions = await api.get<Row[]>(`/api/issues/${issue.id}/interactions`);
    await input.evidence("api-state.json", { issue, run: runs[0], runs, comments, interactions, checks, runEvents, runEventsByRun: [{ runId: runs[0]!.id, events: runEvents }] });
    await page.reload();
    const label = deny ? "In Progress" : "Done";
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: `Change status (current: ${label})`, exact: true })).toBeVisible();
    if (!deny) check("exact-completion-marker", comments.filter(c => c.authorAgentId === fixtures.agent.id && c.body?.trim() === execution.task.buildVisibleMarker(nonce)).length === 1, "The successful attached task has exactly one terminal marker");
    await input.capture("final-state", "Copilot protection outcome", "final-state.png");
    return { issue, runs, checks };
  } finally {
    watchReceipt ??= watcher?.finish();
    try { await command?.close(); }
    finally { await input.evidence("copilot-protection-checks.json", { issue, runs, checks, fileObservations, watchReceipt, processes, remoteSnapshots, sealed }); }
  }
}
