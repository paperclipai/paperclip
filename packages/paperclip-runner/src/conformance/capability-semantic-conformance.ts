import {
  CapabilityMockControlPlaneAdapter,
} from "../mock-core/capability-mock-control-plane-adapter.js";
import type {
  CapabilityFixtureSeed,
  CapabilityFixtureState,
  CapabilityOpenFixtureRunInput,
} from "../mock-core/capability-control-plane-types.js";
import {
  CapabilitySemanticDispatcher,
  type CapabilitySemanticDispatcherOptions,
} from "../semantic-tools/dispatcher.js";
import type { CapabilitySemanticToolResult } from "../semantic-tools/types.js";
import {
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
  semanticAuthorizationBoundaryForCode,
  semanticOutcomeForCode,
} from "../protocol/semantic-tool-receipts.js";
import type {
  SemanticConformanceAdapter,
  SemanticConformanceJsonValue,
  SemanticConformanceObservation,
  SemanticConformanceVector,
} from "./semantic-conformance.js";

export const CAPABILITY_SEMANTIC_CONFORMANCE_IDS = Object.freeze({
  companyId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  defaultTaskId: "10000000-0000-4000-8000-000000000003",
  crossCompanyTaskId: "10000000-0000-4000-8000-000000000004",
  interactionTaskId: "10000000-0000-4000-8000-000000000005",
  terminalTaskId: "10000000-0000-4000-8000-000000000006",
  blockedTerminalTaskId: "10000000-0000-4000-8000-000000000007",
  blockerTaskId: "10000000-0000-4000-8000-000000000008",
  foreignTaskId: "20000000-0000-4000-8000-000000000001",
  defaultRunId: "10000000-0000-4000-8000-000000000011",
  crossCompanyRunId: "10000000-0000-4000-8000-000000000012",
  interactionRunId: "10000000-0000-4000-8000-000000000013",
  terminalRunId: "10000000-0000-4000-8000-000000000014",
  blockedTerminalRunId: "10000000-0000-4000-8000-000000000015",
});

/**
 * Shared, risk-ordered contract vectors. These intentionally exercise writes
 * and denials rather than duplicating the PRP event-persistence conformance
 * suite in control-plane-port.ts.
 */
export const CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS = Object.freeze([
  {
    id: "governed-action-without-claim",
    worldId: "default",
    operationId: "decide_approval",
    input: {
      idempotencyKey: "governed-denial",
      approvalId: "10000000-0000-4000-8000-000000000099",
      decision: "approved",
      note: "Attempt without authority.",
    },
  },
  {
    id: "protected-input-redaction",
    worldId: "default",
    operationId: "report_progress",
    input: {
      idempotencyKey: "protected-input",
      body: "Authorization: Bearer test-placeholder-token",
    },
  },
  {
    id: "cross-company-dependency-denial",
    worldId: "cross-company",
    operationId: "set_dependencies",
    input: {
      idempotencyKey: "cross-company-dependency",
      blockedByTaskIds: [CAPABILITY_SEMANTIC_CONFORMANCE_IDS.foreignTaskId],
    },
  },
  {
    id: "progress-applied",
    worldId: "default",
    operationId: "report_progress",
    input: { idempotencyKey: "progress-once", body: "Durable progress." },
  },
  {
    id: "progress-duplicate-retry",
    worldId: "default",
    operationId: "report_progress",
    input: { idempotencyKey: "progress-once", body: "Durable progress." },
  },
  {
    id: "progress-idempotency-conflict",
    worldId: "default",
    operationId: "report_progress",
    input: { idempotencyKey: "progress-once", body: "Conflicting retry." },
  },
  {
    id: "document-create",
    worldId: "default",
    operationId: "write_document",
    input: {
      idempotencyKey: "document-create",
      key: "plan",
      title: "Plan",
      body: "Revision one.",
      baseRevisionId: null,
      changeSummary: "Create plan.",
    },
  },
  {
    id: "document-stale-revision",
    worldId: "default",
    operationId: "write_document",
    input: {
      idempotencyKey: "document-stale",
      key: "plan",
      title: "Plan",
      body: "Stale overwrite.",
      baseRevisionId: "00000000-0000-4000-8000-000000000099",
      changeSummary: "Stale update.",
    },
  },
  {
    id: "continuation-request",
    worldId: "interaction",
    operationId: "request_human_input",
    input: {
      idempotencyKey: "continuation-request",
      interactionKind: "confirmation",
      title: "Confirm direction",
      prompt: "Continue with the proposed direction?",
      payload: {},
      targetRevisionId: null,
      continuationPolicy: "wake_assignee",
    },
  },
  {
    id: "terminal-with-dependency",
    worldId: "terminal-blocked",
    operationId: "finish_task",
    input: { idempotencyKey: "terminal-with-dependency", summary: "Independent work is complete." },
  },
  {
    id: "terminal-finish",
    worldId: "terminal",
    operationId: "finish_task",
    input: { idempotencyKey: "terminal-finish", summary: "Semantic work complete." },
  },
] as const satisfies readonly SemanticConformanceVector[]);

