import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { unreadSteeredMessageIds } from "../steering-delivery.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it.each(["none", "before-start", "after-start"] as const)("completes after the real runner and provider are killed (second crash: %s)", async (crash) => {
  const root = await mkdtemp(join(tmpdir(), "runner-restart-continuation-"));
  const identity = { runId: "run-restart", sessionId: "session-restart", companyId: "company-restart", issueId: "issue-restart", agentId: "agent-restart" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-restart" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-1", title: "Finish checks", description: null, prompt: "Watch the already running checks and finish the request.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-restart", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Finish checks", criteria: [{ id: "checks", requirement: "Check the outcome" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--call-log", join(root, "calls.log"), "--durable-turn-ids", "--hold-first-durable-turn"],
    stateDirectory: root,
    prpIdentity: { runnerInstanceId: "runner-restart", environmentLeaseId: "lease-restart", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn-restart", itemId: "item-restart" },
  };
  const first = createRunnerdCodexTransport(options);
  let restored: ReturnType<typeof createRunnerdCodexTransport> | undefined;
  const alive = (pid: number | null) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const kill = (pid: number | null) => {
    if (!pid) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  try {
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-restart", transportFactory: () => first.transport });
    const session = await backend.openSession({ identity, workingDirectory: root });
    await session.startTurn({ message: { role: "user", text: execution.task.prompt } });
    const persisted = await session.snapshot();
    expect(persisted.activeTurnId).toBe("provider-turn-1");
    const durableEvents: PrpEvent[] = [];
    const initialEvents = session.events()[Symbol.asyncIterator]();
    while ((durableEvents.at(-1)?.sourceSeq ?? 0) < Number(persisted.cursor)) {
      const event = await initialEvents.next();
      if (event.done) throw new Error("initial event history ended early");
      durableEvents.push(event.value);
    }
    const owner = first.evidence();
    await first.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });
    // Simulate Codex's process-loss history: the thread remains, its in-memory
    // turn does not. Keep the turn counter to prevent provider identity reuse.
    const providerState = JSON.parse(await readFile(join(root, "fake-state.json"), "utf8"));
    providerState.activeTurnId = null;
    await writeFile(join(root, "fake-state.json"), JSON.stringify(providerState));
    restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: persisted.activeTurnId });
    let recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-restart", transportFactory: () => restored!.transport });
    const events: PrpEvent[] = [];
    const checkpoints: PersistedNativeSession[] = [];
    let recoveryCheckpoint = persisted;
    let failCheckpoint = crash !== "none";
    const interruptedController = new Error("controller lost before continuation submission");
    const execute = () => executeNativeSession({
      input: execution, backend: recovering, persistedSession: recoveryCheckpoint, resumeInterruptedTurn: true,
      runnerInstanceId: "runner-restart", controlPlaneInstanceId: "controller-restart", timeoutMs: 15_000,
      controlPlane: {
        async openRun() {},
        async checkpointSession(snapshot) {
          if (failCheckpoint && crash === "after-start" && snapshot.dispositionOnlyRecoveryTurnId === "provider-turn-2") {
            failCheckpoint = false;
            throw interruptedController;
          }
          checkpoints.push(structuredClone(snapshot));
          recoveryCheckpoint = structuredClone(snapshot);
          if (failCheckpoint && crash === "before-start" && snapshot.terminal?.runTerminalState === "failed") {
            failCheckpoint = false;
            throw interruptedController;
          }
        },
        async appendEvent(event) { if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event"); events.push(event); durableEvents.push(event); return { cursor: durableEvents.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents(request) {
          const source = durableEvents.filter(event => event.sourceInstanceId === request.sourceInstanceId);
          return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq), highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
        },
        async completeRun() {},
      },
    });
    if (crash !== "none") {
      await expect(execute()).rejects.toBe(interruptedController);
      await restored.transport.close().catch(() => undefined);
      restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: recoveryCheckpoint.activeTurnId });
      recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-restart", transportFactory: () => restored!.transport });
    }
    const completion = await execute();
    expect(completion).toMatchObject({ providerSessionId: persisted.providerSessionId, turnId: "provider-turn-2", terminal: { runTerminalState: "succeeded" } });
    expect(events.filter(event => event.eventType === "turn.failed")).toHaveLength(1);
    expect(events.filter(event => event.eventType === "run.terminal")).toHaveLength(1);
    if (crash !== "after-start") expect(checkpoints.some(snapshot => snapshot.activeTurnId === "provider-turn-2" && snapshot.terminal === null)).toBe(true);
    expect((await readFile(join(root, "calls.log"), "utf8")).match(/^turn\/start$/gm)).toHaveLength(2);
    const journal = JSON.parse(await readFile(join(root, "control-plane/control-plane-state.json"), "utf8"));
    const submissions = journal.commands.filter((command: { type: string }) => command.type === "turn.start");
    expect(submissions).toHaveLength(2);
    expect(submissions[1].payload.text).toContain("Reconcile any unfinished tool or command");
  } finally {
    await restored?.transport.close().catch(() => undefined);
    for (const bundle of [first, restored]) {
      if (!bundle) continue;
      const evidence = bundle.evidence();
      kill(evidence.runnerPid);
      kill(evidence.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("starts a new turn when the restored runner reports a lost turn the checkpoint never bound", async () => {
  // The controller died right after the provider accepted its turn, before the
  // accepted turn reached the checkpoint. The restored runner then reports that
  // unbound turn as lost while the recovery's new turn start is pending.
  const root = await mkdtemp(join(tmpdir(), "runner-restart-unbound-"));
  const identity = { runId: "run-unbound", sessionId: "session-unbound", companyId: "company-unbound", issueId: "issue-unbound", agentId: "agent-unbound" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-unbound" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-2", title: "Finish checks", description: null, prompt: "Watch the already running checks and finish the request.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-unbound", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Finish checks", criteria: [{ id: "checks", requirement: "Check the outcome" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--call-log", join(root, "calls.log"), "--durable-turn-ids", "--hold-first-durable-turn"],
    stateDirectory: root,
    turnStartTimeoutMs: 8_000,
    prpIdentity: { runnerInstanceId: "runner-unbound", environmentLeaseId: "lease-unbound", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn-unbound", itemId: "item-unbound" },
  };
  const first = createRunnerdCodexTransport(options);
  let restored: ReturnType<typeof createRunnerdCodexTransport> | undefined;
  const alive = (pid: number | null) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const kill = (pid: number | null) => {
    if (!pid) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  try {
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-unbound", transportFactory: () => first.transport });
    const session = await backend.openSession({ identity, workingDirectory: root });
    // The last checkpoint the controller persisted: no active turn yet.
    const checkpoint = await session.snapshot();
    expect(checkpoint.activeTurnId ?? null).toBeNull();
    await session.startTurn({ message: { role: "user", text: execution.task.prompt } });
    const owner = first.evidence();
    await first.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });
    const providerState = JSON.parse(await readFile(join(root, "fake-state.json"), "utf8"));
    providerState.activeTurnId = null;
    await writeFile(join(root, "fake-state.json"), JSON.stringify(providerState));
    restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: null });
    const recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-unbound", transportFactory: () => restored!.transport });
    const events: PrpEvent[] = [];
    const completion = await executeNativeSession({
      input: execution, backend: recovering, persistedSession: checkpoint, resumeInterruptedTurn: true,
      runnerInstanceId: "runner-unbound", controlPlaneInstanceId: "controller-unbound", timeoutMs: 15_000,
      controlPlane: {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent(event) { if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event"); events.push(event); return { cursor: events.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents(request) {
          const source = events.filter(event => event.sourceInstanceId === request.sourceInstanceId);
          return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq), highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
        },
        async completeRun() {},
      },
    });
    expect(completion).toMatchObject({ providerSessionId: checkpoint.providerSessionId, turnId: "provider-turn-2", terminal: { runTerminalState: "succeeded" } });
    expect(events.find(event => event.eventType === "session.failed")).toBeUndefined();
    // The unbound lost turn is not this execution's turn: it is not reported as its failure.
    expect(events.filter(event => event.eventType === "turn.failed")).toHaveLength(0);
    expect((await readFile(join(root, "calls.log"), "utf8")).match(/^turn\/start$/gm)).toHaveLength(2);
  } finally {
    await restored?.transport.close().catch(() => undefined);
    for (const bundle of [first, restored]) {
      if (!bundle) continue;
      const evidence = bundle.evidence();
      kill(evidence.runnerPid);
      kill(evidence.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

it("finalizes the durable proposed result when the runner and provider die before the turn terminal", async () => {
  // The provider proposed a complete result and Paperclip durably recorded it.
  // Both processes were then killed before the provider turn ended. The
  // restored runner recovers that turn's authoritative result: recovery must
  // finalize it instead of failing reconciliation or re-running the task.
  const root = await mkdtemp(join(tmpdir(), "runner-restart-proposed-"));
  const identity = { runId: "run-proposed", sessionId: "session-proposed", companyId: "company-proposed", issueId: "issue-proposed", agentId: "agent-proposed" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-proposed" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-3", title: "Finish checks", description: null, prompt: "Run the checks and report the result.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-proposed", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Finish checks", criteria: [{ id: "checks", requirement: "Check the outcome" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const report = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The checks pass.",
    completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "checks", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
    evidence: [], verification: [], attentionRequests: [], artifacts: [] };
  await writeFile(join(root, "report.json"), JSON.stringify(report));
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--call-log", join(root, "calls.log"), "--durable-turn-ids",
      "--terminal-result-file", join(root, "report.json"), "--hold-after-terminal-result"],
    stateDirectory: root,
    prpIdentity: { runnerInstanceId: "runner-proposed", environmentLeaseId: "lease-proposed", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn-proposed", itemId: "item-proposed" },
  };
  const first = createRunnerdCodexTransport(options);
  let restored: ReturnType<typeof createRunnerdCodexTransport> | undefined;
  const alive = (pid: number | null) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const kill = (pid: number | null) => {
    if (!pid) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  try {
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-proposed", transportFactory: () => first.transport });
    const session = await backend.openSession({ identity, workingDirectory: root });
    await session.startTurn({ message: { role: "user", text: execution.task.prompt } });
    // The controller's last checkpoint names the active turn but not the result.
    const checkpoint = await session.snapshot();
    expect(checkpoint.activeTurnId).toBe("provider-turn-1");
    expect(checkpoint.semanticResult ?? null).toBeNull();
    // The control plane durably appended the proposal before the kill.
    const durableEvents: PrpEvent[] = [];
    const initialEvents = session.events()[Symbol.asyncIterator]();
    while (!durableEvents.some(event => event.eventType === "run.result.proposed")) {
      const event = await initialEvents.next();
      if (event.done) throw new Error("initial event history ended before the proposal");
      durableEvents.push(event.value);
    }
    await vi.waitFor(async () => expect(await readFile(join(root, "calls.log"), "utf8")).toContain("terminal-result:accepted"));
    const owner = first.evidence();
    await first.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });
    const providerState = JSON.parse(await readFile(join(root, "fake-state.json"), "utf8"));
    providerState.activeTurnId = null;
    await writeFile(join(root, "fake-state.json"), JSON.stringify(providerState));
    restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: checkpoint.activeTurnId });
    const recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-proposed", transportFactory: () => restored!.transport });
    const events: PrpEvent[] = [];
    const completion = await executeNativeSession({
      input: execution, backend: recovering, persistedSession: checkpoint, resumeInterruptedTurn: true,
      runnerInstanceId: "runner-proposed", controlPlaneInstanceId: "controller-proposed", timeoutMs: 15_000,
      controlPlane: {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent(event) { if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event"); events.push(event); durableEvents.push(event); return { cursor: durableEvents.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents(request) {
          const source = durableEvents.filter(event => event.sourceInstanceId === request.sourceInstanceId);
          return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq), highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
        },
        async completeRun() {},
      },
    });
    expect(completion).toMatchObject({ providerSessionId: checkpoint.providerSessionId, turnId: "provider-turn-1",
      result: { reportedWorkDisposition: "done", summary: "The checks pass." }, terminal: { runTerminalState: "succeeded" } });
    expect(events.find(event => event.eventType === "session.failed")).toBeUndefined();
    expect(events.filter(event => event.eventType === "turn.failed")).toHaveLength(0);
    // The finished work is not re-run.
    expect((await readFile(join(root, "calls.log"), "utf8")).match(/^turn\/start$/gm)).toHaveLength(1);
  } finally {
    await restored?.transport.close().catch(() => undefined);
    for (const bundle of [first, restored]) {
      if (!bundle) continue;
      const evidence = bundle.evidence();
      kill(evidence.runnerPid);
      kill(evidence.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

it.each(["unread", "read"] as const)("delivers a steered message the restart lost exactly once (%s before the kill)", async (state) => {
  // A user steers the live turn during a tool call, then the controller,
  // runner and provider die before the model's next step ("unread"), or after
  // the provider recorded the message ("read"). Recovery reads the durable run
  // log: the unread message must reach the continuation once; the read one
  // must not reach it again.
  const root = await mkdtemp(join(tmpdir(), "runner-restart-steer-"));
  const identity = { runId: "run-steer", sessionId: "session-steer", companyId: "company-steer", issueId: "issue-steer", agentId: "agent-steer" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-steer" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-4", title: "Finish checks", description: null, prompt: "Watch the already running checks and finish the request.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-steer", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Finish checks", criteria: [{ id: "checks", requirement: "Check the outcome" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const commentId = "0b6f8c62-5d1a-4c55-9a7e-2f1c3b4d5e6f";
  const steeredText = "HELLO steer-nonce-7f3a";
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--call-log", join(root, "calls.log"), "--durable-turn-ids", "--hold-first-durable-turn",
      ...(state === "read" ? ["--consume-steer"] : [])],
    stateDirectory: root,
    prpIdentity: { runnerInstanceId: "runner-steer", environmentLeaseId: "lease-steer", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn-steer", itemId: "item-steer" },
  };
  const first = createRunnerdCodexTransport(options);
  let restored: ReturnType<typeof createRunnerdCodexTransport> | undefined;
  const alive = (pid: number | null) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const kill = (pid: number | null) => {
    if (!pid) return;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  // The server's run-log reader, over the events the control plane persisted.
  const unread = (events: PrpEvent[]) => unreadSteeredMessageIds(events.map(event => ({
    eventType: event.eventType, turnId: event.turnId, itemId: event.itemId,
    kind: typeof (event.payload as { kind?: unknown }).kind === "string" ? (event.payload as { kind: string }).kind : null,
  })));
  try {
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-steer", transportFactory: () => first.transport });
    const session = await backend.openSession({ identity, workingDirectory: root });
    await session.startTurn({ message: { role: "user", text: execution.task.prompt } });
    const started = await session.snapshot();
    expect(started.activeTurnId).toBe("provider-turn-1");
    expect((await session.capabilities()).steering).toBe(true);
    await session.steer!({ turnId: started.activeTurnId!, message: { role: "user", text: steeredText }, correlationId: commentId });
    const persisted = await session.snapshot();
    const durableEvents: PrpEvent[] = [];
    const initialEvents = session.events()[Symbol.asyncIterator]();
    const kinds = () => durableEvents.map(event => (event.payload as { kind?: unknown }).kind);
    // "read": the turn's input and the steered message are both userMessage items.
    while (!kinds().includes("steering_acknowledgement") || (state === "read" && durableEvents.filter(event => event.eventType === "item.started" && (event.payload as { kind?: unknown }).kind === "userMessage").length < 2)) {
      const event = await initialEvents.next();
      if (event.done) throw new Error("initial event history ended early");
      durableEvents.push(event.value);
    }
    expect(unread(durableEvents)).toEqual(state === "unread" ? [commentId] : []);
    const owner = first.evidence();
    await first.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });
    const providerState = JSON.parse(await readFile(join(root, "fake-state.json"), "utf8"));
    providerState.activeTurnId = null;
    await writeFile(join(root, "fake-state.json"), JSON.stringify(providerState));
    restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: persisted.activeTurnId });
    const recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-steer", transportFactory: () => restored!.transport });
    const completion = await executeNativeSession({
      input: execution, backend: recovering, persistedSession: persisted, resumeInterruptedTurn: true,
      getUnreadSteeredMessages: async () => unread(durableEvents).map(id => ({ id, text: id === commentId ? steeredText : "" })),
      runnerInstanceId: "runner-steer", controlPlaneInstanceId: "controller-steer", timeoutMs: 15_000,
      controlPlane: {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent(event) { if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event"); durableEvents.push(event); return { cursor: durableEvents.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
        async replayEvents(request) {
          const source = durableEvents.filter(event => event.sourceInstanceId === request.sourceInstanceId);
          return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq), highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
        },
        async completeRun() {},
      },
    });
    expect(completion).toMatchObject({ turnId: "provider-turn-2", terminal: { runTerminalState: "succeeded" } });
    const journal = JSON.parse(await readFile(join(root, "control-plane/control-plane-state.json"), "utf8"));
    const submissions: Array<{ payload: { text: string } }> = journal.commands.filter((command: { type: string }) => command.type === "turn.start");
    expect(submissions).toHaveLength(2);
    const continuation = submissions[1]!.payload.text;
    expect(continuation).toContain("Reconcile any unfinished tool or command");
    expect(continuation.split(steeredText).length - 1).toBe(state === "unread" ? 1 : 0);
    if (state === "unread") expect(JSON.parse(continuation).steeredMessages).toEqual([steeredText]);
    // The continuation's completed turn is the durable read fact: a later
    // restart has nothing left to deliver.
    expect(unread(durableEvents)).toEqual([]);
  } finally {
    await restored?.transport.close().catch(() => undefined);
    for (const bundle of [first, restored]) {
      if (!bundle) continue;
      const evidence = bundle.evidence();
      kill(evidence.runnerPid);
      kill(evidence.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
