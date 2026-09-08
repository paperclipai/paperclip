import { describe, expect, it } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeRunIdentity,
  NativeSessionCapabilities,
} from "../contracts/types.js";
import type { NativeSession } from "../contracts/native-session-backend.js";
import {
  type PrpCapabilities,
  type PrpEvent,
  type PrpIdentity,
  type PrpStructuredRunResult,
  validatePrpEvent,
} from "../protocol/replay-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../reducer/session-reducer.js";
import { buildTranscript } from "../browser/transcript-model.js";
import { createNativeSessionBackend } from "../backends/native-backend-factory.js";
import {
  FakeCodexTransport,
  WORKSPACE,
  collectUntilTerminal,
} from "../drivers/codex/codex-app-server-driver.test-support.js";

type ProfileKey = "codex" | "opencode" | "acpx-claude" | "acpx-codex";

interface LocalNativeProfile {
  key: ProfileKey;
  driverKind: NativeExecutionInput["session"]["driverKind"];
  provider: NativeExecutionInput["provider"];
}

/**
 * These rows exercise the production runnerd facade after Rust has normalized
 * each provider into the Codex-compatible transport boundary. Raw OpenCode and
 * ACPX parsing/fault behavior remains covered by their provider-specific Rust
 * and TypeScript suites; this matrix verifies the common PRP authority and
 * projection contract does not vary by the selected local profile.
 */
const RUNNERD_FACADE_PROFILES = [
  {
    key: "codex",
    driverKind: "codex_app_server",
    provider: { kind: "codex", model: "gpt-test", approvalPolicy: "never" },
  },
  {
    key: "opencode",
    driverKind: "opencode_server",
    provider: {
      kind: "opencode",
      model: "openrouter/test-model",
      permissionMode: "ask",
    },
  },
  {
    key: "acpx-claude",
    driverKind: "acpx_runtime",
    provider: {
      kind: "acpx",
      agent: "claude",
      model: "claude-test",
      permissionPolicy: "interactive",
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent: "claude",
        agentProfileVersion: 1,
        agentServerPackage: "@agentclientprotocol/claude-agent-acp",
        agentServerVersion: "0.70.0",
        agentRuntimePackage: null,
        agentRuntimeVersion: null,
        commandDigest: `sha256:${"a".repeat(64)}`,
      },
    },
  },
  {
    key: "acpx-codex",
    driverKind: "acpx_runtime",
    provider: {
      kind: "acpx",
      agent: "codex",
      model: "gpt-test",
      permissionPolicy: "interactive",
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent: "codex",
        agentProfileVersion: 1,
        agentServerPackage: "@agentclientprotocol/codex-acp",
        agentServerVersion: "1.6.2",
        agentRuntimePackage: null,
        agentRuntimeVersion: null,
        commandDigest: `sha256:${"b".repeat(64)}`,
      },
    },
  },
] as const satisfies readonly LocalNativeProfile[];

