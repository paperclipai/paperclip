import {
  CODEX_BLOCK_RESULT_OUTPUT_SCHEMA,
  CODEX_INVALID_REQUEST,
  CODEX_METHOD_NOT_FOUND,
  CODEX_RESULT_OUTPUT_SCHEMA,
  CodexAppServerDriver,
  CodexRpcError,
  FakeCodexTransport,
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  WORKSPACE,
  applyPrpEvent,
  collectUntilTerminal,
  createCodexTaskEnvelope,
  createIsolatedCodexAppServerArgs,
  createSessionSnapshotFromMetadata,
  describe,
  envelope,
  expect,
  isSkilllessCodexContext,
  it,
  liveConsoleFixturePath,
  loadLiveConsoleConformanceFixture,
  makeDriver,
  replayPersistedCodexEvents,
  result,
  reverseObjectKeys,
  runCodexCodexTracer,
  traceCompletedProposal,
  validateCodexResultProposal,
  validatePrpEvent,
  vi,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
  type CodexServerRequestHandler,
  type CodexTraceInterpretation,
  type HarnessRuntimeRequestResolution,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "./codex-app-server-driver.test-support.js";
import { runnerdRuntimeRequestExpiryNotification } from "../../live/runnerd-codex-transport.js";

it("preserves runnerd permission expiry before a failed provider terminal and refuses late approval", async () => {
  const transport = new FakeCodexTransport();
  const resolve = vi.fn(async () => {});
  transport.runtimeRequestResolver = resolve;
  const session = await makeDriver([transport]).openSession({
    runId: "run-native-expiry", normalizedSessionId: "session-native-expiry", workingDirectory: WORKSPACE,
  });
  const events: PrpEvent[] = [];
  const consume = (async () => { for await (const event of session.events()) events.push(event); })();
  const { turnId } = await session.startTurn({ message: { role: "user", text: "Leave the native edit unanswered." } });
  const pending = transport.invoke({ id: "native-edit-permission", method: "session/request_permission", params: {
    threadId: "thread-1", turnId, itemId: "native-edit", reason: "Write file",
    choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }],
    origin: { adapter: "acpx-runtime-sidecar", provider: "acpx", method: "session/request_permission" },
  } });
  await vi.waitFor(() => expect(session.pendingRuntimeRequests?.()).toHaveLength(1));
  // Rust's projector supplies durable identities; the facade binds its active provider turn.
  const payload = { provider: "acpx", requestId: "native-edit-permission", requestKind: "permission_approval",
    requestType: "permission", turnId: "durable-controller-turn", itemId: "durable-item",
    reason: "provider_process_lost", replayAllowed: false, adapter: "acpx-runtime-sidecar" };
  for (const kind of ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.created"])
    expect(runnerdRuntimeRequestExpiryNotification(kind, payload, "thread-1", turnId)).toBeNull();
  const expiry = runnerdRuntimeRequestExpiryNotification("runtime_request.expired", payload, "thread-1", turnId)!;
  transport.push(expiry.method, expiry.params);
  transport.push(expiry.method, expiry.params);
  await pending;
  expect(session.pendingRuntimeRequests?.()).toEqual([]);
  await expect(session.resolveRuntimeRequest?.({ requestId: "native-edit-permission", turnId, resolution: { action: "accept" } }))
    .rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  transport.push("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST", message: "Provider died" } } });
  await vi.waitFor(() => expect(events.some(event => event.eventType === "turn.failed")).toBe(true));
  await session.close(); await consume;
  const settlements = events.filter(event => ["runtime_request.expired", "runtime_request.cancelled", "runtime_request.resolved"].includes(event.eventType));
  expect(settlements).toHaveLength(1);
  expect(settlements[0]).toMatchObject({ eventType: "runtime_request.expired", turnId, itemId: "native-edit", payload: { ...payload, turnId, itemId: "native-edit" } });
  expect(events.indexOf(settlements[0]!)).toBeLessThan(events.findIndex(event => event.eventType === "turn.failed"));
  expect(validatePrpEvent(settlements[0]!)).toMatchObject({ ok: true });
});

