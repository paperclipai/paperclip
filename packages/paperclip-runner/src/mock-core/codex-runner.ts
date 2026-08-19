import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import {
  isSkilllessCodexContext,
  type CodexResultDecision,
  type CodexResultValidationIssue,
  type CodexRunMetadata,
  type CodexRunTrace,
  type CodexTaskEnvelope,
} from "../contracts/codex.js";
import type { NativeUserMessage } from "../contracts/types.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../reducer/session-reducer.js";
import {
  validatePrpEvent,
  validatePrpStructuredRunResult,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "../protocol/replay-contract.js";

const MAX_PERSISTED_CODEX_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_CODEX_LINE_BYTES = 256 * 1024;
const MAX_PERSISTED_CODEX_EVENTS = 4096;

export interface CodexCodexTracerInput {
  driver: HarnessDriver;
  taskEnvelope: CodexTaskEnvelope;
  workingDirectory: string;
  message?: NativeUserMessage;
  runId?: string;
  normalizedSessionId?: string;
  companyId?: string;
  issueId?: string;
  environmentLeaseId?: string;
  runnerInstanceId?: string;
  controlPlaneInstanceId?: string;
  steer?: string;
  interrupt?: boolean;
  timeoutMs?: number;
}

function prpCapabilities(
  descriptor: Awaited<ReturnType<HarnessDriver["descriptor"]>>,
): PrpCapabilities {
  return {
    schema: "paperclip.prp.capabilities.v1",
    sessionReusePolicy: "reuse_per_issue",
    driver: { kind: descriptor.kind, version: descriptor.version },
    steer: descriptor.capabilities.steering,
    interrupt: descriptor.capabilities.interruption,
    resume: descriptor.capabilities.resume,
    runtimeRequests: true,
    structuredResult: descriptor.capabilities.structuredResult,
    typedEvents: descriptor.capabilities.typedEvents,
    ...(descriptor.capabilities.unsupported?.length
      ? { unsupported: descriptor.capabilities.unsupported }
      : {}),
  };
}

function contextFrom(events: PrpEvent[]) {
  const event = events.find(
    (candidate) =>
      candidate.eventType === "session.started" || candidate.eventType === "session.resumed",
  );
  const context = event?.payload.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new Error("Harness session did not emit its model-context snapshot");
  }
  return context as CodexRunTrace["context"];
}

function dispositionIssues(
  result: PrpStructuredRunResult,
): CodexResultValidationIssue[] {
  const issues: CodexResultValidationIssue[] = [];
  const claim = result.completionClaim;
  if (result.reportedWorkDisposition === "done") {
    if (
      claim.objectiveSatisfied !== true ||
      claim.criteria.some((criterion) => criterion.status !== "satisfied") ||
      claim.remainingWork.some((remaining) => remaining.blocksCompletion) ||
      result.blocker !== undefined
    ) {
      issues.push({
        code: "invalid_disposition",
        path: "/reportedWorkDisposition",
        message: "done requires a satisfied objective and criteria with no blocking work or blocker",
      });
    }
  } else if (result.reportedWorkDisposition === "needs_review") {
    if (result.blocker !== undefined || result.attentionRequests.length === 0) {
      issues.push({
        code: "invalid_disposition",
        path: "/reportedWorkDisposition",
        message: "needs_review requires an attention request and must not include a blocker",
      });
    }
  } else if (result.reportedWorkDisposition === "blocked") {
    if (
      claim.objectiveSatisfied !== false ||
      result.blocker === undefined ||
      !claim.remainingWork.some((remaining) => remaining.blocksCompletion)
    ) {
      issues.push({
        code: "invalid_disposition",
        path: "/reportedWorkDisposition",
        message: "blocked requires an unsatisfied objective, blocker details, and blocking remaining work",
      });
    }
  } else {
    issues.push({
      code: "invalid_disposition",
      path: "/reportedWorkDisposition",
      message: `${result.reportedWorkDisposition} is not a Codex terminal proposal`,
    });
  }
  return issues;
}

