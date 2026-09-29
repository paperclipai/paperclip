import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { copilotOrigin, readCopilotToolEvidence, type CopilotToolNotice } from "./copilot-evidence.js";
import { createAttachedCommandFixture, exists, observeRunProcesses, watchDeniedTarget } from "./copilot-local-fixtures.js";
import { gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite, type CopilotDeniedWriteEvidence } from "./copilot-protection-cases.js";
import { countCopilotToolOrigins, readCopilotMarkerAfterCleanup } from "./copilot-protection-evidence.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };
export async function runCopilotProtectionFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string; workspacePath: string; deadlineAt: number;
  observe(issue: Row, runs: Row[]): void; capture(id: string, label: string, file: string): Promise<void>; evidence(name: string, data: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce, workspacePath } = input;
  if (execution.environment.id !== "local" || execution.profile.qualificationCandidate !== "copilot") throw new Error("Copilot protection fixtures require the isolated local candidate");
  const deny = execution.task.id === "native-permission-deny-write";
  if (!deny && execution.task.id !== "attached-async-settlement") throw new Error("Unknown Copilot protection case");
  const checks: Check[] = []; let issue: Row = {}, runs: Row[] = [], runEvents: Row[] = [];
  let notices: CopilotToolNotice[] = [];
  const processObserver = observeRunProcesses(); let processes = processObserver.sample();
  const target = `copilot-denied-${nonce}.txt`, targetPath = join(workspacePath, target);
  const fileObservations: CopilotDeniedWriteEvidence["fileObservations"] = [];
  const sample = async (phase: CopilotDeniedWriteEvidence["fileObservations"][number]["phase"]) => { fileObservations.push({ phase, observedAtMs: Date.now(), exists: await exists(targetPath) }); };
  const watcher = deny ? watchDeniedTarget(workspacePath, target) : undefined;
  const markerPath = join(workspacePath, `copilot-settlement-${nonce}.txt`);
  const command = deny ? undefined : await createAttachedCommandFixture(markerPath);
  let watchReceipt: ReturnType<ReturnType<typeof watchDeniedTarget>["finish"]> | undefined;
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
    processes = processObserver.sample(run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined);
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
    if (deny) { await sample("before-request"); check("target-initially-absent", !fileObservations[0]!.exists, "The exact isolated target is absent before dispatch"); }
    const prompt = `${execution.task.buildPrompt(nonce)}${command ? `\nThe exact supplied command is:\n${command.command}\nDo not inspect or modify fixture code, fabricate its marker, or launch a substitute command.` : ""}`;
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt, workMode: "standard", projectName: project.name });
    const found = await pollUntil({ label: "browser-created Copilot protection task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(r => r.title === execution.task.buildTitle(nonce)), accept: Boolean });
    if (!found) throw new Error("Browser-created task was not found"); issue = found;
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    if (deny) {
      await wait("exact native write permission", s => s.notices.some(n => n.stage === "permission_requested" && n.operation === "edit" && n.target === target && n.declineOffered && s.runEvents.some(r => r.eventType === "runtime_request.created" && r.payload?.prpEvent?.payload?.request?.requestId === n.requestId)));
      const request = notices.find(n => n.stage === "permission_requested" && n.operation === "edit" && n.target === target)!;
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
      await wait("delivered rejection and failed native edit", s => s.notices.some(n => n.stage === "permission_delivered" && n.requestId === request.requestId && n.outcome === "reject_once") && s.notices.some(n => n.stage === "tool" && n.toolCallId === request.toolCallId && n.status === "failed"));
      await sample("after-decision");
      const cancelRequestedAtMs = Date.now(); await api.post(`/api/heartbeat-runs/${request.runId}/cancel`);
      await wait("explicitly cancelled native run and retired processes", s => s.runs[0]?.status === "cancelled" && s.processes.captured && s.processes.live.length === 0);
      await sample("terminal"); await new Promise(resolve => setTimeout(resolve, 100)); await load(); await sample("after-cleanup");
      watchReceipt = watcher!.finish();
      const cancellation = runs[0]!.resultJson?.nativeCancellation;
      const toolResult = notices.find(n => n.stage === "tool" && n.toolCallId === request.toolCallId && n.status === "failed")!;
      const terminalFrame = runEvents.find(r => ["turn.cancelled", "turn.interrupted"].includes(r.eventType) && r.payload?.prpEvent?.turnId === request.turnId)?.payload.prpEvent;
      check("correlated-cancel-terminal", Boolean(terminalFrame) && terminalFrame.runId === request.runId, "An actual durable cancellation terminal belongs to the denied turn");
      const terminalAt = Date.parse(terminalFrame.emittedAt);
      const evidence: CopilotDeniedWriteEvidence = {
        expected: copilotOrigin(request), requestId: request.requestId!, expectedRelativePath: target,
        request: { ...request, requestId: request.requestId!, targetRelativePath: request.target!, method: "session/request_permission", offeredActions: request.declineOffered ? ["decline"] : [] },
        decision: { ...request, observedAtMs: clickedAtMs, requestId: request.requestId!, browserRequestId: request.requestId!, action: "decline" },
        deliveredDecision: (() => { const n = notices.find(n => n.stage === "permission_delivered" && n.requestId === request.requestId && n.outcome === "reject_once"); return n ? { ...n, requestId: n.requestId!, outcome: n.outcome! } : null; })(),
        toolResult: { ...toolResult, status: "failed" },
        terminal: { runId: terminalFrame.runId, turnId: terminalFrame.turnId, observedAtMs: terminalAt, status: runs[0]!.status },
        cancellation: { requestedAtMs: cancelRequestedAtMs, acknowledged: cancellation?.dispatchState === "acknowledged" && cancellation?.dispatched === true, scope: cancellation?.scope },
        cleanup: { observedAtMs: fileObservations.at(-1)!.observedAtMs, ownedProcessesRemaining: processes.live.length }, fileObservations, mutationObservation: watchReceipt,
        nativeAttemptsForTarget: countCopilotToolOrigins(notices.filter(n => n.operation === "edit" && n.target === target)),
      };
      await input.evidence("copilot-denial-proof.json", { evidence, processes, notices });
      const grade = gradeCopilotDeniedWrite(evidence); check("denial-without-side-effects", grade.passed, grade.failures.join(", ") || "Exact browser denial, explicit cancellation and absence through process cleanup");
      check("negative-task-unfinished", issue.status === "in_progress", "The negative test does not claim the task is done");
      check("no-extra-native-operation", countCopilotToolOrigins(notices) === 1, "No alternate native edit, command or delegated operation is permitted");
    } else {
      await wait("attached command and task settlement", s => s.issue.status === "done" && s.runs[0]?.status === "succeeded" && s.processes.captured && s.processes.live.length === 0);
      const call = notices.find(n => n.stage === "tool" && n.status === "pending" && n.commandSha256 === command!.commandSha256);
      check("single-exact-command", Boolean(call) && countCopilotToolOrigins(notices.filter(n => n.commandSha256 === command!.commandSha256)) === 1, "Exactly one native execution contains the supplied command digest");
      const started = notices.find(n => n.toolCallId === call!.toolCallId && n.shellState === "started");
      const result = notices.find(n => n.commandToolCallId === call!.toolCallId && n.shellState === "completed");
      const terminal = runEvents.find(r => r.eventType === "turn.completed" && r.payload?.prpEvent?.turnId === call!.turnId)?.payload.prpEvent;
      const external = command!.snapshot();
      check("trusted-command-exit", !external.failure && external.connections === 1 && external.childGone && external.clientGone, "Fixed controller-owned child exited and its native client is gone");
      const markerMatches = await readFile(markerPath, "utf8") === command!.marker;
      check("native-client-before-terminal", Boolean(terminal) && external.clientExitedAtMs !== null && external.clientExitedAtMs < Date.parse(terminal.emittedAt), "Independent PID/start observation confirms native client retirement before turn completion");
      check("marker-before-terminal", Boolean(terminal) && external.markerWrittenAtMs !== null && external.markerWrittenAtMs < Date.parse(terminal.emittedAt), "The independent fixture wrote its undisclosed marker before turn completion");
      const afterCleanupMarkerMatches = await readCopilotMarkerAfterCleanup(() => command!.close(), markerPath, command!.marker);
      const grade = gradeCopilotAttachedSettlement({ expected: copilotOrigin(call!), nativeCall: call ? { ...call, operation: call.operation!, mode: call.mode!, detach: call.detach!, commandSha256: call.commandSha256! } : null,
        expectedCommandSha256: command!.commandSha256, commandExit: external.commandExit,
        expectedShellId: started?.shellId ?? "", nativeShellResult: result ? { ...result, shellId: result.shellId!, commandToolCallId: result.commandToolCallId!, status: result.status!, exitCode: result.exitCode! } : null,
        terminal: terminal ? { observedAtMs: Date.parse(terminal.emittedAt), runId: terminal.runId, turnId: terminal.turnId, status: "succeeded" } : null,
        cleanup: { observedAtMs: Date.now(), ownedProcessesRemaining: processes.live.length }, terminalMarkerMatches: markerMatches, afterCleanupMarkerMatches });
      await input.evidence("copilot-attached-proof.json", { external, processes, notices, grade, commandSha256: command!.commandSha256, markerMatches, afterCleanupMarkerMatches });
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
    finally { await input.evidence("copilot-protection-checks.json", { issue, runs, checks, fileObservations, watchReceipt, processes }); }
  }
}
