import { describe, expect, it, vi } from "vitest";

import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type { NativeSession } from "./contracts/native-session-backend.js";
import { executeNativeSession } from "./native-session-runtime.js";
import { providerTurnWaitDeadline, PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS, type ProviderTurnWaitOptions } from "./native-provider-turn-wait.js";
import type { PrpEvent, PrpStructuredRunResult } from "./protocol/replay-contract.js";

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

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Installed and tested after the background install finished.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [],
  verification: [{ commandOrCheck: "pnpm test", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const planReviewWait: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "yielded",
  summary: "Waiting for the plan review.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: false,
    criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: ["interaction:plan"] }],
    remainingWork: [{ description: "Resume after the plan review.", blocksCompletion: true }] },
  evidence: [{ ref: "interaction:plan" }],
  verification: [],
  attentionRequests: [],
  artifacts: [{ kind: "issue_thread_interaction", ref: "interaction:plan" }],
  continuation: { kind: "response_wake", summary: "Resume from the plan review.", idempotencyKey: "interaction-response:plan" },
};

let sequence = 0;
const event = (turnId: string, eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}): PrpEvent => {
  sequence += 1;
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `runner-provider-turn:${identity.runId}:${sequence}`,
    sourceSeq: sequence,
    sourceInstanceId: "runner-provider-turn",
    sourceKind: "runner",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId,
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-11-12T00:00:00.000Z",
    payload,
  };
};

const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 6, outputTokens: 4 } } };
const turnOne = (awaiting: boolean) => [
  event("turn-1", "turn.started", { status: "inProgress" }),
  event("turn-1", "item.completed", usage),
  event("turn-1", "turn.completed", { status: "completed", error: null, ...(awaiting ? { awaitingProviderTurn: true } : {}) }),
];
const providerTurn = (turnId: string, options: { result?: boolean; awaiting?: boolean } = {}) => [
  event(turnId, "turn.started", { status: "inProgress", origin: "provider" }),
  event(turnId, "item.completed", usage),
  ...(options.result ? [event(turnId, "run.result.proposed", result as unknown as Record<string, unknown>)] : []),
  event(turnId, "turn.completed", { status: "completed", error: null, ...(options.awaiting ? { awaitingProviderTurn: true } : {}) }),
];

function harness(options: { withoutInterrupt?: boolean } = {}) {
  const queue: Array<PrpEvent | "end"> = [];
  let wake: (() => void) | null = null;
  let activeProviderTurn: string | null = null;
  const push = (...values: Array<PrpEvent | "end">) => {
    for (const value of values) {
      if (value !== "end" && value.eventType === "turn.started") activeProviderTurn = value.turnId ?? null;
      if (value !== "end" && value.eventType.startsWith("turn.") && value.eventType !== "turn.started") activeProviderTurn = null;
      queue.push(value);
    }
    wake?.();
  };
  const interrupt = vi.fn(async (_input: { turnId?: string; reason?: string }) => {
    if (activeProviderTurn) push(event(activeProviderTurn, "turn.cancelled", { status: "cancelled", error: null }));
    else push(event("turn-1", "item.completed", { kind: "interrupt_acknowledgement", status: "provider_turn_wait_ended" }));
  });
  const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  const session: NativeSession = {
    identity: () => identity,
    async capabilities() { return capabilities; },
    async *events() {
      for (;;) {
        const next = queue.shift();
        if (next === "end") return;
        if (next) { yield structuredClone(next); continue; }
        await new Promise<void>(resolve => { wake = resolve; });
        wake = null;
      }
    },
    async startTurn() { return { turnId: "turn-1" }; },
    ...(options.withoutInterrupt ? {} : { interrupt }),
    async result() { return null; },
    async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity,
      providerSessionId: "provider-session", cursor: String(sequence), activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; },
    async close() { push("end"); },
  };
  return { session, push, interrupt };
}

