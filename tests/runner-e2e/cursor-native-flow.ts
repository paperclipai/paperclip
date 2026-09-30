import { isDeepStrictEqual } from "node:util";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { observeRunProcesses, createDeniedTargetFixture } from "./copilot-local-fixtures.js";
import { cursorDeniedCommand, hasCursorDeniedCommand, hasCursorCancellation, readCursorToolEvidence, assertCursorRemoteSnapshot, cursorRemoteDeniedSample, hasCursorRemoteRetirement, hasCursorRemoteWorkspaceUnchanged, type CursorRemoteSnapshot, type CursorRemoteBinding, type CursorToolNotice } from "./cursor-native-evidence.js";
import { cursorNativeCaseDesigns, cursorNativePlanArtifactGate, hasCursorDenialBoundary, hasCursorPlanDecision, hasDeliveredCursorNativeRequest, hasExactCursorNativeResponse, type CursorNativeMethod } from "./cursor-native-cases.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };

/** Select only the exact native callback, including either production ACPX bridge. */
export function findCursorNativeRequest(rows: Row[], method: CursorNativeMethod, requestId?: string): Row | undefined {
  return rows.map(row => row.payload?.prpEvent).find(event => event?.eventType === "runtime_request.created"
    && hasAcpxNativeOrigin(event.payload?.request?.origin, "cursor", method)
    && (!requestId || event.payload.request.requestId === requestId));
}

/** JSON object key order may change during persistence; array order and values may not. */
export function hasCursorNativeCardBinding(card: Row, event: Row, runId: string): boolean {
  return card.sourceRunId === runId && card.continuationPolicy === "none"
    && isDeepStrictEqual(card.payload.questionSet, event.payload.request.input);
}

/** This is a successful planning boundary, not an implementation/completion claim. */
export function hasCursorAcceptedPlanWait(state: { issue: Row; runs: Row[]; interactions: Row[] }): boolean {
  if (state.runs.length !== 1 || state.issue.status !== "in_progress" || state.interactions.some(card => card.status === "pending")) return false;
  const run = state.runs[0]!;
  return run.status === "succeeded" && run.runtimeMode === "native" && run.nativeIssueId === state.issue.id
    && run.runnerProfileJson?.nativeExecutionInput?.provider?.cursorMode === "plan"
    && run.resultJson?.finalizationPhase === "committed"
    && run.resultJson?.finalizationReasonCode === "native_plan_accepted_waiting_for_continuation"
    && run.resultJson?.authoritativeDecision === "in_progress";
}

export interface CursorRemoteNativeFixture {
  binding: CursorRemoteBinding; remoteCwd: string; actionFile: string;
  snapshot(label: string): Promise<CursorRemoteSnapshot>;
  finish(): Promise<CursorRemoteSnapshot>;
  close(): Promise<void>;
}
export interface CursorRemoteBootstrap {
  prompt(nonce: string): string;
  bindAndRelease(input: { issueId: string; runId: string; targets: string[];
    actionPrompt(fixture: CursorRemoteNativeFixture): Promise<string> | string }): Promise<CursorRemoteNativeFixture>;
}


/** Runs inside the awaited bootstrap callback, before action publication. */
export async function prepareCursorRemoteAction(input: {
  fixture: CursorRemoteNativeFixture; companyId: string; environmentId: string; runId: string;
  prompt: string; deniedRelative?: string;
}) {
  const { fixture } = input;
  if (fixture.binding.runId !== input.runId || fixture.binding.companyId !== input.companyId || fixture.binding.environmentId !== input.environmentId || fixture.remoteCwd !== fixture.binding.remoteCwd) throw new Error("Cursor bootstrap lease belongs to another run or workspace");
  const baseline = await fixture.snapshot("before-action-publication");
  assertCursorRemoteSnapshot(baseline, fixture.binding);
  const initial = input.deniedRelative ? cursorRemoteDeniedSample(baseline, fixture.binding, input.deniedRelative, "before-request") : null;
  if (initial && !initial.absent) throw new Error("Remote denied target was present before action publication");
  const command = initial ? cursorDeniedCommand(initial.path) : null;
  return { baseline, initial, command, prompt: input.prompt + (command ? `\nExact native shell command (copy verbatim):\n${command.command}` : "") };
}