it("preserves canonical question expiry after provider loss and refuses late answers", async () => {
  const transport = new FakeCodexTransport();
  const session = await makeDriver([transport]).openSession({ runId: "question-expiry", normalizedSessionId: "question-expiry", workingDirectory: WORKSPACE });
  const events: PrpEvent[] = [];
  const consume = (async () => { for await (const event of session.events()) events.push(event); })();
  const { turnId } = await session.startTurn({ message: { role: "user", text: "Ask before changing files." } });
  const pending = transport.invoke({ id: "native-question", method: "item/tool/requestUserInput", params: {
    threadId: "thread-1", turnId, itemId: "question-item", questions: [{ id: "environment", header: "Environment", question: "Where should we deploy?", options: [{ label: "Staging" }, { label: "Production" }] }],
  } });
  await vi.waitFor(() => expect(session.pendingRuntimeRequests?.()).toHaveLength(1));
  const request = session.pendingRuntimeRequests!()[0]!;
  expect(request.requestKind).toBe("user_input");
  const payload = { requestId: "native-question", requestKind: "runtime", requestType: "input", replayAllowed: false, reason: "provider_process_lost" };
  const expiry = runnerdRuntimeRequestExpiryNotification("runtime_request.expired", payload, "thread-1", turnId)!;
  transport.push(expiry.method, expiry.params);
  transport.push(expiry.method, expiry.params);
  await pending;
  expect(session.pendingRuntimeRequests?.()).toEqual([]);
  await expect(session.resolveRuntimeRequest?.({ requestId: "native-question", turnId, resolution: { action: "accept" } })).rejects.toThrow();
  transport.push("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST", message: "Provider died" } } });
  await vi.waitFor(() => expect(events.some(event => event.eventType === "turn.failed" || event.eventType === "session.failed")).toBe(true));
  await session.close(); await consume;
  expect(events.filter(event => event.eventType === "runtime_request.expired")).toHaveLength(1);
  expect(events.find(event => event.eventType === "runtime_request.expired")).toMatchObject({ turnId, itemId: "question-item", payload });
  expect(events.some(event => event.eventType === "session.failed" && event.payload.code === "turn_binding_mismatch")).toBe(false);
  expect(events.some(event => event.eventType === "runtime_request.cancelled" || event.eventType === "runtime_request.resolved")).toBe(false);
});

it.each(["turn", "kind", "type", "replay"])("refuses canonical permission expiry with a changed %s binding", async kind => {
  const transport = new FakeCodexTransport();
  const session = await makeDriver([transport]).openSession({ runId: "expiry-bound", normalizedSessionId: "expiry-bound", workingDirectory: WORKSPACE });
  const events: PrpEvent[] = [];
  const consume = (async () => { for await (const event of session.events()) events.push(event); })();
  const { turnId } = await session.startTurn({ message: { role: "user", text: "Wait for permission" } });
  const pending = transport.invoke({ id: "bound-permission", method: "session/request_permission", params: {
    threadId: "thread-1", turnId, itemId: "edit", reason: "Edit", choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }],
    origin: { adapter: "acpx-runtime-sidecar", provider: "acpx", method: "session/request_permission" },
  } });
  await vi.waitFor(() => expect(session.pendingRuntimeRequests?.()).toHaveLength(1));
  const payload = { requestId: "bound-permission", requestKind: kind === "kind" ? "runtime" : "permission_approval",
    requestType: kind === "type" ? "input" : "permission", replayAllowed: kind === "replay", reason: "provider_process_lost" };
  const notification = runnerdRuntimeRequestExpiryNotification("runtime_request.expired", payload, "thread-1", kind === "turn" ? "foreign-turn" : turnId)!;
  transport.push(notification.method, notification.params);
  await pending; await consume; await session.close();
  expect(events.some(e => e.eventType === "runtime_request.expired")).toBe(false);
  expect(events.some(e => e.eventType === "session.failed" && e.payload.code === "turn_binding_mismatch")).toBe(true);
});