function executionInput(
  profile: LocalNativeProfile,
  runId: string,
  normalizedSessionId: string,
): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: "company-local-integrity",
      runId,
      issueId: "issue-local-integrity",
      agentId: `agent-${profile.key}`,
      executionWorkspaceId: "workspace-local-integrity",
    },
    task: {
      identifier: "LOCAL-1",
      title: `Exercise the ${profile.key} local runner boundary`,
      description: null,
      prompt: "Return the exact requested response.",
      workMode: "standard",
    },
    workspace: {
      cwd: WORKSPACE,
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId,
      driverKind: profile.driverKind,
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: structuredClone(profile.provider),
    completionContract: {
      id: "local-integrity-contract",
      sha256: `sha256:${"c".repeat(64)}`,
      schemaVersion: "1",
      contract: {
        revision: "local-integrity-v1",
        objective: "Return the exact requested response.",
        criteria: [
          {
            id: "exact-response",
            requirement: "The provider returns the requested exact response.",
          },
        ],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };
}

function completionResult(profile: LocalNativeProfile): PrpStructuredRunResult {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: `${profile.key} completed the deterministic integrity task.`,
    completionClaim: {
      contractRevision: "local-integrity-v1",
      objectiveSatisfied: true,
      criteria: [
        {
          criterionId: "exact-response",
          status: "satisfied",
          evidenceRefs: [],
        },
      ],
      remainingWork: [],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
  };
}

function nativeIdentity(
  profile: LocalNativeProfile,
  runId: string,
  normalizedSessionId: string,
): NativeRunIdentity {
  return {
    runId,
    sessionId: normalizedSessionId,
    companyId: "company-local-integrity",
    issueId: "issue-local-integrity",
    agentId: `agent-${profile.key}`,
  };
}

function prpIdentity(
  identity: NativeRunIdentity,
  runnerInstanceId: string,
): PrpIdentity {
  return {
    schema: "paperclip.prp.identity.v1",
    companyId: identity.companyId,
    issueId: identity.issueId,
    runId: identity.runId,
    environmentLeaseId: "lease-local-integrity",
    runnerInstanceId,
    normalizedSessionId: identity.sessionId,
    driverSessionId: "thread-1",
    providerSessionId: "provider-session-1",
  };
}

function prpCapabilities(
  driverKind: string,
  driverVersion: string,
  capabilities: NativeSessionCapabilities,
): PrpCapabilities {
  return {
    schema: "paperclip.prp.capabilities.v1",
    sessionReusePolicy: "reuse_per_issue",
    driver: { kind: driverKind, version: driverVersion },
    steer: capabilities.steering,
    interrupt: capabilities.interruption,
    resume: capabilities.resume,
    runtimeRequests: capabilities.runtimeRequestResolution === true,
    structuredResult: capabilities.structuredResult,
    typedEvents: capabilities.typedEvents,
    unsupported: capabilities.unsupported ?? [],
  };
}

async function project(
  profile: LocalNativeProfile,
  session: NativeSession,
  events: PrpEvent[],
) {
  const capabilities = await session.capabilities();
  const initial = createSessionSnapshotFromMetadata({
    fixtureName: `local-provider-fault-matrix-${profile.key}`,
    identity: prpIdentity(
      session.identity(),
      events[0]?.sourceInstanceId ?? `runner-${profile.key}`,
    ),
    capabilities: prpCapabilities(
      profile.driverKind,
      "local-integrity-test",
      capabilities,
    ),
  });
  const snapshot = events.reduce(applyPrpEvent, initial);
  return { snapshot, transcript: buildTranscript(snapshot, events) };
}

async function openSession(
  profile: LocalNativeProfile,
  scenario: string,
  transports: FakeCodexTransport[],
) {
  const runId = `run-${profile.key}-${scenario}`;
  const normalizedSessionId = `session-${profile.key}`;
  let transportIndex = 0;
  const backend = createNativeSessionBackend(
    executionInput(profile, runId, normalizedSessionId),
    {
      runnerInstanceId: `runner-${profile.key}`,
      environment: {
        ...process.env,
        PAPERCLIP_WORKSPACE_CWD: WORKSPACE,
      },
      codexTransportFactory: () => {
        const transport = transports[transportIndex++];
        if (transport === undefined) {
          throw new Error(
            `${profile.key} ${scenario} exhausted its deterministic transports`,
          );
        }
        return transport;
      },
    },
  );
  await expect(backend.descriptor()).resolves.toMatchObject({
    kind: "runner",
    name: profile.driverKind,
    capabilities: {
      resume: true,
      interruption: true,
      typedEvents: true,
    },
  });
  const session = await backend.openSession({
    identity: nativeIdentity(profile, runId, normalizedSessionId),
    workingDirectory: WORKSPACE,
  });
  expect(
    transports[0]?.calls.find((call) => call.method === "thread/start")?.params,
  ).toMatchObject({
    model: profile.provider.model,
    approvalPolicy: "never",
  });
  return { backend, session, runId, normalizedSessionId };
}

async function startTurn(
  session: NativeSession,
  transport: FakeCodexTransport,
): Promise<string> {
  const { turnId } = await session.startTurn({
    message: { role: "user", text: "Return the exact requested response." },
  });
  transport.push("turn/started", {
    threadId: transport.threadId,
    turn: { id: turnId, status: "inProgress" },
  });
  return turnId;
}

async function proposeResult(
  profile: LocalNativeProfile,
  transport: FakeCodexTransport,
  turnId: string,
  sourceEventId = `provider-${profile.key}-result`,
) {
  return await transport.invoke({
    id: sourceEventId,
    method: "item/tool/call",
    paperclipTrace: {
      sourceEventId,
      sourceEventType: "semantic_tool.input",
    },
    params: {
      threadId: transport.threadId,
      turnId,
      callId: `finish-${profile.key}`,
      tool: "paperclip_finish",
      arguments: completionResult(profile),
    },
  });
}

function pushFinalAnswer(
  profile: LocalNativeProfile,
  transport: FakeCodexTransport,
  turnId: string,
): string {
  const text = `FINAL-${profile.key}`;
  transport.push("item/completed", {
    threadId: transport.threadId,
    turnId,
    item: {
      id: `answer-${profile.key}`,
      type: "agentMessage",
      phase: "final_answer",
      text,
    },
  });
  return text;
}

function pushTerminal(
  transport: FakeCodexTransport,
  turnId: string,
  status: "completed" | "failed" | "interrupted" | "cancelled",
  error?: Record<string, unknown>,
): void {
  transport.push("turn/completed", {
    threadId: transport.threadId,
    turn: {
      id: turnId,
      status,
      items: [],
      ...(error === undefined ? {} : { error }),
    },
  });
}

async function waitFor(
  predicate: () => boolean,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(failureMessage);
}

function expectValidBoundEvents(
  events: PrpEvent[],
  runId: string,
  normalizedSessionId: string,
): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
  expect(
    events.every(
      (event) =>
        event.runId === runId &&
        event.normalizedSessionId === normalizedSessionId,
    ),
  ).toBe(true);
  expect(events.map((event) => event.sourceSeq)).toEqual(
    [...events.map((event) => event.sourceSeq)].sort(
      (left, right) => left - right,
    ),
  );
  expect(new Set(events.map((event) => event.sourceSeq)).size).toBe(
    events.length,
  );
}