/** Match canonical omission of an unanswered optional feedback field. */
export function cursorNativePlanResponse(planId: string, decision: "accept" | "reject" | "cancel", feedback: string) {
  return { schema: "paperclip.question_response.v1", answers: { [planId]: { selectedOptionIds: [decision] }, ...(decision === "reject" ? { reason: { text: feedback } } : {}) } };
}

/** Independent bounded snapshot; symlinks are rejected without following them. */
export async function cursorNativeWorkspaceSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}; let bytes = 0;
  async function scan(relative = "") {
    for (const entry of (await readdir(join(root, relative))).sort()) {
      const name = relative ? `${relative}/${entry}` : entry; const path = join(root, name); const stat = await lstat(path);
      if (Object.keys(files).length >= 2048) throw new Error("Cursor workspace proof exceeds file bound");
      if (stat.isSymbolicLink()) throw new Error("Cursor workspace proof cannot authorize a symlink");
      if (stat.isDirectory()) { files[`${name}/`] = "directory"; await scan(name); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("Cursor workspace proof exceeds byte bound");
        files[name] = createHash("sha256").update(await readFile(path)).digest("hex");
      } else throw new Error("Cursor workspace proof found a special file");
    }
  }
  await scan(); return files;
}

export async function runCursorNativeFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; deadlineAt: number;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
  registerCleanupAssertion?(assertion: () => Promise<Check[]>): void;
  registerBeforeEnvironmentTeardownAssertion?(assertion: () => Promise<Check[]>): void;
  remoteBootstrap?: CursorRemoteBootstrap;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const design = cursorNativeCaseDesigns.find(value => value.id === execution.task.id);
  const remote = execution.environment.id === "daytona";
  if (!design || !["local", "daytona"].includes(execution.environment.id) || execution.profile.qualificationCandidate !== "cursor") throw new Error("Cursor native fixtures require an explicit isolated Cursor candidate");
  if (remote && (!input.remoteBootstrap || !input.registerBeforeEnvironmentTeardownAssertion)) throw new Error("Cursor Daytona requires an owned pre-action observer and pre-teardown verification");
  if (!remote && ["native-write-deny-reconnect", "native-plan-reject-revise-accept"].includes(design.id) && !input.registerCleanupAssertion) throw new Error("Cursor denial requires authoritative post-cleanup verification");
  const checks: Check[] = []; let issue: Row = {}; let runs: Row[] = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const events = (runId: string) => collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const absent = async (path: string) => { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
  const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
  const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxSessionMode: design.cursorMode, acpxPermissionMode: design.permissionMode, ...(remote || design.id === "native-write-deny-reconnect" ? { lifecycleMode: "per_turn", timeoutSec: 120 } : {}) } });
  check("explicit-mode-policy", configured.adapterConfig.acpxSessionMode === design.cursorMode && configured.adapterConfig.acpxPermissionMode === design.permissionMode, "Public agent configuration selected mode and permission policy separately before provider startup");
  if (remote || design.id === "native-write-deny-reconnect") check("per-turn-process-authority", configured.adapterConfig.lifecycleMode === "per_turn" && configured.adapterConfig.timeoutSec === 120, "Public configuration admits a bounded per-turn provider process before startup");
  await input.evidence("cursor-native-contract.json", { caseId: design.id, mode: design.cursorMode, permissionMode: design.permissionMode, method: design.method, expectedRunCount: 1, nativeCallbackRequired: true, artifactGate: cursorNativePlanArtifactGate });
  const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, {
    name: `Cursor native workspace ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } },
    workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true },
  });
  const baseline = remote ? null : await cursorNativeWorkspaceSnapshot(input.workspacePath);
  let remoteFixture: CursorRemoteNativeFixture | null = null; let remoteFinal: CursorRemoteSnapshot | null = null; let remoteBaseline: CursorRemoteSnapshot | null = null;
  let remoteParent: { dev: string; ino: string } | undefined;
  const sampleWorkspace = async (phase: string) => {
    if (remote) {
      if (!remoteFixture) throw new Error("Cursor remote workspace observer is absent");
      const current = remoteFinal ?? await remoteFixture.snapshot(phase);
      await input.evidence(`cursor-workspace-${phase}.json`, { baseline: remoteBaseline, current });
      check(`workspace-unchanged-${phase}`, hasCursorRemoteWorkspaceUnchanged(current, remoteBaseline!), "Owned remote workspace hashes and continuous mutation journal remain unchanged");
      return;
    }
    const current = await cursorNativeWorkspaceSnapshot(input.workspacePath);
    await input.evidence(`cursor-workspace-${phase}.json`, { baseline, current });
    check(`workspace-unchanged-${phase}`, JSON.stringify(current) === JSON.stringify(baseline), "Independent workspace bytes remain unchanged by a pending/rejected/cancelled native plan or question");
  };
  const localDeniedTarget = !remote && design.id === "native-write-deny-reconnect" ? await createDeniedTargetFixture(input.workspacePath, `cursor-denied-${nonce}.txt`) : null;
  const deniedRelative = localDeniedTarget?.targetRelativePath ?? `cursor-denied-${nonce}.txt`;
  let deniedPath = remote ? "" : join(input.workspacePath, deniedRelative);
  let deniedCommand = remote ? null : cursorDeniedCommand(deniedPath);
  let denialNotices: CursorToolNotice[] = []; let denialRunEvents: Row[] = []; let denialTurnId = ""; let cancelRequestedAt = NaN; let cancellationProven = false;
  const samples: Array<{ phase: string; path: string; absent: boolean; observedAt: number }> = [];
  const sampleDenied = async (phase: string, retained?: CursorRemoteSnapshot) => {
    let sample: { phase: string; path: string; absent: boolean; observedAt: number };
    if (remote) {
      if (!remoteFixture) throw new Error("Cursor remote denied-target observer is absent");
      sample = cursorRemoteDeniedSample(retained ?? remoteFinal ?? await remoteFixture.snapshot(phase), remoteFixture.binding, deniedRelative, phase, remoteParent);
    } else sample = { phase, path: deniedPath, absent: await absent(deniedPath), observedAt: Date.now() };
    samples.push(sample); await input.evidence("cursor-denial-samples.json", samples); check(`denied-absent-${phase}`, sample.absent, "Independent denied target remains absent");
  };
  const processObserver = remote ? null : observeRunProcesses(); let processAuthority: string | null = null; let processObservationError = false;
  const observeProcesses = () => {
    const run = runs[0];
    const authority = run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined;
    if (authority) {
      const key = JSON.stringify(authority);
      if (processAuthority !== null && processAuthority !== key) processObservationError = true;
      processAuthority ??= key;
    }
    return processObserver ? processObserver.sample(authority) : { captured: false, journal: [], live: [] };
  };
  let processes = observeProcesses();
  let deniedRequest: Row | null = null;
  let processTimer: ReturnType<typeof setInterval> | undefined;
  const watch = localDeniedTarget?.watcher ?? null;
  if (watch) {
    processTimer = setInterval(() => { try { processes = observeProcesses(); } catch { processObservationError = true; } }, 250);
    input.registerCleanupAssertion!(async () => {
      const cleanupChecks: Check[] = [];
      const finalCheck = (id: string, passed: boolean, detail: string) => { cleanupChecks.push({ id, passed, detail }); };
      try {
        if (issue.id) await load();
        processes = observeProcesses();
        if (processes.captured && processes.live.length > 0 && !processObservationError) {
          processes = await pollUntil({ label: "observed Cursor provider retirement", deadlineAt: Date.now() + 5_000,
            load: async () => observeProcesses(), accept: observation => observation.live.length === 0 });
        }
        const settled = runs.length === 1 && runs[0]!.status === "cancelled" && issue.status === "in_progress" && cancellationProven;
        finalCheck("authoritative-provider-cleanup", settled && !processObservationError && processes.captured && processes.live.length === 0, "Exact API-bound per-turn process/start/group and observed descendants have retired");
        const finalSample = { phase: "after-cleanup", path: deniedPath, absent: await absent(deniedPath), observedAt: Date.now() };
        samples.push(finalSample);
        finalCheck("denied-absent-after-cleanup", finalSample.absent, "Independent target remains absent after observed provider retirement");
        const journal = watch.finish();
        finalCheck("continuous-denial-observation", journal.complete && journal.targetMutationCount === 0, "Continuous target watcher observed no create/delete mutation and retained directory identity");
        finalCheck("complete-native-denial-boundary", Boolean(deniedRequest) && hasCursorDenialBoundary({ request: deniedRequest, expectedRequestId: deniedRequest?.requestId ?? "", expectedToolCallId: deniedRequest?.details.toolCallId ?? "", path: deniedPath, bootstrapReadProof: remoteFixture ? { actionFile: remoteFixture.actionFile, events: denialRunEvents } : undefined, samples, notices: denialNotices, runId: runs[0]?.id ?? "", turnId: denialTurnId }), "Supported native denial preserved the target through all six independent boundaries");
        await input.evidence("cursor-native-denial-final.json", { request: deniedRequest, samples, notices: denialNotices, commandSha256: deniedCommand!.commandSha256, cancellationProven, cancelRequestedAt, processes, processObservationError, watcher: journal, checks: cleanupChecks });
        if (cleanupChecks.some(row => !row.passed)) throw new Error("Cursor native denial cleanup proof is incomplete or observed an effect");
        return cleanupChecks;
      } finally {
        clearInterval(processTimer);
        await input.evidence("cursor-native-denial-cleanup-attempt.json", { request: deniedRequest, samples, notices: denialNotices, commandSha256: deniedCommand!.commandSha256, cancellationProven, cancelRequestedAt, processes, processObservationError, watcher: watch.finish(), checks: cleanupChecks });
      }
    });
  }
  if (remote) input.registerBeforeEnvironmentTeardownAssertion!(async () => {
    const cleanupChecks: Check[] = []; let snapshot: CursorRemoteSnapshot | null = null;
    const finalCheck = (id: string, passed: boolean, detail: string) => { cleanupChecks.push({ id, passed, detail }); };
    try {
      if (!remoteFixture) throw new Error("Cursor remote observer never acquired authoritative baseline");
      if (issue.id) await load();
      snapshot = remoteFinal ?? await remoteFixture.finish(); remoteFinal = snapshot;
      finalCheck("remote-provider-retired", runs.length === 1 && remoteBaseline !== null && snapshot.observedAtMs >= remoteBaseline.observedAtMs && hasCursorRemoteRetirement(snapshot, remoteFixture.binding), "Exact remote run PID/start/boot identity and all observed descendants retired before the retained receipt sealed");
      if (design.id === "native-write-deny-reconnect") {
        await sampleDenied("after-cleanup", snapshot);
        finalCheck("remote-cancel-terminal", cancellationProven && runs[0]?.status === "cancelled" && issue.status === "in_progress", "Explicit native cancellation remains durable without false task completion");
        finalCheck("remote-no-denied-effect", snapshot.watcher.targetMutationCount === 0 && Boolean(deniedRequest) && hasCursorDenialBoundary({ request: deniedRequest, expectedRequestId: deniedRequest?.requestId ?? "", expectedToolCallId: deniedRequest?.details.toolCallId ?? "", path: deniedPath, bootstrapReadProof: remoteFixture ? { actionFile: remoteFixture.actionFile, events: denialRunEvents } : undefined, samples, notices: denialNotices, runId: runs[0]?.id ?? "", turnId: denialTurnId }), "Exact denied native command caused no remote file effect through provider retirement");
      } else {
        if (design.id === "native-plan-reject-revise-accept") finalCheck("remote-plan-still-passive", hasCursorAcceptedPlanWait(await load()), "Accepted planning remains passive through remote retirement without an automatic follow-up run");
        finalCheck("remote-no-workspace-effects", hasCursorRemoteWorkspaceUnchanged(snapshot, remoteBaseline!), "Native question or cancelled plan caused no remote workspace mutation through retirement");
      }
      if (cleanupChecks.some(row => !row.passed)) throw new Error("Cursor remote cleanup evidence is incomplete or observed an effect");
      return cleanupChecks;
    } finally {
      try { await input.evidence("cursor-remote-cleanup.json", { snapshot, samples, notices: denialNotices, cancellationProven, checks: cleanupChecks }); }
      finally { await remoteFixture?.close(); }
    }
  });
  const load = async () => {
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); input.observe(issue, runs);
    if (watch) processes = observeProcesses();
    const interactions = await api.get<Row[]>(`/api/issues/${issue.id}/interactions`);
    const runEvents = runs.length === 1 ? await events(runs[0]!.id) : [];
    if (design.id === "native-write-deny-reconnect" && runs.length === 1) { denialRunEvents = runEvents; denialNotices = readCursorToolEvidence(runEvents, runs[0]!.id); }
    return { issue, runs, interactions, runEvents };
  };
  if (!remote && design.id === "native-plan-reject-revise-accept") input.registerCleanupAssertion!(async () => {
    const current = await load();
    const currentWorkspace = await cursorNativeWorkspaceSnapshot(input.workspacePath);
    const cleanupChecks = [
      { id: "plan-still-passive-after-cleanup", passed: hasCursorAcceptedPlanWait(current), detail: "One succeeded planning run remains unfinished without automatic follow-up through fixture cleanup" },
      { id: "plan-workspace-unchanged-after-cleanup", passed: isDeepStrictEqual(currentWorkspace, baseline), detail: "Accepted planning caused no workspace effect through fixture cleanup" },
    ];
    await input.evidence("cursor-native-plan-wait-cleanup.json", { ...current, baseline, currentWorkspace, checks: cleanupChecks });
    if (cleanupChecks.some(row => !row.passed)) throw new Error("Accepted Cursor plan did not remain a passive no-effect boundary");
    return cleanupChecks;
  });
  const reject = (state: Awaited<ReturnType<typeof load>>) => state.runs.length > 1 ? "Unexpected extra Cursor provider run" : state.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Cursor provider run failed" : undefined;
  async function pending(seen: Set<string>) {
    const state = await pollUntil({ label: "exact native Cursor callback", deadlineAt: input.deadlineAt, load,
      reject: state => reject(state) ?? (state.runs.some(run => run.status === "succeeded") ? "Native Cursor callback was not observed before completion; qualification remains pending" : undefined),
      accept: state => state.interactions.some(card => card.status === "pending" && !seen.has(card.id) && card.payload?.runtimeRequestId && findCursorNativeRequest(state.runEvents, design!.method, card.payload.runtimeRequestId)) });
    const cards = state.interactions.filter(card => card.status === "pending"); check("single-native-request", cards.length === 1 && state.runs.length === 1, "Exactly one native request belongs to one original provider run");
    const card = cards[0]!; const event = findCursorNativeRequest(state.runEvents, design!.method, card.payload.runtimeRequestId)!;
    check("native-card-binding", hasCursorNativeCardBinding(card, event, state.runs[0]!.id), "Durable card retains complete native input and exact source run");
    await input.evidence(`cursor-native-${seen.size}-pending.json`, { card, event });
    await page.reload(); const reloaded = (await load()).interactions.find(row => row.id === card.id);
    check("browser-reconnect-identity", reloaded?.status === "pending" && reloaded?.payload.runtimeRequestId === card.payload.runtimeRequestId, "Browser reconnect preserves exact outstanding native request");
    await input.capture(`cursor-native-${seen.size}`, "Native Cursor request pending", `cursor-native-${seen.size}.png`);
    return { card, event };
  }
  async function delivery(card: Row, event: Row, response: Row) {
    const identity = { runId: runs[0]!.id, turnId: event.turnId, requestId: card.payload.runtimeRequestId, method: design!.method, action: "submit" as const, response };
    const state = await pollUntil({ label: "native response stream delivery", deadlineAt: input.deadlineAt, load, reject,
      accept: state => state.interactions.some(row => row.id === card.id && row.status === "answered") && hasExactCursorNativeResponse({ ...identity, events: state.runEvents }) });
    check("exact-native-delivery", hasExactCursorNativeResponse({ ...identity, events: state.runEvents }), "Exact displayed answer reached the native response writer and produced one ordered delivery receipt");
    await input.evidence(`cursor-native-${card.id}-delivered.json`, { interaction: state.interactions.find(row => row.id === card.id), events: state.runEvents, response });
  }
  let expectedMarker = execution.task.buildVisibleMarker(nonce);
  try {
    if (!remote && design.id === "native-write-deny-reconnect") await sampleDenied("before-request");
    await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title: execution.task.buildTitle(nonce), prompt: remote ? input.remoteBootstrap!.prompt(nonce) : execution.task.buildPrompt(nonce) + (watch ? `\nExact native shell command (copy verbatim):\n${deniedCommand!.command}` : ""), workMode: "standard", projectName: project.name });
    issue = await pollUntil({ label: "browser-created Cursor task", deadlineAt: input.deadlineAt, load: async () => (await api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)).find(row => row.title === execution.task.buildTitle(nonce)), accept: Boolean }) ?? {};
    if (!issue.id) throw new Error("Browser-created Cursor task is absent");
    if (remote) {
      const started = await pollUntil({ label: "exact Cursor bootstrap run", deadlineAt: input.deadlineAt, load, reject,
        accept: state => state.runs.length === 1 });
      const runId = started.runs[0]!.id;
      const boundFixture = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId,
        targets: design.id === "native-write-deny-reconnect" ? [deniedRelative] : [],
        actionPrompt: async fixture => {
          if (remoteFixture) throw new Error("Cursor remote action was published more than once");
          remoteFixture = fixture;
          const prepared = await prepareCursorRemoteAction({ fixture, runId, companyId: fixtures.company.id, environmentId: fixtures.environment.id,
            prompt: execution.task.buildPrompt(nonce), ...(design.id === "native-write-deny-reconnect" ? { deniedRelative } : {}) });
          remoteBaseline = prepared.baseline;
          if (prepared.initial && prepared.command) {
            deniedPath = prepared.initial.path; deniedCommand = prepared.command; remoteParent = prepared.initial.parent; samples.push(prepared.initial);
          }
          return prepared.prompt;
        } });
      if (!remoteFixture || boundFixture !== remoteFixture || boundFixture.binding.runId !== runId) throw new Error("Cursor remote observer is missing its run binding");
      await input.evidence("cursor-remote-baseline.json", remoteBaseline);
    }
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const seen = new Set<string>();
    if (design.id === "native-question-reconnect") {
      const { card, event } = await pending(seen); const questions = card.payload.questionSet.questions;
      if (remote) await sampleWorkspace("question-pending");
      check("native-question-shape", questions.length === 2 && questions[0].answerMode === "single_select" && questions[1].answerMode === "multi_select", "Native single/multiple choice shape is preserved");
      const color = randomBytes(1)[0]! % 2 === 0 ? "Cobalt" : "Amber";
      const trees = randomBytes(1)[0]! % 2 === 0 ? ["Cedar", "Maple"] : ["Maple"];
      await page.getByRole("radio", { name: color, exact: true }).last().click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      for (const tree of trees) await page.getByRole("checkbox", { name: tree, exact: true }).last().click();
      const answers = Object.fromEntries(questions.map((question: Row, index: number) => [question.id, { selectedOptionIds: (index === 0 ? [color] : trees).map(label => question.options.find((option: Row) => option.label === label)?.id) }]));
      await page.getByRole("button", { name: card.payload.questionSet.submitLabel ?? "Submit answers", exact: true }).last().click();
      await delivery(card, event, { schema: "paperclip.question_response.v1", answers });
      expectedMarker = `CURSOR-NATIVE-${nonce}-${color.toLowerCase()}-${trees.map(tree => tree.toLowerCase()).sort().join("+")}`;
      await sampleWorkspace("question-delivered");
    } else if (design.method === "cursor/create_plan") {
      const decisions = design.id === "native-plan-cancel" ? ["cancel"] as const : ["reject", "accept"] as const;
      const feedbackMarker = `revision-${randomBytes(12).toString("hex")}`;
      const feedback = `Include verification marker ${feedbackMarker} in the revised plan.`; let previousRevision: string | null = null;
      for (const decision of decisions) {
        const { card, event } = await pending(seen); const set = card.payload.questionSet; const plan = set.questions.find((question: Row) => /^plan-[a-f0-9]{64}$/.test(question.id));
        check("full-plan-revision", typeof set.description === "string" && set.description.length > 0 && Boolean(plan) && plan.id !== previousRevision, "Complete native plan and a distinct content-bound revision are retained");
        if (decision === "accept") check("revision-feedback", set.description.includes(feedbackMarker), "Revised native plan contains exact undisclosed rejection feedback");
        for (const marker of [`CURSOR-PLAN-BEGIN-${nonce}`, `CURSOR-PLAN-END-${nonce}`]) {
          check("complete-plan-boundary", set.description.includes(marker), "Retained native plan includes its full document boundaries");
          await expect(page.getByRole("region", { name: "Question context" }).last()).toContainText(marker);
        }
        await sampleWorkspace(`plan-${decision}-pending`);
        await page.getByRole("radio", { name: decision === "accept" ? "Accept plan" : decision === "reject" ? "Reject plan" : "Cancel plan request", exact: true }).last().click();
        await page.getByRole("button", { name: "Next", exact: true }).last().click();
        if (decision === "reject") await page.getByTestId("question-text-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(feedback);
        const response = cursorNativePlanResponse(plan.id, decision, feedback);
        check("revision-bound-decision", hasCursorPlanDecision(set, response, decision), "Decision addresses precisely the displayed native plan revision");
        await page.getByRole("button", { name: set.submitLabel ?? "Submit answers", exact: true }).last().click();
        await delivery(card, event, response); seen.add(card.id); previousRevision = plan.id;
        if (decision !== "accept") await sampleWorkspace(`plan-${decision}-delivered`);
      }
      await input.evidence("cursor-native-artifact-gap.json", cursorNativePlanArtifactGate);
    } else {
      const state = await pollUntil({ label: "native Cursor permission with exact command provenance", deadlineAt: input.deadlineAt, load, reject,
        accept: state => denialNotices.some(notice => notice.stage === "permission_requested" && notice.commandSha256 === deniedCommand!.commandSha256
          && Boolean(findCursorNativeRequest(state.runEvents, "session/request_permission", notice.requestId))) });
      const native = denialNotices.find(notice => notice.stage === "permission_requested" && notice.commandSha256 === deniedCommand!.commandSha256)!;
      const event = findCursorNativeRequest(state.runEvents, "session/request_permission", native.requestId)!; const request = event.payload.request; deniedRequest = request; denialTurnId = event.turnId;
      check("native-permission-identity", state.runs.length === 1 && request.details?.toolCallId === native.toolCallId && native.turnId === event.turnId && native.declineOffered && request.choices.some((choice: Row) => choice.key === "decline"), "Presented native permission is bound to the exact absolute-target command and supported denial choice");
      await sampleDenied("pending"); await page.reload();
      const reloaded = await load(); check("permission-reconnect", Boolean(findCursorNativeRequest(reloaded.runEvents, "session/request_permission", request.requestId)) && !reloaded.runEvents.some(row => row.payload?.prpEvent?.eventType === "runtime_request.resolved" && row.payload.prpEvent.payload?.requestId === request.requestId), "Reconnect preserves the unresolved native permission");
      await sampleDenied("browser-reconnected"); await input.capture("cursor-permission", "Native write permission awaiting denial", "cursor-permission.png");
      const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true }); await expect(card).toHaveCount(1);
      const label = request.choices.find((choice: Row) => choice.key === "decline").label;
      const route = `/api/heartbeat-runs/${native.runId}/runtime-requests/${encodeURIComponent(request.requestId)}/resolve`;
      const sent = page.waitForRequest(row => new URL(row.url()).pathname === route && row.method() === "POST");
      await card.getByRole("button", { name: label, exact: true }).click(); const posted = (await sent).postDataJSON();
      check("browser-exact-denial", posted.turnId === event.turnId && posted.requestKind === "permission_approval" && posted.resolution?.action === "decline", "Browser denied the exact native run/request/turn");
      const identity = { runId: native.runId, turnId: event.turnId, requestId: request.requestId, method: "session/request_permission" as const, action: "decline" as const };
      await pollUntil({ label: "native denial delivered and exact command failed", deadlineAt: input.deadlineAt, load, reject, accept: state => hasDeliveredCursorNativeRequest({ ...identity, events: state.runEvents })
        && hasCursorDeniedCommand({ notices: denialNotices, ...identity, toolCallId: native.toolCallId, commandSha256: deniedCommand!.commandSha256, bootstrapReadProof: remoteFixture ? { actionFile: remoteFixture.actionFile, events: denialRunEvents } : undefined }) });
      await sampleDenied("after-decision");
      cancelRequestedAt = Date.now(); await api.post(`/api/heartbeat-runs/${native.runId}/cancel`);
      const cancelled = await pollUntil({ label: "explicit native cancellation", deadlineAt: input.deadlineAt, load,
        reject: state => state.runs.length !== 1 || ["failed", "succeeded", "timed_out"].includes(state.runs[0]?.status) ? "Cursor denial did not remain cancellable" : undefined,
        accept: state => hasCursorCancellation({ run: state.runs[0], issue: state.issue, events: state.runEvents, runId: native.runId, turnId: event.turnId, requestedAt: cancelRequestedAt }) });
      cancellationProven = true;
      if (remote) remoteFinal = await remoteFixture!.finish();
      await sampleDenied("after-terminal", remoteFinal ?? undefined);
      check("negative-task-unfinished", cancelled.issue.status === "in_progress" && cancelled.runs[0]?.status === "cancelled" && cancelled.runs[0]?.runtimeMode === "native", "Native cancellation was acknowledged and the task does not falsely claim completion");
      await page.reload();
      await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: In Progress)", exact: true })).toBeVisible();
      const comments = await api.get<Row[]>(`/api/issues/${issue.id}/comments`);
      await input.evidence("api-state.json", { ...cancelled, run: runs[0], comments, checks, notices: denialNotices, commandSha256: deniedCommand!.commandSha256, cancelRequestedAt, runEventsByRun: [{ runId: native.runId, events: cancelled.runEvents }] });
      await input.capture("final-state", "Cursor denied command cancelled; task remains unfinished", "final-state.png");
      return { issue, runs, checks };
    }
    if (design.id === "native-plan-reject-revise-accept") {
      await pollUntil({ label: "accepted Cursor plan waiting for explicit continuation", deadlineAt: input.deadlineAt, load, reject, accept: hasCursorAcceptedPlanWait });
      const observedAt = Date.now();
      const final = await pollUntil({ label: "passive Cursor plan stability", deadlineAt: input.deadlineAt, load,
        reject: state => hasCursorAcceptedPlanWait(state) ? undefined : "Accepted plan started follow-up work or lost its passive disposition",
        accept: state => hasCursorAcceptedPlanWait(state) && Date.now() - observedAt >= 2_000, intervalMs: 250 });
      if (remote) remoteFinal = await remoteFixture!.finish();
      await sampleWorkspace("accepted-plan-terminal");
      check("accepted-plan-passive-terminal", hasCursorAcceptedPlanWait(final), "Successful planning remains in progress with exact controller wait reason and selected Plan mode");
      const comments = await api.get<Row[]>(`/api/issues/${issue.id}/comments`);
      const summary = "Plan accepted. This task is waiting for your next message. This run used Plan mode; no implementation or task completion is claimed.";
      check("explicit-plan-next-action", comments.some(comment => comment.createdByRunId === runs[0]!.id && comment.body === summary), "The original planning run durably presents explicit user continuation");
      await page.reload(); await expect(page.getByText(summary, { exact: true }).last()).toBeVisible();
      await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: In Progress)", exact: true })).toBeVisible();
      await input.evidence("api-state.json", { ...final, run: runs[0], comments, checks, passiveObservedFrom: observedAt, passiveObservedUntil: Date.now(), runEventsByRun: [{ runId: runs[0]!.id, events: final.runEvents }] });
      await input.capture("final-state", "Accepted Cursor plan waiting for the next user message", "final-state.png");
      return { issue, runs, checks };
    }
    const final = await pollUntil({ label: "Cursor native completion", deadlineAt: input.deadlineAt, load, reject,
      accept: state => state.issue.status === "done" && state.runs.length === 1 && state.runs[0]!.status === "succeeded" && !state.interactions.some(card => card.status === "pending") });
    if (remote) remoteFinal = await remoteFixture!.finish();
    check("one-native-run", final.runs[0]!.runtimeMode === "native", "Decision and completion remained in the original native provider run");
    if (design.id === "native-plan-cancel" || design.id === "native-question-reconnect") await sampleWorkspace("native-terminal");
    await page.reload(); await expect(page.getByText(expectedMarker, { exact: true }).last()).toBeVisible();
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
    const comments = await api.get<Row[]>(`/api/issues/${issue.id}/comments`);
    await input.evidence("api-state.json", { ...final, run: runs[0], comments, checks, runEventsByRun: [{ runId: runs[0]!.id, events: final.runEvents }] });
    await input.capture("final-state", "Cursor native callback fixture verified", "final-state.png");
    return { issue, runs, checks };
  } finally { await input.evidence("cursor-native-checks.json", { issue, runs, checks }); }
}
