import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it.each(["none", "before-start", "after-start"] as const)("completes after the real runner and provider are killed (second crash: %s)", async (crash) => {
  const root = await mkdtemp(join(tmpdir(), "runner-restart-continuation-"));
  const identity = { runId: "run-restart", sessionId: "session-restart", companyId: "company-restart", issueId: "issue-restart", agentId: "agent-restart" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-restart" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
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
        async appendEvent(event) { events.push(event); durableEvents.push(event); return { cursor: durableEvents.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
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
