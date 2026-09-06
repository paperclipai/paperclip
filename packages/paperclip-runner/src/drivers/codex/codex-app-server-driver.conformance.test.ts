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
  it("degrades unsupported operations with explicit redacted diagnostics", async () => {
    const transport = new FakeCodexTransport();
    transport.rejectMethods.set(
      "turn/steer",
      new Error("method not found Bearer super-secret api_key=also-secret"),
    );
    const session = await makeDriver([transport]).openSession({
      runId: "run-degrade",
      normalizedSessionId: "normalized-degrade",
      workingDirectory: WORKSPACE,
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Start." },
    });
    await expect(
      session.steer?.({ turnId, message: { role: "user", text: "Steer." } }),
    ).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
    const iterator = session.events()[Symbol.asyncIterator]();
    const events: PrpEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      const next = await iterator.next();
      if (next.value) events.push(next.value);
    }
    const diagnostic = events.find(
      (event) => event.eventType === "harness.diagnostic",
    );
    expect(diagnostic?.payload).toMatchObject({
      code: "unsupported_operation",
      operation: "steering",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("also-secret");
  });

  it("rejects proposals that do not match the exact task envelope", () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "codex-demo-v0";
    expect(validateCodexResultProposal(wrongRevision, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "contract_revision_mismatch" }],
    });

    const unknownCriterion = structuredClone(result);
    unknownCriterion.completionClaim.criteria = [
      {
        criterionId: "not-in-envelope",
        status: "satisfied",
        evidenceRefs: [],
      },
    ];
    const criterionDecision = validateCodexResultProposal(
      unknownCriterion,
      envelope,
    );
    expect(criterionDecision).toMatchObject({ status: "rejected" });
    if (criterionDecision.status === "rejected") {
      expect(criterionDecision.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["unknown_criterion", "missing_criterion"]),
      );
    }

    const invalidDone = structuredClone(result);
    invalidDone.completionClaim.objectiveSatisfied = false;
    expect(validateCodexResultProposal(invalidDone, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "invalid_disposition" }],
    });
  });

  it.each(["needs_review", "blocked"] as const)(
    "keeps a completed runtime successful for an accepted %s advisory proposal",
    async (disposition) => {
      const proposal: PrpStructuredRunResult =
        disposition === "needs_review"
          ? {
              ...structuredClone(result),
              reportedWorkDisposition: "needs_review",
              attentionRequests: [
                { kind: "review", summary: "Review the completed artifact." },
              ],
            }
          : {
              ...structuredClone(result),
              reportedWorkDisposition: "blocked",
              summary: "Waiting on fixture input.",
              completionClaim: {
                ...structuredClone(result.completionClaim),
                objectiveSatisfied: false,
                criteria: [
                  {
                    criterionId: "file",
                    status: "not_satisfied",
                    evidenceRefs: [],
                  },
                ],
                remainingWork: [
                  {
                    description: "Provide fixture input.",
                    blocksCompletion: true,
                  },
                ],
              },
              blocker: {
                reasonCode: "fixture_input_missing",
                owner: { kind: "external", name: "fixture owner" },
                unblockAction: "Provide fixture input.",
                scope: "task_wide",
              },
              artifacts: [],
            };
      const { trace } = await traceCompletedProposal(proposal);
      expect(trace.resultDecision.status).toBe("accepted");
      expect(
        trace.events.find((event) => event.eventType === "run.terminal")
          ?.payload,
      ).toMatchObject({
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: disposition,
      });
    },
  );

  it("records rejected and missing proposals as recovery evidence instead of review status", async () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "wrong-revision";
    const rejected = await traceCompletedProposal(wrongRevision);
    expect(rejected.trace.result).toBeNull();
    expect(rejected.trace.proposedResult).toMatchObject({
      reportedWorkDisposition: "done",
    });
    expect(
      rejected.trace.events.find(
        (event) => event.eventType === "run.result.rejected",
      )?.payload,
    ).toMatchObject({ recovery: { required: true, recoverable: true } });
    expect(
      rejected.trace.events.find((event) => event.eventType === "run.terminal")
        ?.payload,
    ).toMatchObject({
      runTerminalState: "failed",
      reportedWorkDisposition: "yielded",
    });

    const missing = await traceCompletedProposal(null);
    expect(missing.trace.resultDecision).toMatchObject({ status: "rejected" });
    expect(
      missing.trace.events.find((event) => event.eventType === "run.terminal")
        ?.payload,
    ).toMatchObject({
      runTerminalState: "failed",
      reportedWorkDisposition: "yielded",
    });
    expect(
      missing.trace.events.some(
        (event) =>
          event.eventType === "run.result.proposed" &&
          event.payload.reportedWorkDisposition === "needs_review",
      ),
    ).toBe(false);
  });

  it("preserves four independent stable identities under controller ownership", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
    });
    expect(trace.assertions.stableIdentity).toBe(true);
    expect(trace.metadata.identity).toMatchObject({
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
      driverSessionId: "thread-1",
      providerSessionId: "provider-session-1",
    });
    expect(
      trace.events.every(
        (event) =>
          event.runId === "runtime-run-identity" &&
          event.normalizedSessionId === "controller-session-identity",
      ),
    ).toBe(true);
  });

  it("validates persisted identity, uniqueness, terminals, and line bounds before replay", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-persisted",
      normalizedSessionId: "controller-session-persisted",
    });
    const serialize = (events: PrpEvent[]) =>
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    expect(
      replayPersistedCodexEvents(serialize(trace.events), trace.metadata),
    ).toEqual(trace.replaySnapshot);

    const mismatched = structuredClone(trace.events);
    mismatched[0]!.normalizedSessionId = "another-session";
    expect(() =>
      replayPersistedCodexEvents(serialize(mismatched), trace.metadata),
    ).toThrow("identity did not match");

    const terminalIndex = trace.events.findIndex(
      (event) => event.eventType === "run.terminal",
    );
    const duplicated = trace.events.toSpliced(
      terminalIndex,
      0,
      structuredClone(trace.events[0]!),
    );
    expect(() =>
      replayPersistedCodexEvents(serialize(duplicated), trace.metadata),
    ).toThrow("event id was duplicated");

    const terminal = structuredClone(trace.events[terminalIndex]!);
    terminal.sourceEventId = `${terminal.sourceEventId}:conflict`;
    terminal.sourceSeq += 1;
    expect(() =>
      replayPersistedCodexEvents(
        serialize([...trace.events, terminal]),
        trace.metadata,
      ),
    ).toThrow("after the run terminal");
    expect(() =>
      replayPersistedCodexEvents(
        `{\"payload\":\"${"x".repeat(300 * 1024)}\"}\n`,
        trace.metadata,
      ),
    ).toThrow("line was empty or oversized");
    expect(() =>
      replayPersistedCodexEvents("{not-json}\n", trace.metadata),
    ).toThrow("malformed JSON");
  });

  it("degrades declared unsupported capabilities without Codex-specific core branches", async () => {
    const capabilities = {
      resume: false,
      read: false,
      steering: false,
      interruption: false,
      usage: false,
      reconciliation: false,
      dynamicTools: false,
    };
    const { trace, transport } = await traceCompletedProposal(result, {
      capabilities,
      steer: "Do not call this unsupported path.",
      interrupt: true,
    });
    expect(trace.resultDecision.status).toBe("accepted");
    expect(trace.assertions.contextIsSkillless).toBe(true);
    expect(trace.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("steering is unavailable"),
        expect.stringContaining("interruption is unavailable"),
      ]),
    );
    expect(transport.calls.map((call) => call.method)).not.toEqual(
      expect.arrayContaining(["turn/steer", "turn/interrupt", "thread/read"]),
    );
    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params
        .dynamicTools,
    ).toEqual([]);

    const directTransport = new FakeCodexTransport();
    const driver = makeDriver([directTransport], { capabilities });
    const session = await driver.openSession({
      runId: "run-no-capabilities",
      normalizedSessionId: "normalized-no-capabilities",
      workingDirectory: WORKSPACE,
    });
    await expect(session.read?.()).rejects.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    await expect(session.usage?.()).rejects.toBeInstanceOf(
      HarnessCapabilityUnavailableError,
    );
    const snapshot = await session.snapshot();
    expect(await driver.recoverSession?.(snapshot)).toMatchObject({
      recovered: false,
      reason: "resume capability is unavailable",
    });
  });
});