export interface CapabilityMockSemanticConformanceWorld {
  readonly id: string;
  readonly seed: CapabilityFixtureSeed;
  readonly run: CapabilityOpenFixtureRunInput;
  readonly dispatcherOptions?: CapabilitySemanticDispatcherOptions;
}

interface OpenMockWorld {
  readonly port: CapabilityMockControlPlaneAdapter;
  readonly dispatcher: CapabilitySemanticDispatcher;
  readonly runId: string;
  readonly taskId: string;
}

/** Test-only semantic adapter backed by the deterministic capability mock. */
export class CapabilityMockSemanticConformanceAdapter implements SemanticConformanceAdapter {
  readonly id = "capability-mock";
  readonly kind = "mock" as const;

  private constructor(readonly worlds: ReadonlyMap<string, OpenMockWorld>) {}

  static async create(
    worlds: readonly CapabilityMockSemanticConformanceWorld[] = capabilityMockConformanceWorlds(),
  ): Promise<CapabilityMockSemanticConformanceAdapter> {
    const opened = new Map<string, OpenMockWorld>();
    for (const world of worlds) {
      const port = new CapabilityMockControlPlaneAdapter(world.seed);
      await port.start();
      await port.openFixtureRun(world.run);
      opened.set(world.id, {
        port,
        dispatcher: new CapabilitySemanticDispatcher(port, world.dispatcherOptions),
        runId: world.run.identity.runId,
        taskId: world.run.identity.issueId,
      });
    }
    return new CapabilityMockSemanticConformanceAdapter(opened);
  }

  async execute(vector: SemanticConformanceVector): Promise<SemanticConformanceObservation> {
    const worldId = vector.worldId ?? "default";
    const world = this.worlds.get(worldId);
    if (world === undefined) throw new Error(`semantic_conformance_world_missing:${worldId}`);
    const before = world.port.snapshot();
    const result = await world.dispatcher.dispatch({
      runId: world.runId,
      callId: vector.id,
      operationId: vector.operationId,
      input: vector.input,
    });
    const after = world.port.snapshot();
    return normalizeCapabilitySemanticObservation({
      result,
      before,
      after,
      taskId: world.taskId,
      semanticInput: vector.input,
    });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.worlds.values()].map(({ port }) => port.stop()));
  }
}

export function capabilityMockConformanceWorlds(): readonly CapabilityMockSemanticConformanceWorld[] {
  const ids = CAPABILITY_SEMANTIC_CONFORMANCE_IDS;
  return [
    mockWorld("default", ids.defaultTaskId, ids.defaultRunId, []),
    mockWorld(
      "cross-company",
      ids.crossCompanyTaskId,
      ids.crossCompanyRunId,
      ["dependencies:write"],
      [ids.foreignTaskId],
    ),
    mockWorld("interaction", ids.interactionTaskId, ids.interactionRunId, []),
    mockWorld(
      "terminal-blocked",
      ids.blockedTerminalTaskId,
      ids.blockedTerminalRunId,
      [],
      [],
      ids.blockerTaskId,
    ),
    mockWorld("terminal", ids.terminalTaskId, ids.terminalRunId, []),
  ];
}

export function normalizeCapabilitySemanticObservation(input: {
  readonly result: CapabilitySemanticToolResult;
  readonly before: Readonly<CapabilityFixtureState>;
  readonly after: Readonly<CapabilityFixtureState>;
  readonly taskId: string;
  readonly semanticInput: unknown;
}): SemanticConformanceObservation {
  const { result, before, after, taskId } = input;
  const run = after.runs.find((candidate) => candidate.taskId === taskId);
  if (run === undefined) throw new Error(`semantic_conformance_run_missing:${taskId}`);
  const idempotencyKey = idempotencyKeyFrom(input.semanticInput);
  const disposition = result.ok && isRecord(result.result) ? result.result.disposition : undefined;
  const code = result.ok && disposition === "duplicate"
    ? "duplicate"
    : result.ok
      ? "ok"
      : result.denial.controlPlaneCode ?? result.denial.code;
  const effects = result.ok ? normalizeEffects(result.result) : [];
  const authorization = result.ok
    ? { outcome: "allowed" as const }
    : {
        outcome: "denied" as const,
        code,
      };
  const envelopeBase = {
    operationId: result.operationId,
    callId: result.callId,
    correlation: {
      runId: run.id,
      normalizedSessionId: run.sessionId,
      turnId: `turn:${result.callId}`,
      itemId: `item:${result.callId}`,
    },
    idempotencyKey,
  };
  const inputReceipt = createPrpSemanticToolInputEnvelope({
    ...envelopeBase,
    content: input.semanticInput,
  });
  const receipt = createPrpSemanticToolResultEnvelope({
    ...envelopeBase,
    content: { authorization, effects },
    outcome: semanticOutcomeForCode({
      ok: result.ok,
      code,
      disposition,
    }),
    code,
    retryable: result.ok ? false : result.denial.retryable,
    authorizationBoundary: semanticAuthorizationBoundaryForCode(code),
    ...(after.audit.length <= before.audit.length
      ? {}
      : { auditReceiptId: after.audit.at(-1)?.id }),
    currentRevision: result.stateRevision,
  });
  return Object.freeze({
    authorization,
    state: projectSemanticState(after, taskId),
    effects,
    audit: after.audit.length > before.audit.length
      ? [{ outcome: "recorded" as const }]
      : [],
    receipt: {
      schema: receipt.schema,
      schemaVersion: receipt.schemaVersion,
      phase: "result" as const,
      operationId: receipt.operationId,
      callId: receipt.callId,
      idempotencyKeyPresent: receipt.idempotencyKey !== null,
      outcome: String(receipt.outcome),
      code: String(receipt.code),
      retryable: receipt.retryable === true,
      authorizationBoundary: String(receipt.authorizationBoundary),
      operationReceiptPresent: typeof receipt.operationReceiptId === "string",
      inputDigestPresent: typeof inputReceipt.content.digest === "string",
      outputDigestPresent: typeof receipt.content.digest === "string",
      currentRevisionPresent: receipt.currentRevision !== undefined,
    },
  });
}

