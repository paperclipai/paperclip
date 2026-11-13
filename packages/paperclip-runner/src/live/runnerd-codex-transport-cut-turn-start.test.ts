import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

/**
 * A restart can kill the runner and its Codex process while `turn/start` is in
 * flight. The runner journaled the command and marked the start ambiguous, so
 * the restored runner cannot know from its own state whether Codex created the
 * turn, and the resumed thread has no active turn either way.
 *
 * - "before": Codex never created the turn. The resumed thread's history ends
 *   at a turn Paperclip already settled (here: no turn at all), which proves the
 *   start never happened. The same-run resume starts the turn exactly once.
 * - "after": Codex recorded the turn, then died. Its history names a turn
 *   Paperclip never settled. The turn may have done work, so the runner still
 *   fails closed and never starts it again by itself.
 */
it.each(["before", "after"] as const)("resumes a run whose turn.start a restart cut off (provider stopped %s creating the turn)", async (stage) => {
  const root = await mkdtemp(join(tmpdir(), `runnerd-cut-turn-start-${stage}-`));
  const callsPath = join(root, "calls.log");
  const hangPath = join(root, "hang-turn-start");
  const identity = { runId: "run-cut-start", sessionId: "session-cut-start", companyId: "company-cut-start", issueId: "issue-cut-start", agentId: "agent-cut-start" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace-cut-start" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-7", title: "Write the brief", description: null, prompt: "Write the brief with the answer marker.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-cut-start", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Write the brief", criteria: [{ id: "brief", requirement: "Write the brief" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--call-log", callsPath, "--durable-turn-ids", "--hang-turn-start", hangPath],
    stateDirectory: root,
    turnStartTimeoutMs: 8_000,
    prpIdentity: { runnerInstanceId: "runner-cut-start", environmentLeaseId: "lease-cut-start", runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn-cut-start", itemId: "item-cut-start" },
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
  const turnStarts = async () => ((await readFile(callsPath, "utf8")).match(/^turn\/start$/gm) ?? []).length;
  try {
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-cut-start", transportFactory: () => first.transport });
    const session = await backend.openSession({ identity, workingDirectory: root });
    // The last checkpoint the controller persisted: no active turn.
    const checkpoint = await session.snapshot();
    expect(checkpoint.activeTurnId ?? null).toBeNull();
    await writeFile(hangPath, stage);
    const starting = session.startTurn({ message: { role: "user", text: execution.task.prompt } }).catch((error: unknown) => error);
    // The runner journaled turn.start, marked the start ambiguous and sent it.
    await vi.waitFor(async () => {
      const provider = JSON.parse(await readFile(join(root, "runner", "codex-provider-state.json"), "utf8"));
      expect(provider.ambiguousTurnStartPending).toBe(true);
      expect(await turnStarts()).toBe(1);
      if (stage === "after") expect(JSON.parse(await readFile(join(root, "fake-state.json"), "utf8")).activeTurnId).toBe("provider-turn-1");
    }, { timeout: 8_000, interval: 25 });
    const owner = first.evidence();
    await first.detachControllerForRestart();
    kill(owner.runnerPid);
    kill(owner.providerPid);
    await vi.waitFor(() => { expect(alive(owner.runnerPid)).toBe(false); expect(alive(owner.providerPid)).toBe(false); });
    await starting;
    await rm(hangPath, { force: true });
    // Codex's process-loss history: the thread remains, its in-memory turn does not.
    const providerState = JSON.parse(await readFile(join(root, "fake-state.json"), "utf8"));
    providerState.activeTurnId = null;
    await writeFile(join(root, "fake-state.json"), JSON.stringify(providerState));

    restored = createRunnerdCodexTransport({ ...options, resumeDynamicTools: [], resumeActiveTurnId: null });
    const recovering = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-cut-start", transportFactory: () => restored!.transport });
    const events: PrpEvent[] = [];
    const executing = executeNativeSession({
      input: execution, backend: recovering, persistedSession: checkpoint, resumeInterruptedTurn: true,
      runnerInstanceId: "runner-cut-start", controlPlaneInstanceId: "controller-cut-start", timeoutMs: 15_000,
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
    const control = async () => JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8")) as {
      commands: Array<{ type: string; status: string; payload: { text?: string }; result?: { result?: { code?: string } } }>;
    };
    if (stage === "before") {
      const completion = await executing;
      expect(completion).toMatchObject({ providerSessionId: checkpoint.providerSessionId, terminal: { runTerminalState: "succeeded" } });
      expect(events.find(event => event.eventType === "session.failed")).toBeUndefined();
      // The cut-off start stays settled as unknown and is never executed again;
      // one new start carries the same task, and Codex saw exactly one more.
      const starts = (await control()).commands.filter(command => command.type === "turn.start");
      expect(starts).toHaveLength(2);
      expect(starts[0]).toMatchObject({ status: "failed", result: { result: { code: "execution_indeterminate" } } });
      expect(starts[1]).toMatchObject({ status: "completed" });
      expect(starts[1]!.payload.text).toContain(execution.task.prompt);
      expect(await turnStarts()).toBe(2);
    } else {
      await expect(executing).rejects.toThrow(/cannot safely recover an ambiguous Codex turn start/);
      // Possibly started work is never started again without a person.
      expect(await turnStarts()).toBe(1);
      const starts = (await control()).commands.filter(command => command.type === "turn.start");
      expect(starts).toHaveLength(1);
    }
  } finally {
    await rm(hangPath, { force: true });
    await restored?.transport.close().catch(() => undefined);
    for (const bundle of [first, restored]) {
      if (!bundle) continue;
      const evidence = bundle.evidence();
      kill(evidence.runnerPid);
      kill(evidence.providerPid);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
