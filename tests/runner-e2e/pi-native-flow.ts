import type { RestartRunnerIdentity } from "./process-tree-owner.js";
import { observeRunProcesses, createDeniedTargetFixture, bindDeniedTargetPrompt } from "./copilot-local-fixtures.js";
import { hasDeliveredPiDenial, piPermissionRequests, hasPiRemoteRetirement, hasUnchangedPiRemoteTarget } from "./pi-native-evidence.js";
import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { createTaskThroughUi } from "./user-actions.js";
import { gradePiNativeAnswers, gradePiNativeMemory, hasPiNativeMemoryRead, hasFailedPiWrite, hasPiCrossRootDenial, PI_NATIVE_MEMORY_PATH, PI_NATIVE_MEMORY_PARENT_SEED_PATH, PI_NATIVE_MEMORY_PARENT_SEED_CONTENT, piNativeFinish, piNativeMemoryPrompt } from "./pi-native-cases.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

import { remoteNativeIncompleteTerminalEvidence, type RemoteNativeFixture, type RemoteNativeSnapshot } from "./remote-native-fixtures.js";
import { approvePiBootstrapRead, withoutApprovedPiBootstrapRequests, type PiBootstrapApproval } from "./pi-bootstrap-permission.js";
import { runPiPendingProviderDeath, PI_DEATH_MARKER } from "./pi-native-provider-death-flow.js";
import { runPiPendingControllerRestart } from "./pi-native-restart-flow.js";

export interface PiRemoteBootstrap {
  prompt(nonce: string): string;
  bindAndRelease(input: { issueId: string; runId: string; targets: string[]; crossRoot?: { initialText: string }; actionPrompt(fixture: RemoteNativeFixture): string | Promise<string> }): Promise<RemoteNativeFixture>;
}

type Row = Record<string, any>;
type Check = { id: string; passed: boolean; detail: string };

