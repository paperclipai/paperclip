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
  it("captures an exact skillless model/environment snapshot with credentials absent", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-context",
      normalizedSessionId: "normalized-context",
      workingDirectory: WORKSPACE,
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const context = first.value?.payload.context as Parameters<
      typeof isSkilllessCodexContext
    >[0];
    expect(context).toMatchObject({
      codexVersion: "codex-cli/0.132.0",
      model: "gpt-test",
      modelProvider: "openai",
      workingDirectory: WORKSPACE,
      approvalPolicy: "never",
      instructionSources: [],
      instructionPolicy: {
        skillInstructions: false,
        appInstructions: false,
        collaborationInstructions: true,
      },
      environmentKeys: ["LANG", "PATH"],
      envelope,
    });
    expect(isSkilllessCodexContext(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("must-not-pass");
    expect(JSON.stringify(transport.calls)).not.toContain("RANDOM_SKILL_PATH");
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      approvalPolicy: "never",
      config: {
        "skills.include_instructions": false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: true,
        "features.image_generation": false,
      },
      permissions: "paperclip-runner-workspace-only",
      runtimeWorkspaceRoots: [WORKSPACE],
      dynamicTools: [{ name: "paperclip_finish" }, { name: "paperclip_block" }],
    });
    const commandPolicy = transport.calls.find(
      (call) => call.method === "thread/start",
    )?.params.config as Record<string, unknown>;
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/home");
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/codex");
    expect(JSON.stringify(commandPolicy)).not.toContain("CODEX_HOME");
    const appServerArgs = createIsolatedCodexAppServerArgs({
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex",
    });
    expect(appServerArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'default_permissions="paperclip-runner-workspace-only"',
        ),
        expect.stringContaining(
          "permissions.paperclip-runner-workspace-only.filesystem=",
        ),
        "permissions.paperclip-runner-workspace-only.network.enabled=false",
        'shell_environment_policy.inherit="none"',
        expect.stringContaining(
          'shell_environment_policy.set={PATH="/bin",LANG="C.UTF-8"}',
        ),
        "--disable",
        "image_generation",
      ]),
    );
    expect(
      appServerArgs.find((arg) => arg.startsWith("permissions.")),
    ).toContain('"/isolated/home"="none"');
    expect(
      appServerArgs.find((arg) => arg.startsWith("permissions.")),
    ).toContain('"/isolated/codex"="none"');
    expect(JSON.stringify(appServerArgs)).not.toContain("HOME=");
    expect(CODEX_RESULT_OUTPUT_SCHEMA.properties.schema).toEqual({
      type: "string",
      const: "paperclip.run_result.v1",
    });
    expect(
      CODEX_BLOCK_RESULT_OUTPUT_SCHEMA.properties.reportedWorkDisposition,
    ).toEqual({
      type: "string",
      const: "blocked",
    });
  });

  it.each(["never", "on-request", "untrusted"] as const)(
    "pins approval policy %s for both thread start and resume",
    async (approvalPolicy) => {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      const driver = makeDriver([first, second], { approvalPolicy });
      const original = await driver.openSession({
        runId: `run-policy-${approvalPolicy}`,
        normalizedSessionId: `normalized-policy-${approvalPolicy}`,
        workingDirectory: WORKSPACE,
      });
      const started = await original.events()[Symbol.asyncIterator]().next();
      const snapshot = await original.snapshot();
      await original.close({ reason: "policy recovery test" });
      const recovered = await driver.recoverSession?.(snapshot);
      expect(recovered).toMatchObject({ recovered: true });
      const resumed = await recovered!.session!.events()[Symbol.asyncIterator]().next();
      expect(first.calls.find((call) => call.method === "thread/start")?.params)
        .toMatchObject({ approvalPolicy });
      expect(second.calls.find((call) => call.method === "thread/resume")?.params)
        .toMatchObject({ approvalPolicy });
      expect(started.value).toMatchObject({ eventType: "session.started", payload: { context: { approvalPolicy } } });
      expect(resumed.value).toMatchObject({ eventType: "session.resumed", payload: { context: { approvalPolicy } } });
      await recovered?.session?.close({ reason: "policy recovery complete" });
    },
  );

  it("allows eval fixtures to opt out of Codex collaboration instructions", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], {
      includeCollaborationModeInstructions: false,
    }).openSession({
      runId: "run-no-collaboration-instructions",
      normalizedSessionId: "session-no-collaboration-instructions",
      workingDirectory: WORKSPACE,
    });
    const first = await session.events()[Symbol.asyncIterator]().next();

    expect(first.value?.payload.context).toMatchObject({
      instructionPolicy: { collaborationInstructions: false },
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      config: { include_collaboration_mode_instructions: false },
    });
  });

  it("negotiates genuine plan mode with collaboration instructions and read-only workspace access", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], {
      requestedCollaborationMode: "plan",
    });
    const session = await driver.openSession({
      runId: "run-plan",
      normalizedSessionId: "session-plan",
      workingDirectory: WORKSPACE,
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      permissions: "paperclip-runner-workspace-read-only",
      config: { include_collaboration_mode_instructions: true },
    });
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).not.toHaveProperty("collaborationMode");
    expect(
      transport.calls.some((call) => call.method === "collaborationMode/list"),
    ).toBe(true);
    await expect(
      session.startTurn({
        message: { role: "user", text: "Author a plan." },
        requestedCollaborationMode: "plan",
      }),
    ).resolves.toMatchObject({ effectiveCollaborationMode: "plan" });
    expect(
      transport.calls.find((call) => call.method === "turn/start")?.params,
    ).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-test",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      permissions: "paperclip-runner-workspace-read-only",
    });
  });

  it("fails closed when the installed app-server does not confirm plan mode", async () => {
    const transport = new FakeCodexTransport();
    transport.confirmCollaborationMode = false;
    await expect(
      makeDriver([transport], {
        requestedCollaborationMode: "plan",
      }).openSession({
        runId: "run-plan-unsupported",
        normalizedSessionId: "session-plan-unsupported",
        workingDirectory: WORKSPACE,
      }),
    ).rejects.toThrow("planning_mode_unsupported");
  });

  it("refuses to turn host credential roots into model-writable workspaces", async () => {
    await expect(
      makeDriver([], {
        environment: {
          HOME: "/isolated/home",
          CODEX_HOME: WORKSPACE,
        },
      }).openSession({
        runId: "run-codex-home",
        normalizedSessionId: "normalized-codex-home",
        workingDirectory: WORKSPACE,
      }),
    ).rejects.toThrow("cannot overlap host CODEX_HOME");
    await expect(
      makeDriver([], {
        environment: {
          HOME: `${WORKSPACE}/host-home`,
          CODEX_HOME: "/isolated/codex",
        },
      }).openSession({
        runId: "run-host-home",
        normalizedSessionId: "normalized-host-home",
        workingDirectory: WORKSPACE,
      }),
    ).rejects.toThrow("cannot contain the host HOME");
    await expect(
      makeDriver([]).openSession({
        runId: "run-root",
        normalizedSessionId: "normalized-root",
        workingDirectory: "/",
      }),
    ).rejects.toThrow("cannot be a filesystem root");
  });

  it("steers and interrupts an active turn without replacing the session", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-controls",
      normalizedSessionId: "normalized-controls",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Use a shorter answer." },
    });
    await session.interrupt?.({ turnId, reason: "operator requested" });
    expect(transport.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/goal/get",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
    expect(session.ids()).toEqual({
      driverSessionId: "thread-1",
      providerSessionId: "provider-session-1",
      displayId: "thread-1",
    });
  });

  it("loads the deterministic Live console wire fixture", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    expect(
      fixture.runtimeRequests.map(({ requestKind }) => requestKind),
    ).toEqual([
      "command_approval",
      "file_approval",
      "permission_approval",
      "user_input",
      "elicitation",
    ]);
    expect(fixture.goals.map(({ action }) => action)).toEqual([
      "get",
      "set",
      "pause",
      "resume",
      "clear",
    ]);
  });

  it("holds browser-resolved upstream requests and returns the exact fixture responses", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    for (const scenario of fixture.runtimeRequests) {
      const transport = new FakeCodexTransport();
      const session = await makeDriver([transport]).openSession({
        runId: `run-${scenario.id}`,
        normalizedSessionId: `normalized-${scenario.id}`,
        workingDirectory: WORKSPACE,
      });
      const { turnId } = await session.startTurn({
        message: { role: "user", text: "Exercise request." },
      });
      const response = transport.invoke({
        id: scenario.id,
        method: scenario.method,
        params: {
          threadId: "thread-1",
          turnId,
          itemId: `item-${scenario.id}`,
          reason: `fixture ${scenario.id}`,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.pendingRuntimeRequests?.()).toEqual([
        expect.objectContaining({
          requestId: scenario.id,
          requestKind: scenario.requestKind,
          method: scenario.method,
          turnId,
        }),
      ]);
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: scenario.id,
          turnId,
          resolution: {
            action: "forged",
          } as unknown as HarnessRuntimeRequestResolution,
        }),
      ).rejects.toThrow("unsupported action");
      expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
      await session.resolveRuntimeRequest?.({
        requestId: scenario.id,
        turnId,
        resolution: scenario.resolution as HarnessRuntimeRequestResolution,
      });
      expect(await response).toEqual(scenario.expectedResponse);
      expect(session.pendingRuntimeRequests?.()).toEqual([]);
      await expect(
        session.resolveRuntimeRequest?.({
          requestId: scenario.id,
          turnId,
          resolution: { action: "cancel" },
        }),
      ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
      await session.close({ reason: "fixture complete" });
    }
  });

  it("acknowledges same-turn steering and rejects stale or child steering", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport("thread-root");
    const session = await makeDriver([transport]).openSession({
      runId: "run-live-console-controls",
      normalizedSessionId: "normalized-live-console-controls",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Stay concise." },
      correlationId: "queued-comment-1",
    });
    transport.push("item/completed", {
      kind: "steering_acknowledgement",
      status: "acknowledged",
      commandId: "runnerd-steer-command",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.steer?.({
      turnId,
      message: { role: "user", text: "Stay concise." },
      correlationId: "queued-comment-1",
    });
    expect(
      transport.calls.find((call) => call.method === "turn/steer")?.params,
    ).toMatchObject({ correlationId: "queued-comment-1" });
    expect(
      transport.calls.filter((call) => call.method === "turn/steer"),
    ).toHaveLength(1);
    transport.rejectMethods.set(
      "turn/steer",
      new Error("provider rejected steering"),
    );
    const rejectedSteering = await session
      .steer?.({
        turnId,
        message: { role: "user", text: "Try this again later." },
        correlationId: "queued-comment-2",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejectedSteering).toBeInstanceOf(Error);
    expect(rejectedSteering).not.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    expect(String(rejectedSteering)).toContain("provider rejected steering");
    transport.rejectMethods.delete("turn/steer");
    await expect(
      session.steer?.({
        turnId: fixture.controls.staleTurnSteer.turnId!,
        message: { role: "user", text: "Stale." },
      }),
    ).rejects.toBeInstanceOf(HarnessStaleTurnError);
    transport.push("thread/started", { thread: fixture.lineage.childThread });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.lineage?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thread-root",
          parentThreadId: null,
          depth: 0,
        }),
        expect.objectContaining({
          threadId: "thread-child",
          parentThreadId: "thread-root",
          depth: 1,
          nickname: "Scout",
          role: "researcher",
        }),
      ]),
    );
    await expect(
      session.steer?.({
        turnId: "thread-child",
        message: { role: "user", text: "Do not emulate child steering." },
      }),
    ).rejects.toBeInstanceOf(HarnessStaleTurnError);
    const events = session.events()[Symbol.asyncIterator]();
    const observed: PrpEvent[] = [];
    for (let index = 0; index < 9; index += 1) {
      const next = await events.next();
      if (next.done) break;
      observed.push(next.value);
    }
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "item.completed",
          itemId: `${turnId}:steer:queued-comment-1`,
          payload: expect.objectContaining({
            kind: "steering_acknowledgement",
            status: "acknowledged",
          }),
        }),
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({ code: "stale_turn_rejected" }),
        }),
        expect.objectContaining({
          eventType: "item.started",
          payload: expect.objectContaining({ kind: "thread_lineage" }),
        }),
      ]),
    );
    expect(observed.some((event) => event.eventType === "session.failed"))
      .toBe(false);
    await session.close({ reason: "fixture complete" });
  });

  it("queues an interrupt before turn identity and reports a terminal race precisely", async () => {
    const transport = new FakeCodexTransport();
    let releaseStart!: (value: Record<string, unknown>) => void;
    transport.turnStartResponse = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const session = await makeDriver([transport]).openSession({
      runId: "run-interrupt-races",
      normalizedSessionId: "normalized-interrupt-races",
      workingDirectory: WORKSPACE,
    });
    const starting = session.startTurn({
      message: { role: "user", text: "Start slowly." },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.interrupt?.({ reason: "operator" });
    releaseStart({ turn: { id: "turn-1", status: "inProgress", items: [] } });
    await expect(starting).resolves.toEqual({
      turnId: "turn-1",
      effectiveCollaborationMode: "default",
    });
    expect(transport.calls.map(({ method }) => method)).toEqual(
      expect.arrayContaining(["turn/start", "turn/interrupt"]),
    );
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", items: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      session.interrupt?.({ turnId: "turn-1" }),
    ).rejects.toBeInstanceOf(HarnessOperationAlreadyTerminalError);
    await session.close({ reason: "fixture complete" });
  });

  it("maps all goal operations and advertises an exact unsupported state", async () => {
    const fixture = await loadLiveConsoleConformanceFixture(
      liveConsoleFixturePath,
    );
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-goals",
      normalizedSessionId: "normalized-goals",
      workingDirectory: WORKSPACE,
    });
    await session.goal?.({ action: "get" });
    await session.goal?.({
      action: "set",
      objective: "Ship the Live console tracer",
      tokenBudget: 4096,
    });
    await session.goal?.({ action: "pause" });
    await session.goal?.({ action: "resume" });
    await session.goal?.({ action: "clear" });
    const goalCalls = transport.calls.filter(({ method }) =>
      method.startsWith("thread/goal/"),
    );
    expect(
      goalCalls.slice(1).map(({ method, params }) => ({
        method,
        params: Object.fromEntries(
          Object.entries(params).filter(([key]) => key !== "threadId"),
        ),
      })),
    ).toEqual(fixture.goals.map(({ method, params }) => ({ method, params })));

    expect(
      (await makeDriver([new FakeCodexTransport()]).descriptor()).capabilities,
    ).toMatchObject({ goals: true });

    // Both denials a real app-server sends: the method is absent, and the
    // build has the feature switched off.
    for (const denial of [
      new CodexRpcError(
        '{"code":-32601,"message":"method not found"}',
        CODEX_METHOD_NOT_FOUND,
      ),
      new CodexRpcError(
        '{"code":-32600,"message":"goals feature is disabled"}',
        CODEX_INVALID_REQUEST,
      ),
    ]) {
      const unsupportedTransport = new FakeCodexTransport();
      unsupportedTransport.rejectMethods.set("thread/goal/get", denial);
      const unsupportedDriver = makeDriver([unsupportedTransport]);
      const unsupported = await unsupportedDriver.openSession({
        runId: "run-goals-unsupported",
        normalizedSessionId: "normalized-goals-unsupported",
        workingDirectory: WORKSPACE,
      });
      expect((await unsupportedDriver.descriptor()).capabilities).toMatchObject(
        { goals: false },
      );
      await expect(
        unsupported.goal?.({ action: "get" }),
      ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
      await unsupported.close({ reason: "fixture complete" });
    }
    await session.close({ reason: "fixture complete" });
  });

  it("keeps goal support advertised when the probe fails transiently", async () => {
    // A transport or protocol failure is evidence about this call, not about
    // what the provider implements, so it must not retire the capability.
    for (const failure of [
      new Error("codex app-server transport closed"),
      new CodexRpcError('{"code":-32603,"message":"internal error"}', -32_603),
    ]) {
      const transport = new FakeCodexTransport();
      transport.rejectMethods.set("thread/goal/get", failure);
      const driver = makeDriver([transport]);
      const session = await driver.openSession({
        runId: "run-goals-transient",
        normalizedSessionId: "normalized-goals-transient",
        workingDirectory: WORKSPACE,
      });

      expect((await driver.descriptor()).capabilities).toMatchObject({
        goals: true,
      });
      // The capability survives, so the operation is still offered and the
      // next call reaches the provider instead of failing closed locally.
      transport.rejectMethods.delete("thread/goal/get");
      await expect(session.goal?.({ action: "get" })).resolves.toBeNull();
      expect(
        transport.calls.filter(({ method }) => method === "thread/goal/get"),
      ).toHaveLength(2);
      await session.close({ reason: "fixture complete" });
    }
  });

});
