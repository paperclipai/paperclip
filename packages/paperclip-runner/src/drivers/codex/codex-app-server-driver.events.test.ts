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

describe("Codex app-server Codex driver", () => {
  it("admits a strictly bound semantic result from the durable runner", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-durable-result",
      normalizedSessionId: "normalized-durable-result",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Finish through runnerd." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("paperclip/runResult", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "semantic-result-1",
      result,
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "run.result.proposed"),
    ).toMatchObject({ turnId: turn.turnId, itemId: "semantic-result-1" });
  });

  it("correlates rehydrated notifications with the final canonical PRP event ids", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-traced",
      normalizedSessionId: "normalized-traced",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Trace the response." },
    });

    transport.pushTraced(
      "turn/started",
      {
        threadId: "thread-1",
        turn: { id: turn.turnId, status: "inProgress" },
      },
      "event_runner_000001",
      "turn.started",
    );
    transport.pushTraced(
      "item/started",
      {
        threadId: "thread-1",
        turnId: turn.turnId,
        item: { id: "answer-1", type: "agentMessage", phase: "final_answer" },
      },
      "event_runner_000002",
      "item.started",
    );
    transport.pushTraced(
      "turn/completed",
      {
        threadId: "thread-1",
        turn: { id: turn.turnId, status: "completed", items: [] },
      },
      "event_runner_000003",
      "turn.completed",
    );

    const events = await collectUntilTerminal(session.events());
    const itemMapping = transport.traceInterpretations.find(
      (entry) => entry.providerMethod === "item/started",
    );
    expect(itemMapping).toMatchObject({
      sourceEventId: "event_runner_000002",
      sourceEventType: "item.started",
      disposition: "mapped",
    });
    expect(itemMapping?.emittedEventIds.length).toBeGreaterThan(0);
    expect(events.map((event) => event.sourceEventId)).toEqual(
      expect.arrayContaining(itemMapping?.emittedEventIds ?? []),
    );
    expect(JSON.stringify(events)).not.toContain("paperclipTrace");
  });

  it("maps canonical workspace snapshots with monotonic revisions and one terminal diff", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-canonical-workspace",
      normalizedSessionId: "normalized-canonical-workspace",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Change the workspace." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    const first = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turn.turnId}:workspace`,
      revision: 1,
      source: "harness_reported",
      complete: false,
      files: [{
        path: "src/index.ts",
        operation: "modify",
        previousPath: null,
        additions: 1,
        deletions: 0,
        binary: false,
        diff: "+first\n",
      }],
      totals: { files: 1, additions: 1, deletions: 0 },
      patchArtifactRef: null,
    };
    const second = {
      ...first,
      revision: 1,
      files: [
        first.files[0],
        {
          path: "src/new-name.ts",
          operation: "rename",
          previousPath: "src/old-name.ts",
          additions: 0,
          deletions: 0,
          binary: false,
          diff: "rename from src/old-name.ts\nrename to src/new-name.ts\n",
        },
        {
          path: "public/image.png",
          operation: "modify",
          previousPath: null,
          additions: null,
          deletions: null,
          binary: true,
          diff: null,
        },
      ],
      totals: { files: 3, additions: null, deletions: null },
    };
    transport.pushTraced(
      "paperclip/workspaceChange/updated",
      { threadId: "thread-1", turnId: turn.turnId, workspaceChange: first },
      "event_workspace_1",
      "workspace.change.updated",
    );
    transport.pushTraced(
      "paperclip/workspaceChange/updated",
      { threadId: "thread-1", turnId: turn.turnId, workspaceChange: second },
      "event_workspace_2",
      "workspace.change.updated",
    );
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: second,
    });
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: {
        ...second,
        files: [{ ...second.files[0], path: "/absolute/not-allowed.ts" }],
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    const updates = events.filter(
      (event) => event.eventType === "workspace.change.updated",
    );
    expect(
      updates.map(
        (event) => (event.payload as Record<string, unknown>).revision,
      ),
    ).toEqual([1, 2]);
    expect(
      (updates[1]?.payload as Record<string, unknown>).files,
    ).toHaveLength(3);
    expect(events.filter((event) => event.eventType === "workspace.diff.recorded"))
      .toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "workspace.diff.recorded")?.payload,
    ).toMatchObject({
      revision: 2,
      source: "runner_verified",
      complete: true,
      totals: { files: 3, additions: null, deletions: null },
    });
    expect(
      transport.traceInterpretations.filter((entry) =>
        entry.providerMethod === "paperclip/workspaceChange/updated"
      ).map((entry) => entry.disposition),
    ).toEqual(["mapped", "mapped"]);
  });

  it("finalizes an authoritative empty workspace snapshot when a turn is interrupted", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-empty-interrupted-workspace",
      normalizedSessionId: "normalized-empty-interrupted-workspace",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Inspect without changing files." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("paperclip/workspaceChange/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      workspaceChange: {
        schema: "paperclip.workspace.diff.v1",
        changeSetId: `${turn.turnId}:workspace`,
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        patchArtifactRef: null,
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "interrupted", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.find((event) => event.eventType === "workspace.change.updated")?.payload)
      .toMatchObject({ revision: 1, complete: false, totals: { files: 0 } });
    expect(events.filter((event) => event.eventType === "workspace.diff.recorded"))
      .toHaveLength(1);
    expect(events.find((event) => event.eventType === "workspace.diff.recorded")?.payload)
      .toMatchObject({ revision: 1, source: "runner_verified", complete: true, totals: { files: 0 } });
    expect(events.some((event) => event.eventType === "turn.interrupted")).toBe(true);
  });

  it("accepts a thread usage snapshot replayed before a resumed turn starts", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-usage-replay",
      normalizedSessionId: "normalized-usage-replay",
      workingDirectory: WORKSPACE,
    });

    transport.push("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "prior-turn",
      tokenUsage: { total: { inputTokens: 10, outputTokens: 4 } },
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Continue." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.some((event) => event.eventType === "session.failed")).toBe(
      false,
    );
    expect(await session.usage()).toMatchObject({
      total: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it("normalizes provider message and reasoning phases onto every streamed item event", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-stream-channels",
      normalizedSessionId: "normalized-stream-channels",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Stream progress." },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "progress-1",
        type: "agentMessage",
        phase: "commentary",
        text: "",
      },
    });
    transport.push("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "progress-1",
      delta: "Running it now.",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "progress-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Running it now.",
      },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: { id: "reason-1", type: "reasoning", summary: [] },
    });
    transport.push("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "reason-1",
      delta: "Summary",
    });
    transport.push("item/reasoning/textDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "reason-1",
      delta: "Detail",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "reason-1",
        type: "reasoning",
        summary: [{ text: "Summary" }],
      },
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "final-1",
        type: "agentMessage",
        phase: "final_answer",
        text: "",
      },
    });
    transport.push("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "final-1",
      delta: JSON.stringify(result),
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "final-1",
        type: "agentMessage",
        phase: "final_answer",
        text: JSON.stringify(result),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    const pick = (kind: string, channel: string) =>
      events.find(
        (event) =>
          event.payload.kind === kind && event.payload.channel === channel,
      );
    expect(pick("agentMessage", "progress")?.payload).toMatchObject({
      providerPhase: "commentary",
    });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "progress",
      )?.payload,
    ).toMatchObject({
      providerMethod: "item/agentMessage/delta",
      text: "Running it now.",
    });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "summary",
      )?.payload,
    ).toMatchObject({ providerMethod: "item/reasoning/summaryTextDelta" });
    expect(
      events.find(
        (event) =>
          event.eventType === "item.delta" &&
          event.payload.channel === "detail",
      )?.payload,
    ).toMatchObject({ providerMethod: "item/reasoning/textDelta" });
    expect(pick("agentMessage", "final")?.payload).toMatchObject({
      providerPhase: "final_answer",
    });
  });

});