describe.each(RUNNERD_FACADE_PROFILES)(
  "$key runnerd facade fault and recovery boundary",
  (profile) => {
    it("preserves one provider final and one typed successful terminal", async () => {
      const transport = new FakeCodexTransport();
      const { session, runId, normalizedSessionId } = await openSession(
        profile,
        "success",
        [transport],
      );
      try {
        const collecting = collectUntilTerminal(session.events());
        const turnId = await startTurn(session, transport);
        await expect(
          proposeResult(profile, transport, turnId),
        ).resolves.toMatchObject({
          success: true,
        });
        const finalText = pushFinalAnswer(profile, transport, turnId);
        pushTerminal(transport, turnId, "completed");

        const events = await collecting;
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(
          events.filter((event) => event.eventType === "run.result.proposed"),
        ).toHaveLength(1);
        const finalEvents = events.filter(
          (event) =>
            event.eventType === "item.completed" &&
            event.payload.kind === "agentMessage" &&
            event.payload.channel === "final",
        );
        expect(finalEvents).toHaveLength(1);
        expect(finalEvents[0]?.payload).toMatchObject({
          providerPhase: "final_answer",
          text: finalText,
        });
        await expect(session.result()).resolves.toMatchObject({
          result: completionResult(profile),
          terminal: {
            turnTerminalState: "completed",
            runTerminalState: "succeeded",
            reportedWorkDisposition: "done",
          },
          turnId,
        });
        const { snapshot, transcript } = await project(
          profile,
          session,
          events,
        );
        expect(snapshot.turnState).toBe("completed");
        expect(
          transcript.filter(
            (entry) => entry.kind === "item" && entry.role === "assistant",
          ),
        ).toEqual([
          expect.objectContaining({
            item: expect.objectContaining({ text: finalText }),
          }),
        ]);
      } finally {
        await session.close({ reason: "success acceptance complete" });
      }
    });

    it("commits cancellation before provider cleanup and projects it visibly", async () => {
      const transport = new FakeCodexTransport();
      const { session, runId, normalizedSessionId } = await openSession(
        profile,
        "cancel",
        [transport],
      );
      try {
        const collecting = collectUntilTerminal(session.events());
        const turnId = await startTurn(session, transport);
        const cancellation = session.cancel?.({
          reason: "operator_cancelled",
          signal: new AbortController().signal,
        });
        expect(cancellation).toBeDefined();
        // Publication authority must be revoked synchronously, before the
        // passive provider interrupt/cleanup promise gets a chance to run.
        const forbiddenLateText = `LATE-AFTER-CANCEL-${profile.key}`;
        transport.push("item/completed", {
          threadId: transport.threadId,
          turnId,
          item: {
            id: `late-answer-${profile.key}`,
            type: "agentMessage",
            phase: "final_answer",
            text: forbiddenLateText,
          },
        });
        await cancellation!.cleanup;
        pushTerminal(transport, turnId, "cancelled");

        const events = await collecting;
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(
          transport.calls.filter((call) => call.method === "turn/interrupt"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.eventType === "turn.cancelled"),
        ).toHaveLength(1);
        expect(
          events.some((event) => event.eventType === "run.result.proposed"),
        ).toBe(false);
        expect(JSON.stringify(events)).not.toContain(forbiddenLateText);
        await expect(session.snapshot()).resolves.toMatchObject({
          terminal: {
            turnTerminalState: "cancelled",
            runTerminalState: "cancelled",
            reportedWorkDisposition: "yielded",
          },
        });
        const { transcript } = await project(profile, session, events);
        expect(transcript).toContainEqual(
          expect.objectContaining({ kind: "turn", state: "cancelled" }),
        );
      } finally {
        await session.close({ reason: "cancellation acceptance complete" });
      }
    });

    it("makes duplicate semantic and terminal delivery idempotent", async () => {
      const transport = new FakeCodexTransport();
      const { session, runId, normalizedSessionId } = await openSession(
        profile,
        "duplicate",
        [transport],
      );
      try {
        const collecting = collectUntilTerminal(session.events());
        const turnId = await startTurn(session, transport);
        const duplicateResultId = `provider-${profile.key}-duplicate-result`;
        await expect(
          proposeResult(profile, transport, turnId, duplicateResultId),
        ).resolves.toMatchObject({ success: true });
        await expect(
          proposeResult(profile, transport, turnId, duplicateResultId),
        ).resolves.toMatchObject({ success: true });
        const finalText = pushFinalAnswer(profile, transport, turnId);
        const duplicateTerminalId = `provider-${profile.key}-duplicate-terminal`;
        transport.pushTraced(
          "turn/completed",
          {
            threadId: transport.threadId,
            turn: { id: turnId, status: "completed", items: [] },
          },
          duplicateTerminalId,
          "turn.completed",
        );
        transport.pushTraced(
          "turn/completed",
          {
            threadId: transport.threadId,
            turn: { id: turnId, status: "completed", items: [] },
          },
          duplicateTerminalId,
          "turn.completed",
        );

        const events = await collecting;
        await waitFor(
          () =>
            transport.traceInterpretations.filter(
              (entry) => entry.sourceEventId === duplicateTerminalId,
            ).length === 2,
          `${profile.key} did not classify both terminal deliveries`,
        );
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(
          events.filter((event) => event.eventType === "run.result.proposed"),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.eventType === "turn.completed"),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.eventType === "item.completed" &&
              event.payload.kind === "agentMessage" &&
              event.payload.text === finalText,
          ),
        ).toHaveLength(1);
        expect(
          transport.traceInterpretations
            .filter((entry) => entry.sourceEventId === duplicateResultId)
            .map((entry) => entry.disposition),
        ).toEqual(["mapped", "ignored"]);
        expect(
          transport.traceInterpretations
            .filter((entry) => entry.sourceEventId === duplicateTerminalId)
            .map((entry) => entry.disposition),
        ).toEqual(["mapped", "ignored"]);
        await expect(session.result()).resolves.toMatchObject({
          terminal: {
            turnTerminalState: "completed",
            runTerminalState: "succeeded",
          },
        });
      } finally {
        await session.close({ reason: "duplicate acceptance complete" });
      }
    });

    it("recovers the exact active provider session after a transport restart", async () => {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      const { backend, session, runId, normalizedSessionId } =
        await openSession(profile, "restart", [first, second]);
      let recovered: NativeSession | undefined;
      try {
        const turnId = await startTurn(session, first);
        const beforeRestart = await session.snapshot();
        await session.close({ reason: "simulate local runner restart" });

        const recovery = await backend.recoverSession?.(beforeRestart, {
          signal: new AbortController().signal,
        });
        expect(recovery).toMatchObject({ recovered: true });
        recovered = recovery?.session;
        expect(recovered).toBeDefined();
        expect(recovered!.identity()).toEqual(session.identity());
        expect(
          second.calls.find((call) => call.method === "thread/resume")?.params,
        ).toMatchObject({ threadId: beforeRestart.sessionId });
        await expect(recovered!.snapshot()).resolves.toMatchObject({
          sessionId: beforeRestart.sessionId,
          providerSessionId: beforeRestart.providerSessionId,
        });

        const collecting = collectUntilTerminal(recovered!.events());
        await expect(
          proposeResult(profile, second, turnId),
        ).resolves.toMatchObject({
          success: true,
        });
        const finalText = pushFinalAnswer(profile, second, turnId);
        pushTerminal(second, turnId, "completed");

        const events = await collecting;
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(events[0]?.eventType).toBe("session.resumed");
        expect(events[0]?.sourceSeq).toBeGreaterThan(
          Number(beforeRestart.cursor ?? 0),
        );
        expect(
          events.filter(
            (event) =>
              event.eventType === "item.completed" &&
              event.payload.kind === "agentMessage" &&
              event.payload.text === finalText,
          ),
        ).toHaveLength(1);
        await expect(recovered!.result()).resolves.toMatchObject({
          result: completionResult(profile),
          terminal: {
            turnTerminalState: "completed",
            runTerminalState: "succeeded",
          },
          turnId,
        });
      } finally {
        await recovered?.close({ reason: "restart acceptance complete" });
        await session.close({ reason: "restart acceptance cleanup" });
      }
    });

    it("fails a malformed bound provider event closed with a visible diagnostic", async () => {
      const transport = new FakeCodexTransport();
      const { session, runId, normalizedSessionId } = await openSession(
        profile,
        "malformed",
        [transport],
      );
      try {
        const collecting = collectUntilTerminal(session.events());
        const turnId = await startTurn(session, transport);
        const malformedSourceId = `provider-${profile.key}-malformed`;
        transport.pushTraced(
          "item/completed",
          {
            threadId: "wrong-provider-thread",
            turnId,
            item: {
              id: "malformed-item",
              type: "agentMessage",
              phase: "final_answer",
              text: "must not become visible",
            },
          },
          malformedSourceId,
          "item.completed",
        );

        const events = await collecting;
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(
          events.find((event) => event.eventType === "session.failed")?.payload,
        ).toMatchObject({
          code: "thread_binding_mismatch",
          recoverable: false,
        });
        expect(
          events.filter((event) => event.eventType === "turn.failed"),
        ).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain("must not become visible");
        const malformedInterpretation = transport.traceInterpretations.find(
          (entry) => entry.sourceEventId === malformedSourceId,
        );
        expect(malformedInterpretation).toMatchObject({
          sourceEventType: "item.completed",
          disposition: "mapped",
        });
        expect(malformedInterpretation?.emittedEventIds.length).toBeGreaterThan(
          0,
        );
        await expect(session.snapshot()).resolves.toMatchObject({
          terminal: {
            turnTerminalState: "failed",
            runTerminalState: "failed",
            reportedWorkDisposition: "yielded",
          },
        });
        const { snapshot, transcript } = await project(
          profile,
          session,
          events,
        );
        expect(snapshot.sessionState).toBe("failed");
        expect(transcript).toContainEqual(
          expect.objectContaining({ kind: "turn", state: "failed" }),
        );
      } finally {
        await session.close({ reason: "malformed acceptance complete" });
      }
    });

    it("turns provider transport failure into a redacted visible terminal", async () => {
      const transport = new FakeCodexTransport();
      const { session, runId, normalizedSessionId } = await openSession(
        profile,
        "provider-failure",
        [transport],
      );
      try {
        const collecting = collectUntilTerminal(session.events());
        await startTurn(session, transport);
        transport.queue.fail(
          new Error(`provider ${profile.key} failed token=provider-secret`),
        );

        const events = await collecting;
        expectValidBoundEvents(events, runId, normalizedSessionId);
        expect(JSON.stringify(events)).not.toContain("provider-secret");
        expect(JSON.stringify(events)).toContain("token=[REDACTED]");
        expect(
          events.find(
            (event) =>
              event.eventType === "harness.diagnostic" &&
              event.payload.code === "notification_transport_failed",
          )?.payload,
        ).toMatchObject({
          message: expect.stringContaining("token=[REDACTED]"),
        });
        expect(
          events.filter((event) => event.eventType === "turn.failed"),
        ).toHaveLength(1);
        await expect(session.snapshot()).resolves.toMatchObject({
          terminal: {
            turnTerminalState: "failed",
            runTerminalState: "failed",
            reportedWorkDisposition: "yielded",
          },
        });
        const { transcript } = await project(profile, session, events);
        expect(transcript).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "diagnostic",
              code: "notification_transport_failed",
              message: expect.stringContaining("token=[REDACTED]"),
            }),
            expect.objectContaining({ kind: "turn", state: "failed" }),
          ]),
        );
      } finally {
        await session.close({ reason: "provider failure acceptance complete" });
      }
    });
  },
);
