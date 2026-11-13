import { describe, expect, it, vi } from "vitest";

import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type { NativeSession } from "./contracts/native-session-backend.js";
import { executeNativeSession } from "./native-session-runtime.js";
import type { PrpEvent } from "./protocol/replay-contract.js";

const identity = {
  runId: "run-provider-turn",
  sessionId: "session-provider-turn",
  companyId: "company-provider-turn",
  issueId: "issue-provider-turn",
  agentId: "agent-provider-turn",
};

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: { companyId: identity.companyId, runId: identity.runId, issueId: identity.issueId, agentId: identity.agentId,
    executionWorkspaceId: "workspace-provider-turn" },
  task: { identifier: "PAP-PROVIDER", title: "Wait for a background install", description: null,
    prompt: "# PAP-PROVIDER: Wait for a background install", workMode: "standard" },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
  provider: { kind: "codex", model: null },
  completionContract: { id: "contract-provider-turn", sha256: "contract-provider-turn-sha", schemaVersion: "paperclip.completion-contract.v1",
    contract: { revision: "1", objective: "Install and test", criteria: [{ id: "objective", requirement: "Install and test" }] } },
  interactionResponses: [],
  credentialBindings: [],
};

const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
  schema: "paperclip.prp.event.v1",
  sourceEventId: `runner-provider-turn:${identity.runId}:${sourceSeq}`,
  sourceSeq,
  sourceInstanceId: "runner-provider-turn",
  sourceKind: "runner",
  runId: identity.runId,
  normalizedSessionId: identity.sessionId,
  turnId: "turn-1",
  eventType,
  schemaVersion: 1,
  priority: 0,
  emittedAt: "2026-11-12T00:00:00.000Z",
  payload,
});

const usage = { provider: "acpx", model: null, providerSessionId: null, providerRequestId: null,
  cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, activeSeconds: 0, requests: 1, providerCostUsd: 0 },
  runDeltaAvailable: true,
  runDelta: { inputTokens: 6, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, activeSeconds: 0, requests: 1, providerCostUsd: 0 } };

const turnOne = (awaiting: boolean): PrpEvent[] => [
  event(1, "turn.started", { provider: "acpx", providerTurnId: "turn-1", status: "inProgress", turn: { id: "turn-1", status: "inProgress" } }),
  event(2, "usage.reported", usage),
  event(3, "turn.completed", { provider: "acpx", providerTurnId: "turn-1", status: "completed", error: null,
    ...(awaiting ? { awaitingProviderTurn: true } : {}) }),
  ...(awaiting ? [] : [event(4, "run.terminal", { schema: "paperclip.prp.terminal.v1", status: "succeeded", turnTerminalState: "completed",
    runTerminalState: "succeeded", reportedWorkDisposition: "done", provider: "acpx" })]),
];

const providerTurn: PrpEvent[] = [
  event(4, "turn.started", { provider: "acpx", providerTurnId: "provider-1", status: "inProgress",
    turn: { id: "provider-1", status: "inProgress" }, origin: "provider" }),
  event(5, "turn.completed", { provider: "acpx", providerTurnId: "provider-1", status: "completed", error: null }),
];

async function finalize(stream: PrpEvent[]) {
  const appended: PrpEvent[] = [];
  const completeRun = vi.fn(async () => undefined);
  const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  const session: NativeSession = {
    identity: () => identity,
    async capabilities() { return capabilities; },
    async *events() { for (const value of stream) yield structuredClone(value); },
    async startTurn() { return { turnId: "turn-1" }; },
    async result() { return null; },
    async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity,
      providerSessionId: "provider-session", cursor: String(stream.length), activeTurnId: "turn-1", pendingRuntimeRequests: [], lineage: [] }; },
    async close() {},
  };
  const outcome = await executeNativeSession({
    input,
    backend: { async descriptor() { return { kind: "mock", name: "provider-turn", version: "1", capabilities }; }, async openSession() { return session; } },
    controlPlane: {
      async openRun() {}, async checkpointSession() {},
      async appendEvent(value: PrpEvent) {
        appended.push(structuredClone(value));
        return { cursor: value.sourceSeq, highestContiguousSourceSeq: value.sourceSeq, disposition: "committed" };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      completeRun,
    },
    runnerInstanceId: "runner-provider-turn", controlPlaneInstanceId: "control-provider-turn", timeoutMs: 1000,
    resolveMissingResult: async () => null,
  }).then(() => "finalized", (error: unknown) => String(error instanceof Error ? error.message : error));
  return { outcome, appended, completeRun };
}

describe("today's controller consumer with provider-started turn sequences", () => {
  it("finalizes a no-result turn with live shells exactly as before when the controller did not opt in", async () => {
    const withoutOptIn = await finalize(turnOne(false));
    expect(withoutOptIn.outcome).toContain("native_finalization_missing");
    expect(withoutOptIn.completeRun).not.toHaveBeenCalled();
    expect(withoutOptIn.appended.map(value => value.eventType)).toEqual(["turn.started", "usage.reported", "turn.completed"]);
  });

  it("would end the run at the awaited terminal and never consume the provider-started turn, so the opt-in must stay off", async () => {
    const optedIn = await finalize([...turnOne(true), ...providerTurn]);
    expect(optedIn.outcome).toContain("native_finalization_missing");
    expect(optedIn.appended.some(value => value.payload.origin === "provider")).toBe(false);
  });
});