describe("Codex app-server Codex driver", () => {
  it("keeps a prompted MCP tool answerable after rejecting a session-wide decision", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-mcp-retry",
      normalizedSessionId: "normalized-mcp-retry",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Inspect the desktop." } });
    const response = transport.invoke({
      id: "desktop-approval", method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId, itemId: "desktop-item", serverName: "assigned",
        mode: "form", message: "Allow the tool?", _meta: { codex_approval_kind: "mcp_tool_call" },
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(session.resolveRuntimeRequest?.({
      requestId: "desktop-approval", turnId, resolution: { action: "accept_for_session" },
    })).rejects.toThrow(/one-time/);
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    await session.resolveRuntimeRequest?.({
      requestId: "desktop-approval", turnId, resolution: { action: "accept" },
    });
    expect(await response).toEqual({ action: "accept", content: null, _meta: null });
    expect(session.pendingRuntimeRequests?.()).toHaveLength(0);
    await session.close();
  });

  it("validates runtime request resolutions against the kind of request they answer", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-resolution-shapes",
      normalizedSessionId: "normalized-resolution-shapes",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask me things." },
    });

    // Not `async`: an async function would flatten and await the pending
    // provider response, which only settles once the request is resolved.
    function open(
      id: string,
      method: string,
    ): Promise<Record<string, unknown>> {
      return transport.invoke({
        id,
        method,
        params: {
          threadId: "thread-1",
          turnId,
          itemId: `item-${id}`,
          reason: `fixture ${id}`,
        },
      });
    }
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

    const userInput = open("ask-input", "item/tool/requestUserInput");
    await settled();
    for (const resolution of [
      { action: "submit" },
      { action: "submit", answers: {} },
      { action: "submit", answers: { field: {} } },
      { action: "submit", answers: { field: { answers: [7] } } },
      { action: "submit", content: { answer: "wrong shape" } },
      { action: "accept" },
    ]) {
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: "ask-input",
          turnId,
          resolution: resolution as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow(/user_input rejected its resolution/);
      // A rejected resolution must leave the request answerable.
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    }
    await session.resolveRuntimeRequest?.({
      requestId: "ask-input",
      turnId,
      resolution: {
        action: "submit",
        answers: { field: { answers: ["staging"] } },
      },
    });
    expect(await userInput).toEqual({
      answers: { field: { answers: ["staging"] } },
    });

    const elicitation = open(
      "ask-elicitation",
      "mcpServer/elicitation/request",
    );
    await settled();
    for (const resolution of [
      { action: "submit" },
      { action: "submit", content: {} },
      { action: "submit", answers: { field: { answers: ["wrong shape"] } } },
      { action: "accept_for_session" },
    ]) {
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: "ask-elicitation",
          turnId,
          resolution: resolution as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow(/elicitation rejected its resolution/);
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    }
    await session.resolveRuntimeRequest?.({
      requestId: "ask-elicitation",
      turnId,
      resolution: { action: "submit", content: { answer: "green" } },
    });
    expect(await elicitation).toEqual({
      action: "accept",
      content: { answer: "green" },
      _meta: null,
    });

    const approval = open(
      "ask-approval",
      "item/commandExecution/requestApproval",
    );
    await settled();
    await expect(
      session.resolveRuntimeRequest?.({
        requestId: "ask-approval",
        turnId,
        resolution: {
          action: "submit",
          answers: { field: { answers: ["nope"] } },
        } as unknown as HarnessRuntimeRequestResolution,
      }),
    ).rejects.toThrow(/command_approval rejected its resolution/);
    await session.resolveRuntimeRequest?.({
      requestId: "ask-approval",
      turnId,
      resolution: { action: "accept" },
    });
    expect(await approval).toEqual({ decision: "accept" });
    await session.close({ reason: "fixture complete" });
  });

  it("replays the DOT-185 requestUserInput shape as one canonical three-question request", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-dot-185",
      normalizedSessionId: "normalized-dot-185",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask the deployment questions." },
    });
    const resolvedEvent = (async () => {
      for await (const event of session.events()) {
        if (event.eventType === "runtime_request.resolved"
          && event.payload.requestId === "dot-185-request") return event;
      }
      return null;
    })();
    const nativeResponse = transport.invoke({
      id: "dot-185-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "dot-185-item",
        questions: [
          {
            id: "environment",
            header: "Environment",
            question: "Where should we deploy?",
            options: [
              { label: "Staging", description: "Deploy to staging first." },
              { label: "Production", description: "Deploy directly to production." },
            ],
            isOther: true,
          },
          {
            id: "regions",
            header: "Regions",
            question: "Which regions should receive the release?",
            options: [{ label: "US" }, { label: "EU" }],
            multiSelect: true,
          },
          {
            id: "notes",
            header: "Notes",
            question: "Anything else we should know?",
            required: false,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [pending] = session.pendingRuntimeRequests?.() ?? [];
    expect(pending?.input).toMatchObject({
      schema: "paperclip.question_set.v1",
      questions: [
        {
          id: "environment",
          required: false,
          answerMode: "single_select",
          customAnswer: { enabled: true },
          options: [
            { id: "option-1", label: "Staging", description: "Deploy to staging first." },
            { id: "option-2", label: "Production", description: "Deploy directly to production." },
          ],
        },
        { id: "regions", answerMode: "multi_select", required: false },
        { id: "notes", answerMode: "text", required: false },
      ],
    });
    await session.resolveRuntimeRequest?.({
      requestId: "dot-185-request",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            environment: { selectedOptionIds: ["option-1"] },
            regions: { selectedOptionIds: ["option-1", "option-2"] },
            notes: { text: "Ship during the maintenance window." },
          },
        },
      },
    });
    expect(await nativeResponse).toEqual({
      answers: {
        environment: { answers: ["Staging"] },
        regions: { answers: ["US", "EU"] },
        notes: { answers: ["Ship during the maintenance window."] },
      },
    });
    expect((await resolvedEvent)?.payload).toMatchObject({
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { selectedOptionIds: ["option-1"] },
          regions: { selectedOptionIds: ["option-1", "option-2"] },
          notes: { text: "Ship during the maintenance window." },
        },
      },
    });
    await session.close({ reason: "fixture complete" });
  });

  it("keeps redacted native option values through the cloned pending-request lifecycle", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-private-option",
      normalizedSessionId: "normalized-private-option",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Choose the configured credential." },
    });
    const nativeResponse = transport.invoke({
      id: "private-option-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "private-option-item",
        questions: [{
          id: "credential",
          question: "Choose the configured credential.",
          options: [{ id: "configured", label: "token=native-option-secret" }],
        }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [publicRequest] = structuredClone(session.pendingRuntimeRequests?.() ?? []);
    expect(JSON.stringify(publicRequest)).not.toContain("native-option-secret");
    expect(publicRequest?.input?.questions[0]?.options?.[0]?.label).toContain("[REDACTED]");

    await session.resolveRuntimeRequest?.({
      requestId: "private-option-request",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { credential: { selectedOptionIds: ["configured"] } },
        },
      },
    });
    expect(await nativeResponse).toEqual({
      answers: { credential: { answers: ["token=native-option-secret"] } },
    });
    await session.close({ reason: "fixture complete" });
  });

  it("rejects an explicit malformed Codex form without falling back to v1", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-malformed-input",
      normalizedSessionId: "normalized-malformed-input",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask a malformed question." },
    });
    const diagnostic = (async () => {
      for await (const event of session.events()) {
        if (event.eventType === "harness.diagnostic" && event.payload.code === "runtime_input_rejected") {
          return event;
        }
      }
      return null;
    })();
    await expect(transport.invoke({
      id: "malformed-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "malformed-item",
        questions: [
          { id: "duplicate", question: "First?" },
          { id: "duplicate", question: "Second?" },
        ],
      },
    })).resolves.toEqual({ answers: {} });
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    expect(await diagnostic).toEqual(expect.objectContaining({
      eventType: "harness.diagnostic",
      payload: expect.objectContaining({
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
      }),
    }));
    await session.close({ reason: "fixture complete" });
  });

  it("emits one canonical outcome payload for every terminal runtime request fact", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-outcome",
      normalizedSessionId: "normalized-outcome",
      workingDirectory: WORKSPACE,
    });
    const events: PrpEvent[] = [];
    void (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Approve this." },
    });
    const resolved = transport.invoke({
      id: "outcome-resolved",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "item-resolved",
        reason: "approve",
      },
    });
    const cancelled = transport.invoke({
      id: "outcome-cancelled",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "item-cancelled",
        reason: "approve",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.resolveRuntimeRequest?.({
      requestId: "outcome-resolved",
      turnId,
      resolution: { action: "accept_for_session" },
    });
    await resolved;
    await session.close({ reason: "operator_closed" });
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const terminal = events.filter(
      ({ eventType }) =>
        eventType === "runtime_request.resolved" ||
        eventType === "runtime_request.cancelled",
    );
    expect(
      terminal.map(({ eventType, turnId, itemId, payload }) => ({
        eventType,
        turnId,
        itemId,
        payload,
      })),
    ).toEqual([
      {
        eventType: "runtime_request.resolved",
        turnId,
        itemId: "item-resolved",
        payload: {
          requestId: "outcome-resolved",
          requestKind: "command_approval",
          turnId,
          itemId: "item-resolved",
          action: "accept_for_session",
        },
      },
      {
        eventType: "runtime_request.cancelled",
        turnId,
        itemId: "item-cancelled",
        payload: {
          requestId: "outcome-cancelled",
          requestKind: "command_approval",
          turnId,
          itemId: "item-cancelled",
          reason: "session_closed",
        },
      },
    ]);
    for (const event of terminal) expect(validatePrpEvent(event).ok).toBe(true);
  });

  it("expires a canonical input with its full question set when the provider transport is lost", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-provider-loss",
      normalizedSessionId: "normalized-provider-loss",
      workingDirectory: WORKSPACE,
    });
    const events: PrpEvent[] = [];
    const consume = (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const pending = transport.invoke({
      id: "lost-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "lost-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.queue.fail(new Error("provider exited"));
    expect(await pending).toEqual({ answers: {} });
    await consume;

    const expired = events.find((event) => event.eventType === "runtime_request.expired");
    expect(expired).toMatchObject({
      turnId,
      itemId: "lost-input-item",
      payload: {
        requestId: "lost-input",
        reason: "provider_process_lost",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "lost-input",
          type: "input",
          input: {
            schema: "paperclip.question_set.v1",
            questions: [expect.objectContaining({ id: "environment" })],
          },
        },
      },
    });
    expect(events.filter((event) => event.eventType === "runtime_request.cancelled")).toHaveLength(0);
    expect(validatePrpEvent(expired!)).toMatchObject({ ok: true });
  });

  it("hands a live canonical input off exactly once when the durable window expires", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-durable-handoff",
      normalizedSessionId: "normalized-durable-handoff",
      workingDirectory: WORKSPACE,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const pending = transport.invoke({
      id: "handoff-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "handoff-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    let created: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.created") {
        created = event.value;
        break;
      }
    }
    expect(created).not.toBeNull();

    const firstHandoff = session.handoffRuntimeRequest!({
      requestId: "handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(firstHandoff.result).toBe("handed_off");
    await expect(firstHandoff.cleanup).resolves.toBeUndefined();
    const repeatedHandoff = session.handoffRuntimeRequest!({
      requestId: "handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(repeatedHandoff.result).toBe("already_settled");
    await expect(repeatedHandoff.cleanup).resolves.toBeUndefined();
    expect(await pending).toEqual({ answers: {} });

    let expired: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (event.value.eventType === "runtime_request.expired") {
        expired = event.value;
        break;
      }
    }
    expect(expired).toMatchObject({
      turnId,
      itemId: "handoff-input-item",
      payload: {
        requestId: "handoff-input",
        reason: "durable_handoff",
        replayAllowed: false,
        requestType: "input",
        request: {
          schema: "paperclip.runtime_request.v2",
          requestId: "handoff-input",
          type: "input",
        },
      },
    });
    await session.close({ reason: "test complete" });
  });

  it("does not commit a durable handoff after runtime ownership is revoked", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-aborted-handoff",
      normalizedSessionId: "normalized-aborted-handoff",
      workingDirectory: WORKSPACE,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const pending = transport.invoke({
      id: "aborted-handoff-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "aborted-handoff-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done || event.value.eventType === "runtime_request.created") break;
    }

    const ownership = new AbortController();
    ownership.abort();
    const abortedHandoff = session.handoffRuntimeRequest!({
      requestId: "aborted-handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: ownership.signal,
    });
    expect(abortedHandoff.result).toBe("already_settled");
    await expect(abortedHandoff.cleanup).resolves.toBeUndefined();
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    expect(transport.calls).not.toContainEqual(expect.objectContaining({
      method: "turn/interrupt",
    }));

    const liveHandoff = session.handoffRuntimeRequest!({
      requestId: "aborted-handoff-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(liveHandoff.result).toBe("handed_off");
    await expect(liveHandoff.cleanup).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ answers: {} });
    await session.close({ reason: "test complete" });
  });

  it("lets an answer claimed before expiry win the terminal-event race", async () => {
    const transport = new FakeCodexTransport();
    let releaseResolution!: () => void;
    transport.runtimeRequestResolver = () => new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const session = await makeDriver([transport]).openSession({
      runId: "run-answer-handoff-race",
      normalizedSessionId: "normalized-answer-handoff-race",
      workingDirectory: WORKSPACE,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask before continuing." },
    });
    const providerRequest = transport.invoke({
      id: "race-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "race-input-item",
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Where should we deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
        }],
      },
    });
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done || event.value.eventType === "runtime_request.created") break;
    }
    const resolution = session.resolveRuntimeRequest!({
      requestId: "race-input",
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { environment: { selectedOptionIds: ["option-1"] } },
        },
      },
    });
    await Promise.resolve();
    const handoff = session.handoffRuntimeRequest!({
      requestId: "race-input",
      turnId,
      reason: "durable_handoff",
      signal: new AbortController().signal,
    });
    expect(handoff.result).toBe("already_settled");
    await expect(handoff.cleanup).resolves.toBeUndefined();
    releaseResolution();
    await resolution;
    await providerRequest;

    let terminalEvent: PrpEvent | null = null;
    for (let count = 0; count < 20; count += 1) {
      const event = await iterator.next();
      if (event.done) break;
      if (
        event.value.payload.requestId === "race-input"
        && ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.value.eventType)
      ) {
        terminalEvent = event.value;
        break;
      }
    }
    expect(terminalEvent?.eventType).toBe("runtime_request.resolved");
    expect(session.pendingRuntimeRequests?.()).toEqual([]);
    await session.close({ reason: "test complete" });
  });

  it("redacts browser-visible request details and diagnostics from the fixture markers", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-redaction",
      normalizedSessionId: "normalized-redaction",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Request input." },
    });
    const pending = transport.invoke({
      id: "redacted-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId,
        itemId: "redacted-item",
        reason: fixture.redactionMarkers.join(" "),
        authorization: "Bearer browser-secret",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const serialized = JSON.stringify(session.pendingRuntimeRequests?.());
    for (const marker of fixture.redactionMarkers)
      expect(serialized).not.toContain(marker);
    expect(serialized).toContain("[REDACTED]");
    await session.resolveRuntimeRequest?.({
      requestId: "redacted-request",
      turnId,
      resolution: { action: "cancel" },
    });
    await pending;
    await session.close({ reason: "fixture complete" });
  });

});