export async function runPiNativeFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; deadlineAt: number; restart(preserveRunner?: RestartRunnerIdentity): Promise<void>;
  observe(issue: Row, runs: Row[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, data: unknown): Promise<void>;
  remoteBootstrap?: PiRemoteBootstrap;
  registerCleanupAssertion?(assertion: () => Promise<Check[]>): void;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const remote = execution.environment.id === "daytona";
  if (!["local", "daytona"].includes(execution.environment.id) || execution.profile.qualificationCandidate !== "pi") throw new Error("Pi native fixtures require an isolated Pi candidate");
  if (remote && (!input.remoteBootstrap || !input.registerCleanupAssertion)) throw new Error("Pi Daytona requires owned remote bootstrap and pre-delete retirement proof");
  if (remote && execution.task.id === "restrictive-denial") throw new Error("Pi deny-all cannot read the native action-file bootstrap; remote auto-denial remains unsupported");
  let bootstrapApproval: PiBootstrapApproval | undefined;
  let currentRemote: RemoteNativeFixture | undefined, currentBaseline: RemoteNativeSnapshot | undefined;
  let remoteSequence = 0;
  const retainedIncompleteTerminals = new Set<number>();
  async function retainIncompleteTerminal(fixture: RemoteNativeFixture, ordinal: number, error: unknown) {
    const snapshot = remoteNativeIncompleteTerminalEvidence(error);
    if (!snapshot || retainedIncompleteTerminals.has(ordinal)) return;
    try {
      await input.evidence(`pi-remote-${ordinal}-incomplete-terminal.json`, { binding: fixture.binding, snapshot, passed: false });
      retainedIncompleteTerminals.add(ordinal);
    } catch {
      // The caller must rethrow the original qualification error. Leave this
      // ordinal unretained so cleanup can still try to save its diagnostic.
    }
  }
  async function finishRemote(label: string) {
    if (!currentRemote) throw new Error("Missing exact owned remote fixture");
    let snapshot: RemoteNativeSnapshot;
    try { snapshot = await currentRemote.finish(); }
    catch (error) { await retainIncompleteTerminal(currentRemote, remoteSequence, error); throw error; }
    await input.evidence(`pi-remote-${remoteSequence}-${label}.json`, { binding: currentRemote.binding, baseline: currentBaseline, snapshot });
    if (!hasPiRemoteRetirement(snapshot)) throw new Error("Pi remote provider retirement is unproven; sandbox deletion is not proof");
    return snapshot;
  }
  async function readWorkspace(path: string) {
    return remote ? (await currentRemote!.readFile(path)).toString("utf8") : await readFile(join(input.workspacePath, path), "utf8");
  }
  const checks: Check[] = []; let issue: Row = {}; let runs: Row[] = [];
  const project = await api.post<Row>(`/api/companies/${fixtures.company.id}/projects`, {
    name: `Pi native workspace ${nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize", allowIssueOverride: false, environmentId: fixtures.environment.id, workspaceStrategy: { type: "project_primary" } },
    workspace: { name: "Primary", sourceType: "local_path", cwd: input.workspacePath, isPrimary: true },
  });
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); expect(passed, detail).toBe(true); };
  const events = (runId: string) => collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const absent = async (path: string) => { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
  const load = async () => {
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); input.observe(issue, runs);
    const interactions = await api.get<Row[]>(`/api/issues/${issue.id}/interactions`);
    return { issue, runs, interactions };
  };
  const rejectFailure = (state: Awaited<ReturnType<typeof load>>) => state.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Pi provider run failed" : undefined;
  async function create(title: string, prompt: string | ((fixture: RemoteNativeFixture) => string), options: { targets?: string[]; crossRoot?: { initialText: string } } = {}) {
    const previous = new Set(runs.map(run => run.id));
    const actualPrompt = remote ? input.remoteBootstrap!.prompt(`${nonce}-${++remoteSequence}`) : typeof prompt === "string" ? prompt : (() => { throw new Error("Local prompt cannot depend on remote fixture"); })();
    const createdTask = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name, title, prompt: actualPrompt, workMode: "standard", projectName: project.name, requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${createdTask.issueId}`);
    check("created-task-identity", issue.id === createdTask.issueId && issue.companyId === fixtures.company.id && issue.assigneeAgentId === fixtures.agent.id, "Creation response binds the exact company-scoped assigned task before native action");
    input.observe(issue, runs);
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    if (remote) {
      const state = await pollUntil({ label: "Pi remote bootstrap native run", deadlineAt: input.deadlineAt, load, reject: rejectFailure, accept: value => value.runs.filter(run => !previous.has(run.id)).length === 1 });
      const run = state.runs.find(value => !previous.has(value.id))!;
      currentRemote = await input.remoteBootstrap!.bindAndRelease({ issueId: issue.id, runId: run.id, targets: options.targets ?? [], crossRoot: options.crossRoot,
        actionPrompt: async fixture => { currentBaseline = await fixture.snapshot("before-action"); await input.evidence(`pi-remote-${remoteSequence}-armed.json`, { binding: fixture.binding, baseline: currentBaseline }); return typeof prompt === "string" ? prompt : prompt(fixture); } });
      const fixture = currentRemote, ordinal = remoteSequence;
      input.registerCleanupAssertion!(async () => {
        try { const snapshot = await fixture.finish(); const passed = hasPiRemoteRetirement(snapshot); await input.evidence(`pi-remote-${ordinal}-retirement.json`, { binding: fixture.binding, snapshot, passed }); if (!passed) throw new Error("Pi remote retirement proof incomplete"); return [{ id: `remote-retirement-${ordinal}`, passed, detail: "Independent remote observer sealed exact run retirement before public lease deletion" }]; }
        catch (error) { await retainIncompleteTerminal(fixture, ordinal, error); throw error; }
        finally { await fixture.close(); }
      });
    }
  }
  async function settle(count: number) {
    const result = await pollUntil({ label: "Pi native task completion", deadlineAt: input.deadlineAt, load,
      accept: state => state.issue.status === "done" && state.runs.length === count && state.runs.every(run => run.status === "succeeded") && !state.interactions.some(row => row.status === "pending"),
      reject: state => rejectFailure(state) ?? (state.runs.length > count ? "Extra Pi provider run" : undefined) });
    check(`native-runs-${count}`, result.runs.every(run => run.runtimeMode === "native"), "Every accounted run used the native runtime");
    await page.reload(); await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
    return result;
  }
  try {
    if (execution.task.id === "native-pending-provider-death") {
      if (!remote) throw new Error("Exact Pi-child fault is available only on owned Daytona Linux");
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce), { targets: [PI_DEATH_MARKER] });
      checks.push(...await runPiPendingProviderDeath({ page, api, companyId: fixtures.company.id, deadlineAt: input.deadlineAt,
        fixture: currentRemote!, load, events, capture: input.capture, evidence: input.evidence }));
      const originalRunId = runs[0]!.id;
      input.registerCleanupAssertion!(async () => {
        const state = await load();
        const passed = state.issue.status === "blocked" && state.runs.length === 1 && state.runs[0]?.id === originalRunId && state.runs[0]?.status === "failed"
          && state.interactions.every(card => card.status === "expired" || (card.status === "pending" && card.continuationPolicy === "wake_assignee"));
        await input.evidence("pi-provider-death-final-no-replay.json", { ...state, passed });
        if (!passed) throw new Error("Provider loss replayed a run or consumed the unanswered fallback during cleanup");
        return [{ id: "death-no-replay-through-cleanup", passed, detail: "Original failed run remains the only run through cleanup" }];
      });
    } else if (execution.task.id === "native-pending-controller-restart") {
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce), { targets: ["pi-native-restart-answer.json"] });
      checks.push(...await runPiPendingControllerRestart({
        page, companyId: fixtures.company.id, deadlineAt: input.deadlineAt, load, events,
        preserveLocalRunner: !remote, restart: input.restart, settle: () => settle(1), capture: input.capture, evidence: input.evidence,
        readProof: async () => {
          if (remote) await finishRemote("native-restart-final");
          return JSON.parse(await readWorkspace("pi-native-restart-answer.json"));
        },
      }));
    } else if (execution.task.id === "native-questions") {
      const name = `name-${randomBytes(8).toString("hex")}`; const draft = `draft-${randomBytes(8).toString("hex")}\nSecond line`;
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce), { targets: ["pi-native-answers.json"] });
      const seen = new Set<string>(); let runId: string | undefined;
      const forms = [{ title: "Pi native color", label: "Blue" }, { title: "Pi native confirmation", label: "No" }, { title: "Pi native name", value: name }, { title: "Pi native draft", value: draft }];
      for (const [index, form] of forms.entries()) {
        const state = await pollUntil({ label: form.title, deadlineAt: input.deadlineAt, load, reject: rejectFailure,
          accept: state => state.interactions.some(row => row.kind === "ask_user_questions" && row.status === "pending" && row.payload?.runtimeRequestId && row.payload?.questionSet?.questions?.[0]?.header === form.title) });
        const pending = state.interactions.filter(row => row.status === "pending");
        check(`single-pending-${index}`, pending.length === 1 && state.runs.length === 1, "One durable native question belongs to one live provider run");
        const card = pending[0]!; runId ??= card.sourceRunId;
        check(`native-binding-${index}`, card.sourceRunId === runId && card.continuationPolicy === "none" && !seen.has(card.id), "Question retains its source run and distinct durable identity"); seen.add(card.id);
        await input.evidence(`pi-native-question-${index}-pending.json`, { issue, runs, interaction: card });
        await page.reload(); // Reconnect the browser while preserving the live native promise.
        const afterReload = (await load()).interactions.find(row => row.id === card.id);
        check(`reconnect-${index}`, afterReload?.status === "pending" && afterReload.payload.runtimeRequestId === card.payload.runtimeRequestId, "Reload preserved the same pending runtime request");
        await input.capture(`pi-question-${index}`, form.title, `pi-question-${index}.png`);
        if (form.label) await page.getByRole("radio", { name: form.label, exact: true }).last().click();
        else await page.getByTestId("question-text-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(form.value!);
        await page.getByRole("button", { name: card.payload?.questionSet?.submitLabel ?? "Submit answers", exact: true }).last().click();
        const resolved = await pollUntil({ label: "durable native answer", deadlineAt: input.deadlineAt, load, reject: rejectFailure, accept: state => state.interactions.some(row => row.id === card.id && row.status === "answered") });
        await input.evidence(`pi-native-question-${index}-answered.json`, resolved.interactions.find(row => row.id === card.id));
      }
      const final = await settle(1);
      if (remote) await finishRemote("questions-final");
      const proof = JSON.parse(await readWorkspace("pi-native-answers.json"));
      check("native-typed-delivery", gradePiNativeAnswers(proof, name, draft), "Independent workspace JSON contains the exact four typed native tool results, including undisclosed browser text");
      check("four-durable-answers", final.interactions.length === 4 && final.interactions.every(row => row.status === "answered" && row.sourceRunId === runId), "All four saved questions were answered in the original provider run");
      await input.evidence("pi-native-typed-proof.json", { proof, interactions: final.interactions, events: await events(runs[0]!.id) });
    } else if (execution.task.id === "agent-files-fresh-run") {
      const retained = randomBytes(16).toString("hex"); const outside = resolve(input.workspacePath, "..", `pi-unassigned-${nonce}.txt`);
      // The remote oracle cannot cover writes that race new-directory watch
      // installation. Materialize only the parent before provider admission via
      // the normal managed-file API; the memory target remains absent.
      const seed = await api.request.put(`/api/agents/${fixtures.agent.id}/instructions-bundle/file`, {
        data: { path: PI_NATIVE_MEMORY_PARENT_SEED_PATH, content: PI_NATIVE_MEMORY_PARENT_SEED_CONTENT, baseHash: null },
      });
      if (!seed.ok()) throw new Error(`Pi memory parent setup failed (${seed.status()})`);
      check("memory-parent-seeded", (await seed.json()).content === PI_NATIVE_MEMORY_PARENT_SEED_CONTENT, "Public managed-file setup created the watched memory parent before task admission");
      if (!remote) check("unassigned-initially-absent", await absent(outside), "The isolated cross-root marker did not already exist");
      const prompt = (outsidePath: string) => piNativeMemoryPrompt(retained, outsidePath);
      await create(execution.task.buildTitle(nonce), remote ? fixture => { if (!fixture.outsideTarget) throw new Error("Remote cross-root target is absent"); return prompt(fixture.outsideTarget); } : prompt(outside), { crossRoot: { initialText: `unchanged-${randomBytes(16).toString("hex")}` } });
      await settle(1);
      const personal = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(PI_NATIVE_MEMORY_PATH)}`);
      const firstEvents = await events(runs[0]!.id);
      await input.evidence("pi-agent-files-first-save.json", { personal, run: runs[0], events: firstEvents });
      check("native-memory-write-verification", hasPiNativeMemoryRead(firstEvents, retained, remote ? { agentId: fixtures.agent.id, runId: runs[0]!.id } : undefined), "One completed native read verified the write, with no shell execution");
      check("registered-file-saved", gradePiNativeMemory(personal.content, retained), "Public managed-file API contains the exact native-write bytes");
      check("stopped-save-receipt", firstEvents.some(row => row.eventType === "instruction_save" && row.payload?.state === "saved"), "Provider stop produced a durable file-save receipt");
      const crossRootIntact = remote ? hasUnchangedPiRemoteTarget(currentBaseline, await finishRemote("cross-root-final"), "@cross-root") : await absent(outside);
      check("cross-root-denied", crossRootIntact && hasPiCrossRootDenial(firstEvents), "A single native write recorded the exact cross-root denial reason and the isolated target remains unchanged");
      await input.restart();
      await create(`Pi read persisted memory ${nonce}`, [
        `Use native read once with path <AGENT_HOME>/${PI_NATIVE_MEMORY_PATH}. Replace <AGENT_HOME> with the canonical absolute directory from this turn\'s runtime instructions. Read the complete file without offset or limit; do not infer its contents from another task, conversation, or history.`,
        "Use native write to copy those exact bytes into pi-agent-memory-proof.txt in the task workspace. This is an internal assertion file, not a deliverable. Do not change personal memory or other agent files. Do not use bash or the instructions API.",
        piNativeFinish(execution.task.buildVisibleMarker(nonce)),
      ].join("\n"), { targets: ["pi-agent-memory-proof.txt"] });
      await settle(2);
      if (remote) await finishRemote("memory-readback-final");
      check("fresh-run-readback", gradePiNativeMemory(await readWorkspace("pi-agent-memory-proof.txt"), retained), "A new issue after server restart copied the undisclosed saved agent-file bytes");
      const current = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(PI_NATIVE_MEMORY_PATH)}`);
      check("persistent-bytes-unchanged", current.content === personal.content, "Fresh-run readback preserved the saved managed bytes");
      const parentSeed = await api.get<Row>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(PI_NATIVE_MEMORY_PARENT_SEED_PATH)}`);
      check("memory-parent-seed-unchanged", parentSeed.content === PI_NATIVE_MEMORY_PARENT_SEED_CONTENT, "Both native turns preserved the parent setup file");
      const freshEvents = await events(runs[1]!.id);
      await input.evidence("pi-agent-files-fresh-read.json", { current, runs, events: freshEvents });
      check("native-memory-fresh-read", hasPiNativeMemoryRead(freshEvents, retained, remote ? { agentId: fixtures.agent.id, runId: runs[1]!.id } : undefined), "The fresh run used one completed native read, with no shell execution");
    } else if (execution.task.id === "human-permission-denial") {
      if (!input.registerCleanupAssertion) throw new Error("Pi human denial requires post-retirement cleanup assertions");
      const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
      const configured = await api.patch<Row>(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "approve-reads", lifecycleMode: "per_turn", timeoutSec: 120 } });
      check("human-denial-policy", configured.adapterConfig.acpxPermissionMode === "approve-reads" && configured.adapterConfig.lifecycleMode === "per_turn", "Native write requires a browser permission decision in an owned per-turn process");
      const localTarget = remote ? null : await createDeniedTargetFixture(input.workspacePath, "pi-human-denied.txt");
      const target = localTarget?.targetRelativePath ?? "pi-human-denied.txt", path = join(input.workspacePath, target);
      const watcher = localTarget?.watcher ?? null, observer = remote ? null : observeRunProcesses();
      let processError = false, processAuthority: string | undefined;
      const observe = () => {
        const run = runs[0]; const authority = run?.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined;
        if (authority) { const key = JSON.stringify(authority); if (processAuthority && processAuthority !== key) processError = true; processAuthority ??= key; }
        return observer ? observer.sample(authority) : { captured: false, live: [] as number[], journal: [] };
      };
      let processes = observe();
      const timer = remote ? undefined : setInterval(() => { try { processes = observe(); } catch { processError = true; } }, 250);
      if (!remote) input.registerCleanupAssertion(async () => {
        try {
          await load(); processes = observe();
          if (processes.captured && processes.live.length) processes = await pollUntil({ label: "Pi denied-write provider retirement", deadlineAt: Date.now() + 5000, load: async () => observe(), accept: value => value.live.length === 0 });
          const fileAbsent = await absent(path), journal = watcher!.finish();
          const passed = runs.length === 1 && runs[0]!.status === "succeeded" && processes.captured && processes.live.length === 0 && !processError && fileAbsent && journal.complete && journal.targetMutationCount === 0;
          await input.evidence("pi-human-denial-retirement.json", { processes, processError, fileAbsent, journal, passed });
          if (!passed) throw new Error("Pi human denial lacks independent no-effect and provider-retirement proof");
          return [{ id: "human-denial-through-retirement", passed, detail: "Browser-denied target stayed absent through exact owned provider-process retirement" }];
        } finally { clearInterval(timer); await input.evidence("pi-human-denial-cleanup-attempt.json", { target, processes, processError, journal: watcher!.finish() }); }
      });
      if (!remote) check("human-target-initially-absent", await absent(path), "Independent target is absent before provider work");
      await create(execution.task.buildTitle(nonce), localTarget ? bindDeniedTargetPrompt(execution.task.buildPrompt(nonce), "pi-human-denied.txt", target) : execution.task.buildPrompt(nonce), { targets: [target] });
      if (remote) bootstrapApproval = await approvePiBootstrapRead({ api, fixture: currentRemote!, companyId: fixtures.company.id, issueId: issue.id, runId: runs[0]!.id,
        deadlineAt: input.deadlineAt, load: async () => { await load(); return { run: runs[0]!, issue, events: await events(runs[0]!.id) }; }, evidence: input.evidence });
      if (remote) check("human-target-initially-absent", currentBaseline?.targets[target]?.absent === true && currentBaseline.targets[target]!.complete, "Remote watcher was armed before action publication with an absent target");
      const pending = await pollUntil({ label: "Pi native browser permission", deadlineAt: input.deadlineAt, load: async () => { const state = await load(); processes = observe(); return { ...state, events: state.runs.length === 1 ? await events(state.runs[0]!.id) : [] }; }, reject: rejectFailure,
        accept: state => state.runs.length === 1 && piPermissionRequests(withoutApprovedPiBootstrapRequests(state.events, bootstrapApproval), state.runs[0]!.id).length === 1 });
      const native = piPermissionRequests(withoutApprovedPiBootstrapRequests(pending.events, bootstrapApproval), pending.runs[0]!.id)[0]!;
      const identity = { runId: pending.runs[0]!.id, turnId: native.event.turnId, requestId: native.request.requestId, toolCallId: native.request.details.toolCallId, target };
      check("human-target-pending-absent", remote ? (await currentRemote!.snapshot("permission-pending")).targets[target]?.absent === true : await absent(path), "Pending native write has no file effect");
      await page.reload();
      const before = await events(identity.runId);
      check("human-permission-reconnect", piPermissionRequests(before, identity.runId).some(value => value.request.requestId === identity.requestId) && !before.some(row => row.payload?.prpEvent?.payload?.requestId === identity.requestId && ["runtime_request.resolved", "runtime_request.expired", "runtime_request.cancelled"].includes(row.eventType)), "Reload retained the exact unanswered native permission");
      const declineLabel = native.request.choices.find((choice: Row) => choice.key === "decline").label;
      // Resolved setup-read receipts remain visible but have no decision
      // buttons. Require one actionable card and verify its exact POST below.
      const card = page.getByTestId("task-chat-runtime-request").filter({ visible: true })
        .filter({ has: page.getByRole("button", { name: declineLabel, exact: true }) });
      await expect(card).toHaveCount(1);
      await input.capture("pi-human-denial", "Pi native permission awaiting browser denial", "pi-human-denial.png");
      const route = `/api/heartbeat-runs/${identity.runId}/runtime-requests/${encodeURIComponent(identity.requestId)}/resolve`;
      const posted = page.waitForRequest(request => new URL(request.url()).pathname === route && request.method() === "POST");
      await card.getByRole("button", { name: declineLabel, exact: true }).click();
      const response = (await posted).postDataJSON();
      check("human-exact-browser-decline", response.turnId === identity.turnId && response.requestKind === "permission_approval" && response.resolution?.action === "decline", "Actual browser POST declines this run, turn and request");
      const final = await settle(1), runEvents = await events(identity.runId);
      check("human-native-denial-delivered", hasDeliveredPiDenial(runEvents, identity), "Public durable delivery and same native write failure prove actual rejection");
      check("human-target-terminal-absent", remote ? hasUnchangedPiRemoteTarget(currentBaseline, await finishRemote("human-denial-final"), target) : await absent(path), "The target remains absent after negative-test completion");
      await input.evidence("pi-human-denial.json", { identity, final, events: runEvents });
    } else if (execution.task.id === "restrictive-denial") {
      const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
      await api.patch(`/api/agents/${fixtures.agent.id}`, { adapterConfig: { ...agent.adapterConfig, acpxPermissionMode: "deny-all" } });
      const deniedPath = join(input.workspacePath, "pi-denied.txt");
      check("denied-file-initially-absent", await absent(deniedPath), "The isolated denied file did not already exist");
      await create(execution.task.buildTitle(nonce), execution.task.buildPrompt(nonce));
      await settle(1); const runEvents = await events(runs[0]!.id);
      check("restrictive-native-denial", await absent(deniedPath) && hasFailedPiWrite(runEvents, "pi-denied.txt"), "A correlated failed native edit and independent absent file prove restrictive denial");
      await input.evidence("pi-restrictive-denial.json", { permissionMode: "deny-all", fileAbsent: true, run: runs[0], events: runEvents });
    } else throw new Error(`Unknown Pi native flow ${execution.task.id}`);
    // The specialized flow bypasses the standard task collector. Retain its
    // required terminal API snapshot before declaring the fixture complete.
    const final = await load();
    const comments = await api.get<Row[]>(`/api/issues/${issue.id}/comments`);
    const runEventsByRun = await Promise.all(runs.map(async run => ({ runId: run.id, events: await events(run.id) })));
    await input.evidence("api-state.json", {
      ...final, run: runs.at(-1), comments, checks, runEventsByRun,
    });
    await input.capture("final-state", "Pi native fixture verified", "final-state.png");
    return { issue, runs, checks };
  } finally { await input.evidence("pi-native-checks.json", { issue, runs, checks }); }
}