/** Validate an advisory provider proposal against the exact controller-owned task envelope. */
export function validateCodexResultProposal(
  proposal: unknown,
  envelope: CodexTaskEnvelope,
): CodexResultDecision {
  const schema = validatePrpStructuredRunResult(proposal);
  if (!schema.ok) {
    return {
      status: "rejected",
      result: null,
      issues: schema.issues.map((issue) => ({
        code: "schema_validation",
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  const result = schema.result;
  const issues: CodexResultValidationIssue[] = [];
  if (result.completionClaim.contractRevision !== envelope.completionContract.revision) {
    issues.push({
      code: "contract_revision_mismatch",
      path: "/completionClaim/contractRevision",
      message: `expected exact contract revision ${envelope.completionContract.revision}`,
    });
  }

  const expectedIds = new Set(envelope.completionContract.criteria.map((criterion) => criterion.id));
  const observed = new Map<string, number>();
  result.completionClaim.criteria.forEach((criterion, index) => {
    observed.set(criterion.criterionId, (observed.get(criterion.criterionId) ?? 0) + 1);
    if (!expectedIds.has(criterion.criterionId)) {
      issues.push({
        code: "unknown_criterion",
        path: `/completionClaim/criteria/${index}/criterionId`,
        message: `criterion ${criterion.criterionId} is not in the task envelope`,
      });
    }
  });
  for (const criterionId of expectedIds) {
    const count = observed.get(criterionId) ?? 0;
    if (count === 0) {
      issues.push({
        code: "missing_criterion",
        path: "/completionClaim/criteria",
        message: `criterion ${criterionId} is missing`,
      });
    } else if (count > 1) {
      issues.push({
        code: "duplicate_criterion",
        path: "/completionClaim/criteria",
        message: `criterion ${criterionId} appears more than once`,
      });
    }
  }
  issues.push(...dispositionIssues(result));

  return issues.length === 0
    ? { status: "accepted", result: structuredClone(result), issues: [] }
    : { status: "rejected", result: null, issues };
}

async function consumeToTurnTerminal(
  session: HarnessSession,
  timeoutMs: number,
  onEvent?: (event: PrpEvent) => void,
): Promise<PrpEvent[]> {
  const consume = async () => {
    const events: PrpEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      onEvent?.(event);
      if (isTurnTerminal(event)) return events;
    }
    throw new Error("Harness event stream closed before a turn terminal fact");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      consume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Codex tracer timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isTurnTerminal(event: PrpEvent): boolean {
  return ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(
    event.eventType,
  );
}

function runtimeTerminal(event: PrpEvent): Pick<PrpTerminalState, "turnTerminalState" | "runTerminalState"> {
  if (event.eventType === "turn.completed") {
    return { turnTerminalState: "completed", runTerminalState: "succeeded" };
  }
  if (event.eventType === "turn.failed") {
    return { turnTerminalState: "failed", runTerminalState: "failed" };
  }
  if (event.eventType === "turn.interrupted") {
    return { turnTerminalState: "interrupted", runTerminalState: "cancelled" };
  }
  return { turnTerminalState: "cancelled", runTerminalState: "cancelled" };
}

function sourceSequenceContinuous(events: PrpEvent[]): boolean {
  const cursors = new Map<string, number>();
  for (const event of events) {
    const key = `${event.sourceKind}:${event.sourceInstanceId}`;
    const previous = cursors.get(key);
    if (previous !== undefined && event.sourceSeq !== previous + 1) return false;
    cursors.set(key, event.sourceSeq);
  }
  return true;
}

/** Parse and validate the persisted boundary before replaying controller state. */
export function replayPersistedCodexEvents(
  serialized: string,
  metadata: CodexRunMetadata,
) {
  if (!metadata.identity.driverSessionId) {
    throw new Error("Persisted Codex replay requires a driver session identity");
  }
  if (Buffer.byteLength(serialized) > MAX_PERSISTED_CODEX_BYTES) {
    throw new Error("Persisted Codex event stream exceeded its byte limit");
  }
  const lines = serialized.endsWith("\n")
    ? serialized.slice(0, -1).split("\n")
    : serialized.split("\n");
  if (lines.length === 0 || lines.length > MAX_PERSISTED_CODEX_EVENTS) {
    throw new Error("Persisted Codex event stream exceeded its event limit");
  }
  const events: PrpEvent[] = [];
  const sourceEventIds = new Set<string>();
  const sourceSequences = new Map<string, number>();
  let runTerminalCount = 0;
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line) > MAX_PERSISTED_CODEX_LINE_BYTES) {
      throw new Error("Persisted Codex event line was empty or oversized");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw new Error("Persisted Codex event line was malformed JSON");
    }
    const validation = validatePrpEvent(candidate);
    if (!validation.ok) throw new Error("Persisted Codex event failed schema validation");
    const event = validation.event;
    if (
      event.runId !== metadata.identity.runId ||
      event.normalizedSessionId !== metadata.identity.normalizedSessionId
    ) {
      throw new Error("Persisted Codex event identity did not match the opened run");
    }
    if (sourceEventIds.has(event.sourceEventId)) {
      throw new Error("Persisted Codex event id was duplicated");
    }
    sourceEventIds.add(event.sourceEventId);
    const source = `${event.sourceKind}:${event.sourceInstanceId}`;
    const previous = sourceSequences.get(source);
    if (previous !== undefined && event.sourceSeq !== previous + 1) {
      throw new Error("Persisted Codex source sequence was discontinuous");
    }
    sourceSequences.set(source, event.sourceSeq);
    if (runTerminalCount > 0) {
      throw new Error("Persisted Codex event appeared after the run terminal");
    }
    if (event.eventType === "run.terminal") runTerminalCount += 1;
    events.push(event);
  }
  if (runTerminalCount !== 1) {
    throw new Error("Persisted Codex event stream requires exactly one run terminal");
  }
  return events.reduce(
    applyPrpEvent,
    createSessionSnapshotFromMetadata({
      fixtureName: metadata.fixtureName,
      identity: {
        ...metadata.identity,
        driverSessionId: metadata.identity.driverSessionId,
      },
      capabilities: metadata.capabilities,
    }),
  );
}

/**
 * Small in-memory Codex mock core. The driver reports provider facts; this
 * controller validates semantic proposals and alone emits the run terminal.
 */
export async function runCodexCodexTracer(input: CodexCodexTracerInput): Promise<CodexRunTrace> {
  const runId = input.runId ?? "codex-safe-run";
  const normalizedSessionId = input.normalizedSessionId ?? "codex-normalized-session";
  const descriptor = await input.driver.descriptor();
  const capabilities = prpCapabilities(descriptor);
  const metadata: CodexRunMetadata = {
    schema: "paperclip.runner.codex.metadata.v1",
    fixtureName: "codex-safe-codex-task",
    identity: {
      schema: "paperclip.prp.identity.v1",
      companyId: input.companyId ?? "mock-company",
      issueId: input.issueId ?? "mock-issue",
      runId,
      environmentLeaseId: input.environmentLeaseId ?? "mock-lease",
      runnerInstanceId: input.runnerInstanceId ?? "runner-codex",
      normalizedSessionId,
    },
    capabilities,
  };
  const session = await input.driver.openSession({
    runId,
    normalizedSessionId,
    workingDirectory: input.workingDirectory,
  });
  const capabilityDiagnostics: string[] = [];
  let signalTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    signalTurnStarted = resolve;
  });
  const consuming = consumeToTurnTerminal(session, input.timeoutMs ?? 180_000, (event) => {
    if (event.eventType === "turn.started") signalTurnStarted?.();
  });

  try {
    const turn = await session.startTurn({
      message: input.message ?? { role: "user", text: "Complete the supplied task envelope." },
    });
    if (input.steer !== undefined || input.interrupt) {
      await Promise.race([
        turnStarted,
        consuming.then(() => {
          throw new Error("Harness turn reached terminal state before accepting the control command");
        }),
      ]);
    }
    if (input.steer !== undefined) {
      if (!descriptor.capabilities.steering || session.steer === undefined) {
        capabilityDiagnostics.push("steering is unavailable by driver capability contract");
      } else {
        try {
          await session.steer({
            turnId: turn.turnId,
            message: { role: "user", text: input.steer },
          });
        } catch (error) {
          capabilityDiagnostics.push(`steering degraded: ${String(error)}`);
        }
      }
    }
    if (input.interrupt) {
      if (!descriptor.capabilities.interruption || session.interrupt === undefined) {
        capabilityDiagnostics.push("interruption is unavailable by driver capability contract");
      } else {
        try {
          await session.interrupt({ turnId: turn.turnId, reason: "Codex tutorial interrupt" });
        } catch (error) {
          capabilityDiagnostics.push(`interruption degraded: ${String(error)}`);
        }
      }
    }

    const providerEvents = await consuming;
    const ids = session.ids();
    const identity = {
      ...metadata.identity,
      driverSessionId: ids.driverSessionId,
      ...(ids.providerSessionId ? { providerSessionId: ids.providerSessionId } : {}),
    };
    metadata.identity = identity;

    const proposals = providerEvents.filter(
      (event) => event.eventType === "run.result.proposed",
    );
    const proposedResult = proposals.length === 1 ? structuredClone(proposals[0]!.payload) : null;
    const resultDecision: CodexResultDecision =
      proposals.length === 1
        ? validateCodexResultProposal(proposedResult, input.taskEnvelope)
        : {
            status: "rejected",
            result: null,
            issues: [{
              code: "schema_validation",
              path: "/run.result.proposed",
              message:
                proposals.length === 0
                  ? "the completed turn emitted no semantic proposal"
                  : "the completed turn emitted multiple semantic proposals",
            }],
          };

    let controlSequence = 0;
    const controlPlaneInstanceId = input.controlPlaneInstanceId ?? "mock-core-codex";
    const controlEvent = (
      eventType: PrpEvent["eventType"],
      payload: Record<string, unknown>,
      refs: { turnId?: string; itemId?: string } = {},
    ): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${controlPlaneInstanceId}:${runId}:${++controlSequence}`,
      sourceSeq: controlSequence,
      sourceInstanceId: controlPlaneInstanceId,
      sourceKind: "control_plane",
      runId,
      normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.terminal" || eventType.startsWith("run.result.") ? 0 : 1,
      emittedAt: new Date().toISOString(),
      payload,
    });
    const controlEvents = capabilityDiagnostics.map((message) =>
      controlEvent("runner.diagnostic", {
        code: "capability_unavailable",
        message,
      }),
    );
    controlEvents.push(
      resultDecision.status === "accepted"
        ? controlEvent("run.result.accepted", {
            contractRevision: input.taskEnvelope.completionContract.revision,
            result: resultDecision.result,
          })
        : controlEvent("run.result.rejected", {
            reasonCode: "semantic_result_rejected",
            issues: resultDecision.issues,
            recovery: { required: true, recoverable: true },
          }),
    );
    const providerTerminal = providerEvents.findLast(isTurnTerminal);
    if (providerTerminal === undefined) throw new Error("turn terminal invariant failed");
    const runtime = runtimeTerminal(providerTerminal);
    controlEvents.push(controlEvent("run.terminal", {
      schema: "paperclip.prp.terminal.v1",
      ...runtime,
      reportedWorkDisposition:
        resultDecision.status === "accepted"
          ? resultDecision.result.reportedWorkDisposition
          : "yielded",
    }, providerTerminal.turnId ? { turnId: providerTerminal.turnId } : {}));
    const events = [...providerEvents, ...controlEvents];

    const liveSnapshot = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata({
        fixtureName: metadata.fixtureName,
        identity,
        capabilities,
      }),
    );
    const persistedEvents = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const replaySnapshot = replayPersistedCodexEvents(persistedEvents, metadata);
    const context = contextFrom(events);
    const terminalCount = events.filter((event) => event.eventType === "run.terminal").length;
    const turnTerminalCount = events.filter(isTurnTerminal).length;
    const decisionCount = events.filter(
      (event) =>
        event.eventType === "run.result.accepted" || event.eventType === "run.result.rejected",
    ).length;
    const serialized = JSON.stringify(context).toLowerCase();
    const itemEvents = events.filter((event) => event.eventType.startsWith("item."));
    const providerSessionId = ids.providerSessionId ?? null;
    return {
      schema: "paperclip.runner.codex.trace.v1",
      metadata,
      context,
      events,
      proposedResult,
      result: resultDecision.result,
      resultDecision,
      liveSnapshot,
      replaySnapshot,
      diagnostics: events
        .filter(
          (event) =>
            event.eventType === "runner.diagnostic" ||
            event.eventType === "harness.diagnostic" ||
            event.eventType === "run.result.rejected",
        )
        .map((event) => String(event.payload.message ?? event.payload.reasonCode ?? event.payload.code ?? "diagnostic")),
      assertions: {
        exactlyOneTerminalResult:
          terminalCount === 1 && turnTerminalCount === 1 && decisionCount === 1,
        proposalAccepted: resultDecision.status === "accepted",
        liveReplayParity: JSON.stringify(liveSnapshot) === JSON.stringify(replaySnapshot),
        stableIdentity:
          providerSessionId !== null &&
          runId.length > 0 &&
          normalizedSessionId.length > 0 &&
          ids.driverSessionId.length > 0 &&
          providerSessionId.length > 0 &&
          events.every(
            (event) =>
              event.runId === runId && event.normalizedSessionId === normalizedSessionId,
          ),
        sourceSequenceContinuous: sourceSequenceContinuous(events),
        stableItemIdentity: itemEvents.every(
          (event) => typeof event.itemId === "string" && event.itemId.length > 0,
        ),
        contextIsSkillless: isSkilllessCodexContext(context, {
          dynamicTools: descriptor.capabilities.dynamicTools === true,
        }),
        unrelatedSkillsAbsent:
          context.instructionSources.length === 0 &&
          context.instructionPolicy.skillInstructions === false &&
          context.modelInputKinds.length === 1 &&
          context.modelInputKinds[0] === "text",
        credentialsAbsent:
          !serialized.includes("paperclip_api_key") &&
          !serialized.includes("authorization: bearer") &&
          !serialized.includes("/api/issues/"),
      },
    };
  } finally {
    await session.close({ reason: "Codex tracer complete" });
  }
}
