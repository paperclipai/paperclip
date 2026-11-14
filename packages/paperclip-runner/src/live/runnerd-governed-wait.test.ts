import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { PrpEvent, PrpStructuredRunResult } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

it.each([0, 18_000, null])("requires a Codex terminal or verified shutdown when parking a wait (delay: %s)", async terminalDelayMs => {
  const root = await mkdtemp(join(tmpdir(), "runner-governed-wait-"));
  const input: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      runId: "run-wait", companyId: "company-wait", issueId: "issue-wait",
      agentId: "agent-wait", executionWorkspaceId: "workspace-wait",
    },
    session: {
      normalizedSessionId: "session-wait", driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    },
    task: {
      identifier: "TEST-1", title: "Ask for access", description: null,
      prompt: "Ask for required access.", workMode: "standard",
    },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: {
      id: "contract-wait", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1",
      contract: {
        revision: "1", objective: "Ask for access",
        criteria: [{ id: "access", requirement: "Obtain access" }],
      },
    },
    interactionResponses: [], credentialBindings: [],
  };
  const bundle = createRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--hold-turn", "--emit-tool-call", "--call-log", join(root, "calls.log"),
      ...(terminalDelayMs === null
        ? ["--accept-interrupt-without-terminal"]
        : ["--interrupt-terminal-delay-ms", String(terminalDelayMs)])),
    stateDirectory: root,
    prpIdentity: {
      runnerInstanceId: "runner-wait", environmentLeaseId: "lease-wait", runId: "run-wait",
      normalizedSessionId: "session-wait", turnId: "turn-wait", itemId: "item-wait",
    },
  });
  // The controlled provider calls its standard dynamic-tool fixture. The port
  // below supplies the server's already-resolved governed-wait disposition.
  const tool = vi.fn(async () => ({ ok: true, task: { id: "task-1" } }));
  const backend = createRunnerdNativeSessionBackend(input, {
    runnerInstanceId: "runner-wait", transportFactory: () => bundle.transport,
    dynamicTools: [{
      name: "get_task_context", description: "Read the task.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
    dynamicToolHandler: tool,
  });
  const yielded: PrpStructuredRunResult = {
    schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Waiting for access.",
    completionClaim: {
      contractRevision: "1", objectiveSatisfied: false,
      criteria: [{ criterionId: "access", status: "unknown", evidenceRefs: [] }],
      remainingWork: [{ description: "Await access.", blocksCompletion: true }],
    },
    evidence: [], verification: [], attentionRequests: [], artifacts: [],
    continuation: { kind: "response_wake", summary: "Continue after access.", idempotencyKey: "question-1" },
  };
  const history: PrpEvent[] = [];
  const completeRun = vi.fn(async () => undefined);
  let checkpoint: PersistedNativeSession | undefined;
  try {
    const execution = executeNativeSession({
      input, backend, runnerInstanceId: "runner-wait", controlPlaneInstanceId: "controller-wait", timeoutMs: 120_000,
      controlPlane: {
        async openRun() {},
        async checkpointSession(value) { checkpoint = structuredClone(value); },
        completeRun,
        async appendEvent(event: PrpEvent) {
          history.push(event);
          return { cursor: history.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
        },
        async replayEvents(request) {
          return {
            events: history.filter(event => event.sourceInstanceId === request.sourceInstanceId && event.sourceSeq > request.afterSourceSeq),
            highestContiguousSourceSeq: 0,
          };
        },
      },
      resolveGovernedWait: ({ event }) => event.eventType === "item.completed" && event.payload.kind === "dynamicToolCall" ? yielded : null,
    });
    await expect(execution).resolves.toMatchObject({ result: yielded });
    expect(completeRun).toHaveBeenCalledOnce();
    if (terminalDelayMs === null) {
      expect(history.filter(event => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType))).toEqual([]);
      expect(checkpoint?.governedWait?.settlement).toEqual({ runId: input.binding.runId,
        normalizedSessionId: input.session.normalizedSessionId, turnId: checkpoint?.governedWait?.sourceEvent.turnId });
      const journal = JSON.parse(await readFile(join(root, "control-plane/control-plane-state.json"), "utf8"));
      expect(journal.commands.find((command: { type: string }) => command.type === "turn.stop"))
        .toMatchObject({ status: "completed", result: { result: { providerExitConfirmed: true } } });
      expect(JSON.parse(await readFile(join(root, "runner/runner-state.json"), "utf8"))).toMatchObject({ lifecycle: "suspended" });
    } else {
      expect(history.some(event => event.eventType === "turn.interrupted")).toBe(true);
    }
    expect(checkpoint?.governedWait?.result).toEqual(yielded);
    expect(tool).toHaveBeenCalledOnce();
    const calls = (await readFile(join(root, "calls.log"), "utf8")).split("\n");
    expect(calls.filter(call => call === "turn/start")).toHaveLength(1);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