function projectSemanticState(
  state: Readonly<CapabilityFixtureState>,
  taskId: string,
): SemanticConformanceJsonValue {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`semantic_conformance_task_missing:${taskId}`);
  return {
    task: { status: task.status },
    comments: state.comments
      .filter((comment) => comment.taskId === taskId)
      .map((comment) => comment.body),
    documents: state.documents
      .filter((document) => document.taskId === taskId)
      .map((document) => ({
        key: document.key,
        title: document.title,
        body: document.revisions.find((revision) => revision.id === document.latestRevisionId)?.body ?? "",
        revisionCount: document.revisions.length,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    dependencies: state.blockers
      .filter((blocker) => blocker.taskId === taskId)
      .map((blocker) => blocker.blockedByTaskId)
      .sort((left, right) => left.localeCompare(right)),
    interactions: state.interactions
      .filter((interaction) => interaction.taskId === taskId)
      .map((interaction) => ({
        kind: interaction.kind,
        status: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        targetBound: interaction.targetRevisionId !== null,
      })),
    wakes: state.wakes
      .filter((wake) => wake.taskId === taskId)
      .map((wake) => ({ reason: wake.reason, status: wake.status })),
  };
}

function normalizeEffects(
  result: unknown,
): readonly SemanticConformanceJsonValue[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  const entityRefs = Array.isArray(record.entityRefs)
    ? record.entityRefs.filter((value): value is string => typeof value === "string")
    : [];
  const scheduledWakeIds = Array.isArray(record.scheduledWakeIds) ? record.scheduledWakeIds : [];
  return [{
    disposition:
      typeof record.disposition === "string" ? record.disposition : null,
    entityKinds: [...new Set(entityRefs.map((reference) => reference.split(":", 1)[0]))].sort(),
    scheduledWakeCount: scheduledWakeIds.length,
  }];
}

function idempotencyKeyFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0
    ? value.idempotencyKey
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mockWorld(
  id: string,
  taskId: string,
  runId: string,
  capabilities: string[],
  outOfScopeTaskIds: string[] = [],
  blockerTaskId?: string,
): CapabilityMockSemanticConformanceWorld {
  const ids = CAPABILITY_SEMANTIC_CONFORMANCE_IDS;
  const activeTask = {
    id: taskId,
    companyId: ids.companyId,
    identifier: `SCF-${id}`,
    title: `${id} semantic fixture`,
    description: null,
    status: "todo" as const,
    priority: "medium" as const,
    workMode: "standard" as const,
    parentId: null,
    assigneeActorId: ids.actorId,
    checkoutRunId: null,
    executionRunId: null,
    startedAt: null,
    completedAt: null,
  };
  return {
    id,
    seed: {
      company: { id: ids.companyId, name: "Semantic Conformance", issuePrefix: "SCF" },
      actors: [{
        id: ids.actorId,
        companyId: ids.companyId,
        name: "Conformance Engineer",
        role: "approver",
        status: "active",
        budgetId: `budget-${id}`,
        capabilityGrants: capabilities,
      }],
      tasks: blockerTaskId === undefined
        ? [activeTask]
        : [activeTask, {
            ...activeTask,
            id: blockerTaskId,
            identifier: "SCF-blocker",
            title: "Unresolved semantic blocker",
            assigneeActorId: null,
          }],
      blockers: blockerTaskId === undefined ? [] : [{
        id: "fixture-blocker-terminal",
        taskId,
        blockedByTaskId: blockerTaskId,
        createdAt: "2026-08-09T00:00:00.000Z",
      }],
      outOfScopeTaskIds,
    },
    run: {
      identity: {
        companyId: ids.companyId,
        agentId: ids.actorId,
        issueId: taskId,
        runId,
        sessionId: `session-${id}`,
      },
      backendKind: "mock",
      sourceInstanceId: "semantic-conformance",
      capabilities,
    },
  };
}
