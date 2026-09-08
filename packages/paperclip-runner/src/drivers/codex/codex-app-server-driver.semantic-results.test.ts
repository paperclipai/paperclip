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
import { RUNNERD_CANONICAL_ITEM } from "./codex-driver-values.js";

describe("Codex app-server Codex driver", () => {
  it("makes duplicate semantic completion idempotent and rejects changed payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-result",
      normalizedSessionId: "normalized-result",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const request = {
      id: 1,
      method: "item/tool/call",
      paperclipTrace: {
        sourceEventId: "event_runner_000101",
        sourceEventType: "semantic_tool.input",
      },
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "paperclip_finish",
        arguments: result,
      },
    };
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    const resultMapping = transport.traceInterpretations.find(
      (entry) =>
        entry.sourceEventId === "event_runner_000101" &&
        entry.providerMethod === "item/tool/call",
    );
    expect(resultMapping).toMatchObject({
      sourceEventType: "semantic_tool.input",
      disposition: "mapped",
    });
    expect(resultMapping?.emittedEventIds).toHaveLength(2);
    expect(resultMapping?.emittedEventIds).toEqual(
      expect.arrayContaining([expect.stringContaining(":run-result:")]),
    );
    expect(
      await transport.invoke({
        ...request,
        id: 2,
        params: {
          ...request.params,
          callId: "call-2",
          arguments: reverseObjectKeys(result),
        },
      }),
    ).toMatchObject({ success: true });
    expect((await session.snapshot()).semanticResult?.callId).toBe("call-1");
    const changed = structuredClone(result);
    changed.summary = "Changed after commit.";
    expect(
      await transport.invoke({
        ...request,
        id: 3,
        params: { ...request.params, arguments: changed },
      }),
    ).toMatchObject({ success: false });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
  });

  it("accepts a normalized runnerd echo of a tool-committed semantic result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-result-normalized-echo",
      normalizedSessionId: "normalized-result-normalized-echo",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const toolShaped = structuredClone(result) as unknown as Record<
      string,
      unknown
    >;
    toolShaped.verification = [
      {
        commandOrCheck: "read hello.txt",
        status: "passed",
        result: "hello",
      },
    ];
    delete toolShaped.attentionRequests;
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: toolShaped,
        },
      }),
    ).toMatchObject({ success: true });
    transport.push("paperclip/runResult", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-result",
      result: {
        ...result,
        verification: [
          {
            commandOrCheck: "read hello.txt",
            status: "passed",
            detail: "hello",
          },
        ],
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
  });

  it("advertises and dispatches run-authorized control-plane tools", async () => {
    const transport = new FakeCodexTransport();
    const handler = vi.fn(async (call) => ({
      task: { id: "issue-1" },
      callId: call.callId,
    }));
    const session = await makeDriver([transport], {
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the assigned task.",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      dynamicToolHandler: handler,
    }).openSession({
      runId: "run-tools",
      normalizedSessionId: "normalized-tools",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({
      message: { role: "user", text: "Inspect the task." },
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params
        .dynamicTools,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_task_context" }),
      ]),
    );
    const response = await transport.invoke({
      id: "rpc-tool",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-context",
        tool: "get_task_context",
        arguments: {},
      },
    });
    expect(response).toMatchObject({ success: true });
    expect(
      JSON.parse(
        String(
          (response.contentItems as Array<Record<string, unknown>>)[0]?.text,
        ),
      ),
    ).toEqual({ task: { id: "issue-1" }, callId: "call-context" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "get_task_context",
        callId: "call-context",
        arguments: {},
      }),
    );
  });

  it("fails closed when an agent message changes a tool-committed result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-tool-then-message-conflict",
      normalizedSessionId: "normalized-tool-then-message-conflict",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting agent-message result.";
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(changed),
      },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({
      code: "conflicting_semantic_result",
      recoverable: false,
    });
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it("does not infer another result from runnerd's canonical activity item", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-runnerd-authoritative-result",
      normalizedSessionId: "normalized-runnerd-authoritative-result",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Schema-shaped post-tool assistant activity.";
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        [RUNNERD_CANONICAL_ITEM]: true,
        id: "runnerd-message-result",
        type: "agentMessage",
        text: JSON.stringify(changed),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
    expect(
      events.find(
        (event) =>
          event.eventType === "item.completed" &&
          event.itemId === "runnerd-message-result",
      )?.payload,
    ).toMatchObject({ text: JSON.stringify(changed) });
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it("rejects a tool result that changes an agent-message commitment", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-message-then-tool-conflict",
      normalizedSessionId: "normalized-message-then-tool-conflict",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const changed = structuredClone(result);
    changed.summary = "Conflicting tool result.";
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: changed,
        },
      }),
    ).toMatchObject({ success: false });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
    expect((await session.snapshot()).semanticResult).toMatchObject({
      callId: "message-result",
      result,
    });
  });

  it("treats a canonically identical cross-channel result as a no-op", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-identical-cross-channel",
      normalizedSessionId: "normalized-identical-cross-channel",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(reverseObjectKeys(result)),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect((await session.snapshot()).semanticResult?.callId).toBe(
      "tool-result",
    );
  });

  it("fails closed when a live terminal embeds a changed semantic result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-result-conflict",
      normalizedSessionId: "normalized-terminal-result-conflict",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting terminal result.";
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          {
            id: "terminal-result",
            type: "agentMessage",
            text: JSON.stringify(changed),
          },
        ],
      },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({
      code: "conflicting_semantic_result",
      recoverable: false,
    });
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(
      false,
    );
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it.each([
    { threadId: "other-thread", turnId: "turn-1", label: "another thread" },
    { threadId: "thread-1", turnId: "other-turn", label: "another turn" },
  ])(
    "rejects a semantic result for $label without committing it",
    async ({ threadId, turnId }) => {
      const transport = new FakeCodexTransport();
      const session = await makeDriver([transport]).openSession({
        runId: "run-hostile-tool",
        normalizedSessionId: "normalized-hostile-tool",
        workingDirectory: WORKSPACE,
      });
      await session.startTurn({ message: { role: "user", text: "Complete." } });
      expect(
        await transport.invoke({
          id: "hostile-call",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "hostile-call",
            tool: "paperclip_finish",
            arguments: result,
          },
        }),
      ).toMatchObject({ success: false });
      const events = await collectUntilTerminal(session.events());
      expect(
        events.some((event) => event.eventType === "run.result.proposed"),
      ).toBe(false);
      expect(
        events.find((event) => event.eventType === "session.failed")?.payload,
      ).toMatchObject({ code: "tool_binding_mismatch", recoverable: false });
      expect(
        events.find((event) => event.eventType === "turn.failed")?.turnId,
      ).toBe("turn-1");
    },
  );

  it("rejects pre-turn, cross-thread, and post-terminal notifications", async () => {
    const preTurnTransport = new FakeCodexTransport();
    const preTurn = await makeDriver([preTurnTransport]).openSession({
      runId: "run-pre-turn",
      normalizedSessionId: "normalized-pre-turn",
      workingDirectory: WORKSPACE,
    });
    preTurnTransport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-pre",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    const preTurnEvents: PrpEvent[] = [];
    for await (const event of preTurn.events()) preTurnEvents.push(event);
    expect(
      preTurnEvents.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
    expect(
      preTurnEvents.find((event) => event.eventType === "session.failed")
        ?.payload,
    ).toMatchObject({ code: "turn_binding_mismatch" });

    const crossThreadTransport = new FakeCodexTransport();
    const crossThread = await makeDriver([crossThreadTransport]).openSession({
      runId: "run-cross-thread",
      normalizedSessionId: "normalized-cross-thread",
      workingDirectory: WORKSPACE,
    });
    await crossThread.startTurn({
      message: { role: "user", text: "Complete." },
    });
    crossThreadTransport.push("item/completed", {
      threadId: "other-thread",
      turnId: "turn-1",
      item: {
        id: "answer-other",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    const crossThreadEvents = await collectUntilTerminal(crossThread.events());
    expect(
      crossThreadEvents.some(
        (event) => event.eventType === "run.result.proposed",
      ),
    ).toBe(false);
    expect(
      crossThreadEvents.find((event) => event.eventType === "session.failed")
        ?.payload,
    ).toMatchObject({ code: "thread_binding_mismatch" });

    const postTerminalTransport = new FakeCodexTransport();
    const postTerminal = await makeDriver([postTerminalTransport]).openSession({
      runId: "run-post-terminal",
      normalizedSessionId: "normalized-post-terminal",
      workingDirectory: WORKSPACE,
    });
    await postTerminal.startTurn({
      message: { role: "user", text: "Complete." },
    });
    postTerminalTransport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(postTerminal.events());
    expect(
      await postTerminalTransport.invoke({
        id: "late-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "late-call",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects duplicate and conflicting terminal facts", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-replay",
      normalizedSessionId: "normalized-terminal-replay",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "changed" },
        items: [],
      },
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.failed"),
    ).toHaveLength(0);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({ code: "conflicting_turn_terminal", recoverable: false });
  });

  it("rejects oversized semantic results without retaining provider payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-large-result",
      normalizedSessionId: "normalized-large-result",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await transport.invoke({
        id: "large-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "large-call",
          tool: "paperclip_finish",
          arguments: { ...result, summary: "x".repeat(70 * 1024) },
        },
      }),
    ).toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Semantic result exceeded the retained payload limit.",
        },
      ],
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.some((event) => JSON.stringify(event).includes("x".repeat(1024))),
    ).toBe(false);
    expect(
      events.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
  });

  it("normalizes finish and block tools into one canonical result contract", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-tools",
      normalizedSessionId: "normalized-tools",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({
      message: { role: "user", text: "Complete or block." },
    });
    const blocked: PrpStructuredRunResult = {
      ...structuredClone(result),
      reportedWorkDisposition: "blocked",
      summary: "Waiting on a fixture owner.",
      completionClaim: {
        ...structuredClone(result.completionClaim),
        objectiveSatisfied: false,
        criteria: [
          { criterionId: "file", status: "not_satisfied", evidenceRefs: [] },
        ],
        remainingWork: [
          {
            description: "Fixture owner must provide input.",
            blocksCompletion: true,
          },
        ],
      },
      blocker: {
        reasonCode: "fixture_input_missing",
        owner: { kind: "external", name: "fixture owner" },
        unblockAction: "Provide the fixture input.",
        scope: "task_wide",
      },
      artifacts: [],
    };
    const request = {
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-block",
        tool: "paperclip_block",
        arguments: blocked,
      },
    };
    expect(
      await transport.invoke({
        ...request,
        id: 9,
        params: { ...request.params, tool: "paperclip_finish" },
      }),
    ).toMatchObject({ success: false });
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    expect(await transport.invoke({ ...request, id: 11 })).toMatchObject({
      success: true,
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "run.result.proposed")
        ?.payload,
    ).toMatchObject({ reportedWorkDisposition: "blocked" });
  });
});