async function run(options: {
  stream: PrpEvent[];
  after?: (control: ReturnType<typeof harness>, appended: PrpEvent[]) => Promise<void> | void;
  providerTurnWait?: ProviderTurnWaitOptions;
  turnTimeoutMs?: number;
  missingResult?: (input: { turnId: string | null; terminalEvent: PrpEvent }) => PrpStructuredRunResult | null;
  withoutInterrupt?: boolean;
  pipelinesDeltas?: boolean;
}) {
  const control = harness({ withoutInterrupt: options.withoutInterrupt });
  const appended: PrpEvent[] = [];
  let queued: Array<() => void> = [];
  const flushStreamingEvents = vi.fn(() => {
    const flushed = queued;
    queued = [];
    for (const commit of flushed) commit();
  });
  let returned: Awaited<ReturnType<typeof executeNativeSession>> | null = null;
  const completeRun = vi.fn(async () => undefined);
  const resolveMissingResult = vi.fn(async (value: { turnId: string | null; terminalEvent: PrpEvent }) => options.missingResult?.(value) ?? null);
  control.push(...options.stream);
  const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
  const started = Date.now();
  const execution = executeNativeSession({
    input,
    backend: { async descriptor() { return { kind: "mock", name: "provider-turn", version: "1", capabilities }; },
      async openSession() { return control.session; } },
    controlPlane: {
      ...(options.pipelinesDeltas ? { pipelinesStreamingEvents: true, flushStreamingEvents } : {}),
      async openRun() {}, async checkpointSession() {},
      async appendEvent(value: PrpEvent) {
        appended.push(structuredClone(value));
        if (options.pipelinesDeltas && value.eventType === "item.delta") await new Promise<void>(resolve => queued.push(resolve));
        return { cursor: value.sourceSeq, highestContiguousSourceSeq: value.sourceSeq, disposition: "committed" };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      completeRun,
    },
    runnerInstanceId: "runner-provider-turn", controlPlaneInstanceId: "control-provider-turn", timeoutMs: 30_000,
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    resolveMissingResult,
    providerTurnWait: options.providerTurnWait,
  }).then((value) => { returned = value; return "finalized"; }, (error: unknown) => String(error instanceof Error ? error.message : error));
  await options.after?.(control, appended);
  const outcome = await execution;
  return { outcome, returned, appended, completeRun, resolveMissingResult, interrupt: control.interrupt, flushStreamingEvents,
    elapsedMs: Date.now() - started };
}

const types = (events: PrpEvent[]) => events.map(value => value.eventType);
const waitFor = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 5_000, interval: 5 });

describe("the controller consumer with provider-started turn sequences", () => {
  it("finalizes a no-result turn exactly as before when the Runner did not await", async () => {
    const outcome = await run({ stream: [...turnOne(false), ...providerTurn("provider-1", { result: true })] });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.completeRun).not.toHaveBeenCalled();
    expect(types(outcome.appended)).toEqual(["turn.started", "item.completed", "turn.completed"]);
    expect(outcome.interrupt).not.toHaveBeenCalled();
  });

  it("consumes the provider-started turn as the next turn of the same run and settles its result normally", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.completeRun).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).not.toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.payload.origin === "provider").map(value => value.turnId)).toEqual(["provider-1"]);
    expect(outcome.appended.filter(value => value.payload.kind === "usage").map(value => value.turnId)).toEqual(["turn-1", "provider-1"]);
    expect(outcome.interrupt).not.toHaveBeenCalled();
  });

  it("keeps waiting when a provider-started turn also ends awaiting, then settles the later turn's result", async () => {
    const outcome = await run({ stream: [...turnOne(true), ...providerTurn("provider-1", { awaiting: true }),
      ...providerTurn("provider-2", { result: true })] });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.appended.filter(value => value.payload.origin === "provider").map(value => value.turnId)).toEqual(["provider-1", "provider-2"]);
  });

  it("ends an idle wait at the cap by stopping the wait, then takes today's missing-result path with the awaited terminal", async () => {
    const outcome = await run({ stream: turnOne(true), providerTurnWait: { capMs: 100 } });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.interrupt.mock.calls[0]![0]).toMatchObject({ turnId: "turn-1" });
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn-1", terminalEvent: expect.objectContaining({ eventType: "turn.completed", payload: expect.objectContaining({ awaitingProviderTurn: true }) }) }));
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(90);
  });

  it("does not restart the cap when a later provider-started turn also ends without a result", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 300 },
      after: async (control) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        control.push(...providerTurn("provider-1", { awaiting: true }));
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.elapsedMs).toBeLessThan(450);
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "provider-1" }));
  });

  it.each(["cap", "comment"] as const)("lets a running provider-started turn finish after the %s and settles its result normally", async (trigger) => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: trigger === "cap" ? { capMs: 150 } : { capMs: 60_000, onWait },
      after: async (control) => {
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        if (trigger === "comment") { await waitFor(() => onWait.mock.calls.length === 1); release(); }
        await new Promise(resolve => setTimeout(resolve, 300));
        control.push(event("provider-1", "item.completed", usage), event("provider-1", "run.result.proposed", result as unknown as Record<string, unknown>),
          event("provider-1", "turn.completed", { status: "completed", error: null }));
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.completeRun).toHaveBeenCalledOnce();
    expect(outcome.appended.some(value => value.eventType === "turn.cancelled")).toBe(false);
  });

  it.each(["cap", "comment"] as const)("takes today's path at once when a provider-started turn running past the %s ends awaiting again", async (trigger) => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    let endedAt = 0;
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: trigger === "cap" ? { capMs: 150 } : { capMs: 60_000, onWait },
      after: async (control) => {
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        if (trigger === "comment") { await waitFor(() => onWait.mock.calls.length === 1); release(); }
        await new Promise(resolve => setTimeout(resolve, 300));
        endedAt = Date.now();
        control.push(event("provider-1", "item.completed", usage),
          event("provider-1", "turn.completed", { status: "completed", error: null, awaitingProviderTurn: true }));
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({ turnId: "provider-1" }));
    expect(Date.now() - endedAt).toBeLessThan(1_000);
  });

  it("settles a batched delta that arrived during the idle wait before the limit ends the turn", async () => {
    let delta!: PrpEvent;
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 150 }, withoutInterrupt: true, pipelinesDeltas: true,
      missingResult: () => result,
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        delta = { ...event("turn-1", "item.delta", { kind: "agentMessage", text: "late chunk" }), itemId: "message-1", priority: 1 };
        control.push(delta);
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.flushStreamingEvents).toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.eventType === "item.delta")).toHaveLength(1);
    expect(outcome.returned).toMatchObject({ nativeEventCount: outcome.appended.length, highestContiguousSourceSeq: delta.sourceSeq });
  });

  it("never waits longer than the run's remaining timeout", async () => {
    const turnTimeoutMs = PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS + 200;
    const outcome = await run({ stream: turnOne(true), turnTimeoutMs });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.outcome).not.toContain("timed out");
    expect(outcome.elapsedMs).toBeLessThan(2_000);
    expect(providerTurnWaitDeadline({ startedAtMs: 1_000, capMs: 600_000, overallDeadlineMs: null })).toBe(601_000);
    expect(providerTurnWaitDeadline({ startedAtMs: 1_000, capMs: 600_000, overallDeadlineMs: 60_000 }))
      .toBe(60_000 - PROVIDER_TURN_WAIT_TIMEOUT_MARGIN_MS);
  });

  it("resumes the cap from the wait start a previous controller recorded", async () => {
    const outcome = await run({ stream: turnOne(true), providerTurnWait: { startedAtMs: Date.now() - 599_900 } });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.elapsedMs).toBeLessThan(2_000);
  });

  it("ends the wait early when the control plane reports a new comment", async () => {
    let release!: () => void;
    const comment = new Promise<void>(resolve => { release = resolve; });
    const onWait = vi.fn(() => comment);
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000, onWait },
      after: async () => { await waitFor(() => onWait.mock.calls.length === 1); release(); },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  it("ends the wait at once when Stop interrupts the session", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000 },
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        await control.session.interrupt!({ reason: "Stop" });
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.interrupt).toHaveBeenCalledOnce();
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  it("tolerates the Runner's held run.terminal during the wait and after Core ends it", async () => {
    const heldTerminal = () => event("turn-1", "run.terminal", { schema: "paperclip.prp.terminal.v1", status: "succeeded",
      turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done", provider: "acpx" });
    const outcome = await run({
      stream: [...turnOne(true), heldTerminal()], providerTurnWait: { capMs: 150 },
      after: async (control) => {
        await waitFor(() => control.interrupt.mock.calls.length === 1);
        control.push(heldTerminal());
      },
    });
    expect(outcome.outcome).toContain("native_finalization_missing");
    expect(outcome.appended.filter(value => value.eventType === "run.terminal")).toHaveLength(1);
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
  });

  it.each([false, true])("settles a plan proposed in the provider-started turn as the plan review wait (cap passed during the turn: %s)", async (capPassed) => {
    let seen: PrpEvent[] = [];
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: capPassed ? 100 : 60_000 },
      missingResult: ({ terminalEvent }) => seen.some(value => value.eventType === "plan.proposed")
        && terminalEvent.eventType === "turn.completed" ? planReviewWait : null,
      after: async (control, appended) => {
        seen = appended;
        control.push(event("provider-1", "turn.started", { status: "inProgress", origin: "provider" }));
        await waitFor(() => appended.some(value => value.payload.origin === "provider"));
        if (capPassed) await new Promise(resolve => setTimeout(resolve, 250));
        control.push(
          event("provider-1", "plan.proposed", { schema: "paperclip.plan.proposed.v1", proposalId: "toolu_plan", status: "completed",
            markdown: "# Plan\n\n1. Install.\n2. Test.", source: "claude_exit_plan_mode" }),
          event("provider-1", "item.completed", usage),
          event("provider-1", "turn.completed", { status: "completed", error: null }),
          event("provider-1", "run.terminal", { schema: "paperclip.prp.terminal.v1", status: "succeeded", turnTerminalState: "completed",
            runTerminalState: "succeeded", reportedWorkDisposition: "done", provider: "acpx" }),
        );
      },
    });
    expect(outcome.outcome).toBe("finalized");
    expect(outcome.interrupt).not.toHaveBeenCalled();
    expect(outcome.appended.filter(value => value.eventType === "plan.proposed")).toEqual([expect.objectContaining({ turnId: "provider-1", payload: expect.objectContaining({ status: "completed" }) })]);
    expect(outcome.resolveMissingResult).toHaveBeenCalledOnce();
    expect(outcome.resolveMissingResult).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "provider-1", terminalEvent: expect.objectContaining({ eventType: "turn.completed", turnId: "provider-1" }) }));
    expect(outcome.resolveMissingResult.mock.calls[0]![0].terminalEvent.payload).not.toHaveProperty("awaitingProviderTurn");
    expect((outcome.completeRun.mock.calls[0] as unknown[])[0]).toMatchObject({ result: planReviewWait, turnId: "provider-1",
      terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "yielded" } });
  });

  it("fails the run as today when the Runner's stream ends during the wait", async () => {
    const outcome = await run({
      stream: turnOne(true), providerTurnWait: { capMs: 60_000 },
      after: async (control, appended) => {
        await waitFor(() => appended.some(value => value.payload.awaitingProviderTurn === true));
        control.push("end");
      },
    });
    expect(outcome.outcome).toContain("native event stream closed before a turn terminal fact");
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });
});
