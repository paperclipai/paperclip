import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecrets,
  deliveryEvents,
  externalOperations,
  heartbeatRuns,
  issues,
  issueWorkProducts,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  DELIVERY_STAGES,
  type CreateDeliveryEvent,
  type CreateExternalOperation,
  type DeliveryEventAuthority,
  type DeliveryEvidenceExpectationsV1,
  type DeliveryEventSourceKind,
  type DeliveryEventState,
  type DeliveryEventV1,
  type DeliveryFactoryParticipantV1,
  type DeliveryFactoryProvenanceV1,
  type DeliverySnapshotV1,
  type DeliveryStage,
  type ExternalOperationState,
  type ExternalOperationV1,
  type IssueExecutionPolicy,
  type IssueExecutionState,
  type UpdateExternalOperation,
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultExternalOperationVerifiers,
  ExternalProviderAttestationError,
  type ExternalOperationVerifier,
  type ExternalProviderVerification,
} from "./delivery-verifiers.js";
import { githubApiBase, githubConnectionService } from "./github-connections.js";
import { secretService } from "./secrets.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { readExternalOperationControllerAttemptMinutes } from "./external-operation-liveness.js";

type DeliveryEventRow = typeof deliveryEvents.$inferSelect;
type ExternalOperationRow = typeof externalOperations.$inferSelect;

const MAX_EXTERNAL_OPERATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROVIDER_OBSERVATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RESERVED_DELIVERY_METADATA_KEYS = new Set(["paperclipFactory", "paperclipController"]);
const FACTORY_STAGE_DELIVERY_STAGES: Readonly<Record<string, readonly DeliveryStage[]>> = {
  contract: [],
  implementation: ["implementation", "ci"],
  independent_qa: ["functional_qa"],
  technical_acceptance: ["technical_acceptance"],
  deployment: ["deployment"],
  live_qa: ["smoke"],
  final_acceptance: ["business_acceptance"],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeCandidateSha(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function candidateShasMatch(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = normalizeCandidateSha(left);
  const normalizedRight = normalizeCandidateSha(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
}

function canonicalCandidateSha(value: string | null | undefined) {
  const normalized = normalizeCandidateSha(value);
  return normalized && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized) ? normalized : null;
}

function deliveryFactoryProvenance(metadata: unknown): DeliveryFactoryProvenanceV1 | null {
  const factory = asRecord(asRecord(metadata).paperclipFactory);
  const participant = asRecord(factory.participant);
  const stageId = typeof factory.stageId === "string" ? factory.stageId : null;
  const stageRevision = typeof factory.stageRevision === "number" && Number.isInteger(factory.stageRevision)
    ? factory.stageRevision
    : null;
  const participantType = participant.type === "agent" || participant.type === "user"
    ? participant.type
    : null;
  if (factory.version !== 1 || !stageId || stageRevision === null || !participantType) return null;
  return {
    version: 1,
    stageId,
    stageKey: typeof factory.stageKey === "string" ? factory.stageKey : null,
    stageRevision,
    stageActivatedAt: typeof factory.stageActivatedAt === "string" ? factory.stageActivatedAt : null,
    participant: {
      type: participantType,
      agentId: typeof participant.agentId === "string" ? participant.agentId : null,
      userId: typeof participant.userId === "string" ? participant.userId : null,
    },
  };
}

function factoryParticipantsEqual(
  left: DeliveryFactoryParticipantV1,
  right: DeliveryFactoryParticipantV1,
) {
  return left.type === right.type
    && left.agentId === right.agentId
    && left.userId === right.userId;
}

function assertNoReservedDeliveryMetadata(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return;
  const reserved = Object.keys(metadata).find((key) => RESERVED_DELIVERY_METADATA_KEYS.has(key));
  if (reserved) throw unprocessable(`${reserved} is server-owned delivery metadata`);
}

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unprocessable("Provider evidence URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw unprocessable("Provider evidence URL must use HTTP or HTTPS");
  }
  return value;
}

export type DeliveryActor = {
  actorType: "agent" | "user" | "system";
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type AppendVerifiedDeliveryEvent = Omit<CreateDeliveryEvent, "observedAt"> & {
  observedAt: Date;
  sourceFingerprint: string;
};

type InternalDeliveryEventInput = CreateDeliveryEvent & { observedAt?: Date };

export type DeliveryCredentialResolver = (
  operation: ExternalOperationV1,
  actor: DeliveryActor,
) => Promise<{ credential: string; apiBase?: string }>;

function dateValue(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function toDeliveryEvent(row: DeliveryEventRow): DeliveryEventV1 {
  return {
    version: 1,
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    stage: row.stage as DeliveryStage,
    state: row.state as DeliveryEventState,
    candidateSha: row.candidateSha,
    environment: row.environment,
    provider: row.provider,
    providerExternalId: row.providerExternalId,
    providerUrl: row.providerUrl,
    sourceKind: row.sourceKind as DeliveryEventSourceKind,
    authority: row.authority as DeliveryEventAuthority,
    summary: row.summary,
    metadata: row.metadata,
    sourceFingerprint: row.sourceFingerprint,
    sourceWorkProductId: row.sourceWorkProductId,
    supersedesEventId: row.supersedesEventId,
    observedAt: row.observedAt,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    createdAt: row.createdAt,
  };
}

function toExternalOperation(row: ExternalOperationRow): ExternalOperationV1 {
  return {
    version: 1,
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    kind: row.kind as ExternalOperationV1["kind"],
    provider: row.provider,
    stage: row.stage as DeliveryStage,
    externalId: row.externalId,
    supersedesOperationId: row.supersedesOperationId,
    candidateSha: row.candidateSha,
    environment: row.environment,
    url: row.url,
    state: row.state as ExternalOperationV1["state"],
    verificationStatus: row.verificationStatus as ExternalOperationV1["verificationStatus"],
    credentialSecretId: row.credentialSecretId,
    nextCheckAt: row.nextCheckAt,
    timeoutAt: row.timeoutAt,
    terminalAt: row.terminalAt,
    lastVerifiedAt: row.lastVerifiedAt,
    lastVerificationError: row.lastVerificationError,
    metadata: row.metadata,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const EXTERNAL_FACT_STAGES = new Set<DeliveryStage>(["ci", "deployment", "smoke"]);
const ACCEPTANCE_STAGES = new Set<DeliveryStage>(["technical_acceptance", "business_acceptance"]);

function authorityRank(stage: DeliveryStage, authority: DeliveryEventAuthority) {
  if (ACCEPTANCE_STAGES.has(stage)) {
    return {
      user_asserted: 600,
      paperclip_verified: 500,
      provider_verified: 400,
      agent_claim: 200,
      legacy_unverified: 100,
    }[authority];
  }
  if (EXTERNAL_FACT_STAGES.has(stage)) {
    return {
      provider_verified: 600,
      paperclip_verified: 500,
      user_asserted: 400,
      agent_claim: 200,
      legacy_unverified: 100,
    }[authority];
  }
  return {
    paperclip_verified: 600,
    provider_verified: 550,
    user_asserted: 500,
    agent_claim: 200,
    legacy_unverified: 100,
  }[authority];
}

function globalAuthorityRank(authority: DeliveryEventAuthority) {
  return {
    provider_verified: 500,
    paperclip_verified: 400,
    user_asserted: 300,
    agent_claim: 200,
    legacy_unverified: 100,
  }[authority];
}

function newestFirst(left: DeliveryEventV1, right: DeliveryEventV1) {
  const observed = right.observedAt.getTime() - left.observedAt.getTime();
  if (observed !== 0) return observed;
  const created = right.createdAt.getTime() - left.createdAt.getTime();
  if (created !== 0) return created;
  return right.id.localeCompare(left.id);
}

function stableEventPayload(event: DeliveryEventV1) {
  return {
    id: event.id,
    stage: event.stage,
    state: event.state,
    candidateSha: event.candidateSha,
    environment: event.environment,
    provider: event.provider,
    providerExternalId: event.providerExternalId,
    providerUrl: event.providerUrl,
    sourceKind: event.sourceKind,
    authority: event.authority,
    summary: event.summary,
    metadata: event.metadata,
    sourceFingerprint: event.sourceFingerprint,
    sourceWorkProductId: event.sourceWorkProductId,
    supersedesEventId: event.supersedesEventId,
    observedAt: event.observedAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  };
}

/** Pure, deterministic event-to-state projection used by APIs and wake context. */
export function projectDeliverySnapshot(
  companyId: string,
  issueId: string,
  rawEvents: DeliveryEventV1[],
  supersededOperationIds: ReadonlySet<string> = new Set(),
): DeliverySnapshotV1 {
  const events = rawEvents
    .filter((event) => event.companyId === companyId && event.issueId === issueId)
    .map((event) => ({
      ...event,
      observedAt: dateValue(event.observedAt),
      createdAt: dateValue(event.createdAt),
    }));
  const superseded = new Set(
    events
      .map((event) => event.supersedesEventId)
      .filter((id): id is string => Boolean(id)),
  );
  // Provider observations remain immutable history, but an operation retry
  // removes its predecessor's observations from the current-state projection.
  // The ledger rows are still returned by listEvents and still contribute to
  // the snapshot revision/watermark.
  for (const event of events) {
    const operationId = typeof event.metadata?.operationId === "string"
      ? event.metadata.operationId
      : null;
    if (operationId && supersededOperationIds.has(operationId)) superseded.add(event.id);
  }
  const active = events.filter((event) => !superseded.has(event.id));
  const factoryEvidencePresent = active.some((event) => deliveryFactoryProvenance(event.metadata) !== null);
  const implementationAnchors = active
    .filter((event) => event.stage === "implementation")
    .filter((event) => (
      Boolean(normalizeCandidateSha(event.candidateSha))
      && event.metadata?.candidateMismatch !== true
      && event.metadata?.stale !== true
    ))
    .sort((left, right) => {
      const leftRevision = deliveryFactoryProvenance(left.metadata)?.stageRevision ?? -1;
      const rightRevision = deliveryFactoryProvenance(right.metadata)?.stageRevision ?? -1;
      if (leftRevision !== rightRevision) return rightRevision - leftRevision;
      const authority = authorityRank("implementation", right.authority) - authorityRank("implementation", left.authority);
      return authority !== 0 ? authority : newestFirst(left, right);
    });
  // Factory candidate identity is established by implementation evidence. A
  // later provider observation may confirm that identity, but never redefine it.
  const candidateEvent = implementationAnchors[0] ?? (factoryEvidencePresent
    ? null
    : active
      .filter((event) => (
        Boolean(normalizeCandidateSha(event.candidateSha))
        && event.metadata?.candidateMismatch !== true
        && event.metadata?.stale !== true
      ))
      .sort((left, right) => {
        const authority = globalAuthorityRank(right.authority) - globalAuthorityRank(left.authority);
        return authority !== 0 ? authority : newestFirst(left, right);
      })[0] ?? null);
  const candidateSha = normalizeCandidateSha(candidateEvent?.candidateSha);
  const environment = candidateEvent?.environment
    ?? active.filter((event) => event.environment).sort(newestFirst)[0]?.environment
    ?? null;

  const stages = Object.fromEntries(DELIVERY_STAGES.map((stage) => {
    const candidates = active
      .filter((event) => event.stage === stage)
      .sort((left, right) => {
        const leftRevision = deliveryFactoryProvenance(left.metadata)?.stageRevision ?? -1;
        const rightRevision = deliveryFactoryProvenance(right.metadata)?.stageRevision ?? -1;
        if (leftRevision !== rightRevision) return rightRevision - leftRevision;
        const authority = authorityRank(stage, right.authority) - authorityRank(stage, left.authority);
        return authority !== 0 ? authority : newestFirst(left, right);
      });
    const selected = candidates.find((event) => (
      event.metadata?.candidateMismatch !== true
      && event.metadata?.stale !== true
      && (!candidateSha || candidateShasMatch(event.candidateSha, candidateSha))
    )) ?? candidates[0] ?? null;
    const selectedCandidateMismatch = Boolean(
      selected
      && candidateSha
      && !candidateShasMatch(selected.candidateSha, candidateSha),
    );
    return [stage, {
      stage,
      state: selected?.state ?? "unknown",
      eventId: selected?.id ?? null,
      authority: selected?.authority ?? null,
      candidateSha: normalizeCandidateSha(selected?.candidateSha) ?? candidateSha,
      environment: selected ? selected.environment : environment,
      provider: selected?.provider ?? null,
      providerExternalId: selected?.providerExternalId ?? null,
      providerUrl: selected?.providerUrl ?? null,
      observedAt: selected?.observedAt ?? null,
      stale: selected?.metadata?.stale === true
        || selected?.metadata?.candidateMismatch === true
        || selectedCandidateMismatch,
      paperclipFactory: deliveryFactoryProvenance(selected?.metadata),
    }];
  })) as DeliverySnapshotV1["stages"];

  const ordered = [...events].sort((left, right) => {
    const created = left.createdAt.getTime() - right.createdAt.getTime();
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
  const watermarkEvent = ordered.at(-1) ?? null;
  const revision = createHash("sha256")
    .update(JSON.stringify({
      events: ordered.map(stableEventPayload),
      supersededOperationIds: [...supersededOperationIds].sort(),
    }))
    .digest("hex");

  return {
    version: 1,
    companyId,
    issueId,
    revision: `sha256:${revision}`,
    watermark: {
      eventId: watermarkEvent?.id ?? null,
      createdAt: watermarkEvent?.createdAt ?? null,
      eventCount: events.length,
    },
    candidateSha,
    environment,
    stages,
    activeEventIds: active.map((event) => event.id).sort(),
    supersededEventIds: [...superseded].sort(),
  };
}

export type DeliveryEvidenceGateResult = {
  gate: string;
  satisfied: boolean;
  reason: string | null;
};

/**
 * Gate format: delivery:<stage>:<state>[:<authority>]. A stage observation is
 * usable only when it is current, event-backed, and not legacy-unverified.
 */
export function evaluateDeliveryEvidenceGate(
  snapshot: DeliverySnapshotV1,
  gate: string,
  expectations: DeliveryEvidenceExpectationsV1 = {},
): DeliveryEvidenceGateResult {
  const [namespace, stageName, state, requiredAuthority, ...extra] = gate.split(":");
  if (
    namespace !== "delivery"
    || extra.length > 0
    || !DELIVERY_STAGES.includes(stageName as DeliveryStage)
    || !state
  ) {
    return { gate, satisfied: false, reason: "invalid_gate" };
  }
  const stage = snapshot.stages[stageName as DeliveryStage];
  if (!stage.eventId) return { gate, satisfied: false, reason: "missing_event" };
  if (stage.stale) return { gate, satisfied: false, reason: "stale_event" };
  if (stage.state !== state) return { gate, satisfied: false, reason: `state_${stage.state}` };
  if (!stage.authority || stage.authority === "legacy_unverified") {
    return { gate, satisfied: false, reason: "unverified_authority" };
  }
  if (requiredAuthority && stage.authority !== requiredAuthority) {
    return { gate, satisfied: false, reason: `authority_${stage.authority}` };
  }
  if (!snapshot.candidateSha) return { gate, satisfied: false, reason: "missing_candidate_anchor" };
  if (!stage.candidateSha) return { gate, satisfied: false, reason: "missing_candidate" };
  if (!candidateShasMatch(snapshot.candidateSha, stage.candidateSha)) {
    return { gate, satisfied: false, reason: "candidate_mismatch" };
  }
  if (expectations.candidateSha && !candidateShasMatch(expectations.candidateSha, stage.candidateSha)) {
    return { gate, satisfied: false, reason: "expected_candidate_mismatch" };
  }
  if (
    expectations.stageId !== undefined
    || expectations.stageRevision !== undefined
    || expectations.participant !== undefined
  ) {
    const provenance = stage.paperclipFactory;
    if (!provenance) return { gate, satisfied: false, reason: "missing_factory_provenance" };
    if (expectations.stageId != null && provenance.stageId !== expectations.stageId) {
      return { gate, satisfied: false, reason: "factory_stage_mismatch" };
    }
    if (expectations.stageRevision != null && provenance.stageRevision !== expectations.stageRevision) {
      return { gate, satisfied: false, reason: "factory_stage_revision_mismatch" };
    }
    if (expectations.participant && !factoryParticipantsEqual(provenance.participant, expectations.participant)) {
      return { gate, satisfied: false, reason: "factory_participant_mismatch" };
    }
  }
  return { gate, satisfied: true, reason: null };
}

export function evaluateDeliveryEvidenceGates(
  snapshot: DeliverySnapshotV1,
  gates: readonly string[],
  expectationsByStage: Partial<Record<DeliveryStage, DeliveryEvidenceExpectationsV1>> = {},
) {
  return gates.map((gate) => {
    const stage = gate.split(":")[1] as DeliveryStage | undefined;
    return evaluateDeliveryEvidenceGate(snapshot, gate, stage ? expectationsByStage[stage] : undefined);
  });
}

/**
 * Bind each delivery stage to the first workflow stage that introduced its
 * exact gate. Later review/acceptance stages may consume the same gate, but
 * must not relabel older evidence as if the later participant produced it.
 */
export function buildFactoryDeliveryEvidenceExpectations(input: {
  policy: IssueExecutionPolicy;
  state: IssueExecutionState;
  candidateSha: string | null;
}) {
  const expectations: Partial<Record<DeliveryStage, DeliveryEvidenceExpectationsV1>> = {};
  for (const stage of input.policy.stages) {
    for (const gate of stage.evidenceGates ?? []) {
      const [namespace, deliveryStageRaw, gateState, requiredAuthority, ...extra] = gate.split(":");
      if (
        namespace !== "delivery"
        || !gateState
        || extra.length > 0
        || !DELIVERY_STAGES.includes(deliveryStageRaw as DeliveryStage)
        || expectations[deliveryStageRaw as DeliveryStage]
      ) {
        continue;
      }
      // Parsing the optional authority here makes the mapping exact even
      // though the expectation value is keyed by the delivery stage.
      if (requiredAuthority && !["provider_verified", "paperclip_verified", "user_asserted", "agent_claim", "legacy_unverified"].includes(requiredAuthority)) {
        continue;
      }
      const deliveryStage = deliveryStageRaw as DeliveryStage;
      const stageRevision = input.state.currentStageId === stage.id
        ? input.state.stageRevision ?? 0
        : input.state.completedStageRevisions?.[stage.id] ?? 0;
      if (stageRevision < 1) continue;
      const participant = input.state.currentStageId === stage.id
        ? input.state.currentParticipant
        : stage.participants[0] ?? null;
      if (!participant) continue;
      expectations[deliveryStage] = {
        candidateSha: input.candidateSha,
        stageId: stage.id,
        stageRevision,
        participant: {
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        },
      };
    }
  }
  return expectations;
}

/** Mark UI/read-model evidence stale when its producer activation is no longer current or completed. */
export function applyFactoryDeliverySnapshotFreshness(input: {
  snapshot: DeliverySnapshotV1;
  policy: IssueExecutionPolicy;
  state: IssueExecutionState;
}) {
  if (input.policy.factory?.laneKind !== "execution") return input.snapshot;
  const stages = Object.fromEntries(DELIVERY_STAGES.map((deliveryStage) => {
    const projected = input.snapshot.stages[deliveryStage];
    const provenance = projected.paperclipFactory;
    if (!provenance) return [deliveryStage, projected];
    const policyStageExists = input.policy.stages.some((stage) => stage.id === provenance.stageId);
    const expectedRevision = input.state.currentStageId === provenance.stageId
      ? input.state.stageRevision ?? 0
      : input.state.completedStageRevisions?.[provenance.stageId] ?? 0;
    return [deliveryStage, {
      ...projected,
      stale: projected.stale || !policyStageExists || expectedRevision < 1 || expectedRevision !== provenance.stageRevision,
    }];
  })) as DeliverySnapshotV1["stages"];
  return { ...input.snapshot, stages };
}

function terminalOperationState(state: ExternalOperationState) {
  return ["succeeded", "failed", "cancelled", "timed_out"].includes(state);
}

function deliveryEventFingerprint(operation: ExternalOperationV1, result: ExternalProviderVerification) {
  return createHash("sha256")
    .update(JSON.stringify({
      operationId: operation.id,
      provider: result.provider,
      externalId: result.externalId,
      state: result.eventState,
      candidateSha: result.candidateSha,
      environment: result.environment,
      startedAt: result.startedAt?.toISOString() ?? null,
      observedAt: result.observedAt.toISOString(),
    }))
    .digest("hex");
}

function sourceAuthorityInvariant(sourceKind: DeliveryEventSourceKind, authority: DeliveryEventAuthority) {
  return (
    sourceKind === "provider_observation" && authority === "provider_verified"
    || sourceKind === "paperclip_action" && authority === "paperclip_verified"
    || sourceKind === "user_submission" && authority === "user_asserted"
    || sourceKind === "agent_submission" && authority === "agent_claim"
    || sourceKind === "legacy_backfill" && authority === "legacy_unverified"
  );
}

/** Serialize delivery-ledger reads and writes that participate in completion decisions. */
export async function acquireIssueDeliveryLock(executor: Db, companyId: string, issueId: string) {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${issueId}:delivery`}, 0))`,
  );
}

function legacyStage(type: string): DeliveryStage {
  if (type === "preview_url" || type === "runtime_service") return "deployment";
  if (type === "artifact") return "ci";
  if (type === "document") return "functional_qa";
  return "implementation";
}

function legacyState(status: string): DeliveryEventState {
  const normalized = status.trim().toLowerCase();
  if (["failed", "closed", "changes_requested"].includes(normalized)) return "failed";
  if (["approved", "merged", "ready_for_review", "active"].includes(normalized)) return "succeeded";
  return "unknown";
}

export function deliveryService(
  db: Db,
  options: {
    verifiers?: Map<string, ExternalOperationVerifier>;
    resolveCredential?: DeliveryCredentialResolver;
  } = {},
) {
  const verifiers = options.verifiers ?? defaultExternalOperationVerifiers();

  async function runWithIssueDeliveryLock<T>(
    companyId: string,
    issueId: string,
    work: (executor: Db) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      const executor = tx as unknown as Db;
      await acquireIssueDeliveryLock(executor, companyId, issueId);
      return work(executor);
    });
  }

  async function getIssueScope(companyId: string, issueId: string, executor: Db = db) {
    return executor
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueScope(companyId: string, issueId: string, executor: Db = db) {
    const issue = await getIssueScope(companyId, issueId, executor);
    if (!issue) throw notFound("Issue not found");
    return issue;
  }

  async function assertMutationNotHeld(companyId: string, issueId: string, executor: Db = db) {
    const treeControl = issueTreeControlService(executor);
    const pauseHold = await treeControl.getActivePauseHoldGate(companyId, issueId);
    if (pauseHold) {
      throw conflict("This issue is paused by an active tree hold.", {
        code: "issue_tree_paused",
        holdId: pauseHold.holdId,
        rootIssueId: pauseHold.rootIssueId,
      });
    }
    const cancelHold = await treeControl.getActiveCancelHoldGate(companyId, issueId);
    if (cancelHold) {
      throw conflict("This issue is cancelled by an active tree hold.", {
        code: "issue_tree_cancelled",
        holdId: cancelHold.holdId,
        rootIssueId: cancelHold.rootIssueId,
      });
    }
  }

  async function assertActiveFactoryAgentRun(
    executor: Db,
    issue: Awaited<ReturnType<typeof assertIssueScope>>,
    actor: DeliveryActor,
  ) {
    if (actor.actorType !== "agent") return;
    if (!actor.agentId || !actor.runId) throw unauthorizedFactoryMutation("Factory agent evidence requires an active run");
    const run = await executor
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, actor.runId),
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
        eq(heartbeatRuns.status, "running"),
      ))
      .then((rows) => rows[0] ?? null);
    const context = asRecord(run?.contextSnapshot);
    if (
      !run
      || ![context.issueId, context.taskId, context.sourceIssueId].includes(issue.id)
    ) {
      throw unauthorizedFactoryMutation("Factory agent run is not active for this issue");
    }
  }

  function unauthorizedFactoryMutation(message: string): never {
    throw conflict(message, { code: "factory_delivery_context_conflict" });
  }

  async function assertCurrentFactoryMutation(input: {
    executor: Db;
    issue: Awaited<ReturnType<typeof assertIssueScope>>;
    actor: DeliveryActor;
    provenance: DeliveryFactoryProvenanceV1;
    deliveryStage: DeliveryStage;
    candidateSha: string | null | undefined;
  }) {
    const parsedPolicy = issueExecutionPolicySchema.safeParse(input.issue.executionPolicy);
    const parsedState = issueExecutionStateSchema.safeParse(input.issue.executionState);
    if (
      !parsedPolicy.success
      || parsedPolicy.data.factory?.laneKind !== "execution"
      || !parsedState.success
    ) {
      unauthorizedFactoryMutation("Factory delivery evidence requires a valid execution-lane snapshot");
    }
    const state = parsedState.data;
    const stage = parsedPolicy.data.stages.find((candidate) => candidate.id === state.currentStageId);
    const participant = state.currentParticipant;
    if (
      !stage
      || !participant
      || state.status === "idle"
      || state.status === "completed"
      || state.stageRevision < 1
      || input.provenance.stageId !== stage.id
      || input.provenance.stageKey !== (stage.key ?? null)
      || input.provenance.stageRevision !== state.stageRevision
      || input.provenance.stageActivatedAt !== state.currentStageActivatedAt
      || !factoryParticipantsEqual(input.provenance.participant, {
        type: participant.type,
        agentId: participant.type === "agent" ? participant.agentId ?? null : null,
        userId: participant.type === "user" ? participant.userId ?? null : null,
      })
    ) {
      unauthorizedFactoryMutation("Factory delivery evidence is not bound to the active stage revision");
    }
    const actorMatches = participant.type === "agent"
      ? input.actor.actorType === "agent" && input.actor.agentId === participant.agentId
      : input.actor.actorType === "user" && input.actor.userId === participant.userId;
    if (!actorMatches) unauthorizedFactoryMutation("Only the active factory stage participant can record delivery evidence");
    await assertActiveFactoryAgentRun(input.executor, input.issue, input.actor);
    const allowedStages = stage.key ? FACTORY_STAGE_DELIVERY_STAGES[stage.key] : undefined;
    if (!allowedStages?.includes(input.deliveryStage)) {
      throw unprocessable("This delivery evidence stage is not owned by the active factory stage", {
        code: "factory_delivery_stage_forbidden",
        factoryStageId: stage.id,
        factoryStageKey: stage.key ?? null,
        deliveryStage: input.deliveryStage,
      });
    }
    const candidateSha = canonicalCandidateSha(input.candidateSha);
    if (!candidateSha) {
      throw unprocessable("Factory delivery evidence requires a candidate SHA", {
        code: "factory_candidate_required",
      });
    }
    const establishesCandidate = stage.key === "implementation" && input.deliveryStage === "implementation";
    if (establishesCandidate) {
      return { policy: parsedPolicy.data, state, stage, snapshot: null };
    }
    const [rows, supersededOperationIds] = await Promise.all([
      input.executor
        .select()
        .from(deliveryEvents)
        .where(and(
          eq(deliveryEvents.companyId, input.issue.companyId),
          eq(deliveryEvents.issueId, input.issue.id),
        )),
      readSupersededOperationIds(input.executor, input.issue.companyId, input.issue.id),
    ]);
    const snapshot = projectDeliverySnapshot(
      input.issue.companyId,
      input.issue.id,
      rows.map(toDeliveryEvent),
      supersededOperationIds,
    );
    if (!snapshot.candidateSha || !candidateShasMatch(snapshot.candidateSha, candidateSha)) {
      throw conflict("Factory delivery evidence does not match the implementation candidate", {
        code: "factory_candidate_conflict",
        expectedCandidateSha: snapshot.candidateSha,
        suppliedCandidateSha: candidateSha,
      });
    }
    return { policy: parsedPolicy.data, state, stage, snapshot };
  }

  async function assertFactoryOperationStageStillActive(
    executor: Db,
    operation: ExternalOperationV1,
  ) {
    const provenance = deliveryFactoryProvenance(operation.metadata);
    if (!provenance) return;
    const issue = await assertIssueScope(operation.companyId, operation.issueId, executor);
    const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    const state = issueExecutionStateSchema.safeParse(issue.executionState);
    const activeStage = policy.success && state.success
      ? policy.data.stages.find((stage) => stage.id === state.data.currentStageId) ?? null
      : null;
    if (
      !policy.success
      || policy.data.factory?.laneKind !== "execution"
      || !state.success
      || issue.status === "done"
      || issue.status === "cancelled"
      || state.data.status === "completed"
      || !activeStage
      || activeStage.id !== provenance.stageId
      || (activeStage.key ?? null) !== provenance.stageKey
      || state.data.stageRevision !== provenance.stageRevision
      || state.data.currentStageActivatedAt !== provenance.stageActivatedAt
    ) {
      throw conflict("Factory external operation no longer belongs to the active stage revision", {
        code: "factory_external_operation_stage_inactive",
        operationId: operation.id,
        stageId: provenance.stageId,
        stageRevision: provenance.stageRevision,
      });
    }
  }

  async function assertFactoryOperationCanonicalHead(
    executor: Db,
    operation: ExternalOperationV1,
  ) {
    if (!deliveryFactoryProvenance(operation.metadata)) return;
    const successor = await executor
      .select({ id: externalOperations.id })
      .from(externalOperations)
      .where(and(
        eq(externalOperations.companyId, operation.companyId),
        eq(externalOperations.issueId, operation.issueId),
        eq(externalOperations.supersedesOperationId, operation.id),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (successor) {
      throw conflict("Factory external operation has been superseded by a retry", {
        code: "factory_external_operation_superseded",
        operationId: operation.id,
        successorOperationId: successor.id,
      });
    }
  }

  async function readSupersededOperationIds(
    executor: Db,
    companyId: string,
    issueId: string,
  ) {
    const rows = await executor
      .select({ id: externalOperations.supersedesOperationId })
      .from(externalOperations)
      .where(and(
        eq(externalOperations.companyId, companyId),
        eq(externalOperations.issueId, issueId),
        isNotNull(externalOperations.supersedesOperationId),
      ));
    return new Set(rows.flatMap((row) => row.id ? [row.id] : []));
  }

  async function assertCredentialSecret(companyId: string, credentialSecretId: string | null | undefined) {
    if (!credentialSecretId) return;
    const secret = await db
      .select({ id: companySecrets.id, status: companySecrets.status })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, credentialSecretId)))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.status !== "active") {
      throw unprocessable("Credential secret must be active and belong to the issue company");
    }
  }

  async function appendEventLocked(executor: Db, input: {
    companyId: string;
    issueId: string;
    event: InternalDeliveryEventInput;
    sourceKind: DeliveryEventSourceKind;
    authority: DeliveryEventAuthority;
    actor: DeliveryActor;
    sourceFingerprint?: string | null;
    sourceWorkProductId?: string | null;
    factoryProvenance?: DeliveryFactoryProvenanceV1 | null;
    allowReservedMetadata?: boolean;
  }) {
    if (!sourceAuthorityInvariant(input.sourceKind, input.authority)) {
      throw unprocessable("Delivery event source and authority do not match");
    }
    if (!input.allowReservedMetadata) assertNoReservedDeliveryMetadata(input.event.metadata);
    const issue = await assertIssueScope(input.companyId, input.issueId, executor);
    await assertMutationNotHeld(input.companyId, input.issueId, executor);
    if (input.sourceKind === "agent_submission" || input.sourceKind === "user_submission") {
      const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
      const factoryExecution = policy.success && policy.data.factory?.laneKind === "execution";
      if (factoryExecution && !input.factoryProvenance) {
        unauthorizedFactoryMutation("Factory delivery evidence requires server-stamped workflow provenance");
      }
      if (input.factoryProvenance) {
        const factoryContext = await assertCurrentFactoryMutation({
          executor,
          issue,
          actor: input.actor,
          provenance: input.factoryProvenance,
          deliveryStage: input.event.stage,
          candidateSha: input.event.candidateSha,
        });
        if (
          factoryContext.stage.key === "live_qa"
          && factoryContext.policy.factory?.production === true
        ) {
          const deployment = factoryContext.snapshot?.stages.deployment ?? null;
          if (
            !deployment
            || deployment.state !== "succeeded"
            || deployment.authority !== "provider_verified"
            || deployment.stale
            || deployment.environment?.trim().toLowerCase() !== "production"
            || !deployment.provider
            || !deployment.providerExternalId
            || !safeHttpUrl(deployment.providerUrl)
          ) {
            throw conflict("Production live QA requires a current provider-verified deployment target", {
              code: "factory_live_qa_deployment_target_required",
              issueId: input.issueId,
            });
          }
          // The provider-verified deployment snapshot, not the agent request,
          // owns the live-QA target identity.
          input.event = {
            ...input.event,
            environment: "production",
            provider: deployment.provider,
            providerExternalId: deployment.providerExternalId,
            providerUrl: deployment.providerUrl,
            metadata: {
              ...(input.event.metadata ?? {}),
              verifiedDeploymentEventId: deployment.eventId,
              verifiedDeploymentTarget: {
                environment: "production",
                provider: deployment.provider,
                externalId: deployment.providerExternalId,
                url: deployment.providerUrl,
              },
            },
          };
        }
      }
    }
    if (input.sourceFingerprint) {
      const idempotent = await executor
        .select()
        .from(deliveryEvents)
        .where(and(
          eq(deliveryEvents.companyId, input.companyId),
          eq(deliveryEvents.issueId, input.issueId),
          eq(deliveryEvents.sourceFingerprint, input.sourceFingerprint),
        ))
        .then((rows) => rows[0] ?? null);
      if (idempotent) return { event: toDeliveryEvent(idempotent), created: false };
    }
    if (input.event.supersedesEventId) {
      const prior = await executor
        .select({
          id: deliveryEvents.id,
          stage: deliveryEvents.stage,
          authority: deliveryEvents.authority,
          candidateSha: deliveryEvents.candidateSha,
        })
        .from(deliveryEvents)
        .where(and(
          eq(deliveryEvents.id, input.event.supersedesEventId),
          eq(deliveryEvents.companyId, input.companyId),
          eq(deliveryEvents.issueId, input.issueId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!prior) throw unprocessable("Superseded delivery event must belong to the same issue");
      if (prior.stage !== input.event.stage) {
        throw unprocessable("A delivery correction must supersede evidence from the same stage");
      }
      const priorCandidate = normalizeCandidateSha(prior.candidateSha);
      const nextCandidate = normalizeCandidateSha(input.event.candidateSha);
      if (
        (priorCandidate === null) !== (nextCandidate === null)
        || (priorCandidate !== null && !candidateShasMatch(priorCandidate, nextCandidate))
      ) {
        throw unprocessable("A delivery correction must preserve candidate lineage");
      }
      if (
        authorityRank(input.event.stage, input.authority)
        < authorityRank(prior.stage as DeliveryStage, prior.authority as DeliveryEventAuthority)
      ) {
        throw unprocessable("Lower-authority evidence cannot supersede authoritative delivery truth");
      }
      const existingCorrection = await executor
        .select({ id: deliveryEvents.id })
        .from(deliveryEvents)
        .where(and(
          eq(deliveryEvents.companyId, input.companyId),
          eq(deliveryEvents.issueId, input.issueId),
          eq(deliveryEvents.supersedesEventId, prior.id),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingCorrection) {
        throw conflict("Delivery evidence already has an append-only correction", {
          code: "delivery_correction_fork",
          supersedesEventId: prior.id,
          existingCorrectionEventId: existingCorrection.id,
        });
      }
    }

    const metadata = {
      ...(input.event.metadata ?? {}),
      ...(input.factoryProvenance ? { paperclipFactory: input.factoryProvenance } : {}),
    };

    const values = {
      companyId: input.companyId,
      issueId: input.issueId,
      stage: input.event.stage,
      state: input.event.state,
      candidateSha: normalizeCandidateSha(input.event.candidateSha),
      environment: input.event.environment ?? null,
      provider: input.event.provider ?? null,
      providerExternalId: input.event.providerExternalId ?? null,
      providerUrl: input.event.providerUrl ?? null,
      sourceKind: input.sourceKind,
      authority: input.authority,
      summary: input.event.summary ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      sourceFingerprint: input.sourceFingerprint ?? null,
      sourceWorkProductId: input.sourceWorkProductId ?? null,
      supersedesEventId: input.event.supersedesEventId ?? null,
      observedAt: input.sourceKind === "agent_submission" || input.sourceKind === "user_submission"
        ? new Date()
        : input.event.observedAt ?? new Date(),
      createdByAgentId: input.actor.agentId ?? null,
      createdByUserId: input.actor.userId ?? null,
      createdByRunId: input.actor.runId ?? null,
    };
    const [created] = await executor.insert(deliveryEvents).values(values).onConflictDoNothing().returning();
    if (created) return { event: toDeliveryEvent(created), created: true };
    if (!input.sourceFingerprint) throw conflict("Delivery event could not be appended");
    const existing = await executor
      .select()
      .from(deliveryEvents)
      .where(and(
        eq(deliveryEvents.companyId, input.companyId),
        eq(deliveryEvents.issueId, input.issueId),
        eq(deliveryEvents.sourceFingerprint, input.sourceFingerprint),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw conflict("Delivery event could not be appended");
    return { event: toDeliveryEvent(existing), created: false };
  }

  function appendEvent(input: Parameters<typeof appendEventLocked>[1]) {
    return runWithIssueDeliveryLock(input.companyId, input.issueId, (executor) => appendEventLocked(executor, input));
  }

  async function resolveVerificationCredential(
    operation: ExternalOperationV1,
    actor: DeliveryActor,
  ): Promise<{ credential: string; apiBase?: string }> {
    if (options.resolveCredential) return options.resolveCredential(operation, actor);
    const issue = await assertIssueScope(operation.companyId, operation.issueId);
    if (operation.kind === "github_actions_workflow_run") {
      if (!issue.projectId) throw unprocessable("GitHub verification requires an issue project");
      const connection = await githubConnectionService(db).resolveForProject({
        companyId: operation.companyId,
        projectId: issue.projectId,
        actorId: actor.agentId ?? null,
        issueId: issue.id,
        heartbeatRunId: actor.runId ?? null,
      });
      if (!connection) throw unprocessable("The issue project has no enabled GitHub connection");
      return { credential: connection.token, apiBase: githubApiBase(connection.hostname) };
    }
    if (operation.kind === "cloudflare_pages_deployment") {
      if (!operation.credentialSecretId) {
        throw unprocessable("Cloudflare verification requires an issue-bound credentialSecretId");
      }
      const credential = await secretService(db).resolveSecretValue(
        operation.companyId,
        operation.credentialSecretId,
        "latest",
        {
          consumerType: "issue",
          consumerId: operation.issueId,
          configPath: "delivery.cloudflare.api_token",
          actorType: actor.actorType,
          actorId: actor.agentId ?? actor.userId ?? null,
          issueId: operation.issueId,
          heartbeatRunId: actor.runId ?? null,
        },
      );
      return { credential };
    }
    throw unprocessable(`No provider verifier is registered for ${operation.provider}:${operation.kind}`);
  }

  function boundedOperationSchedule(
    input: CreateExternalOperation | UpdateExternalOperation,
    kind: ExternalOperationV1["kind"],
    now = new Date(),
    defaultFirstCheckDelayMs = 0,
    windowStartedAt = now,
  ) {
    const horizon = windowStartedAt.getTime() + MAX_EXTERNAL_OPERATION_WINDOW_MS;
    if (kind === "custom") {
      if (input.nextCheckAt !== undefined && input.nextCheckAt !== null) {
        throw unprocessable("Custom external operations cannot enable automatic polling without a registered verifier");
      }
      const timeoutAt = input.timeoutAt ?? null;
      if (timeoutAt && (timeoutAt.getTime() <= now.getTime() || timeoutAt.getTime() > horizon)) {
        throw unprocessable("External operation timeout must remain within 24 hours of registration");
      }
      return { nextCheckAt: null, timeoutAt };
    }
    const nextCheckAt = input.nextCheckAt ?? new Date(now.getTime() + defaultFirstCheckDelayMs);
    const timeoutAt = input.timeoutAt ?? new Date(horizon);
    if (!nextCheckAt || !timeoutAt) {
      throw unprocessable("Provider operations require a bounded polling schedule");
    }
    if (timeoutAt.getTime() <= now.getTime() || timeoutAt.getTime() > horizon) {
      throw unprocessable("External operation timeout must remain within 24 hours of registration");
    }
    if (nextCheckAt.getTime() > timeoutAt.getTime() || nextCheckAt.getTime() > horizon) {
      throw unprocessable("External operation next check must occur before its bounded timeout");
    }
    return { nextCheckAt, timeoutAt };
  }

  function factoryControllerMetadata(issue: Awaited<ReturnType<typeof assertIssueScope>>) {
    const parsed = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    const snapshot = parsed.success ? parsed.data.factory?.policySnapshot : null;
    if (!parsed.success || parsed.data.factory?.laneKind !== "execution" || !snapshot) {
      throw conflict("Factory external operations require the lane's immutable policy snapshot", {
        code: "factory_policy_snapshot_missing",
        issueId: issue.id,
      });
    }
    return {
      version: 1,
      attemptCount: 0,
      maxAttempts: snapshot.recovery.maxAttemptsPerEvidenceFingerprint,
      attemptMinutes: [...snapshot.recovery.attemptMinutes],
      status: "pending",
    };
  }

  function githubRepoFromUrl(value: string | null | undefined) {
    if (!value) return null;
    try {
      const parsed = new URL(value.includes("://") ? value : `https://${value}`);
      const host = parsed.hostname.trim().toLowerCase();
      if (!host) return null;
      const [owner, repoRaw] = parsed.pathname.replace(/^\/+/, "").split("/");
      const repo = repoRaw?.replace(/\.git$/i, "") ?? "";
      return owner && repo ? { host, fullName: `${owner}/${repo}`.toLowerCase() } : null;
    } catch {
      const scp = value.match(/^[^@]+@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
      return scp ? {
        host: scp[1]!.toLowerCase(),
        fullName: `${scp[2]}/${scp[3]}`.toLowerCase(),
      } : null;
    }
  }

  async function assertGithubProjectBinding(
    executor: Db,
    issue: Awaited<ReturnType<typeof assertIssueScope>>,
    metadata: Record<string, unknown> | null | undefined,
  ) {
    if (!issue.projectId) throw unprocessable("GitHub verification requires an issue project");
    const requestedOwner = typeof metadata?.owner === "string" ? metadata.owner.trim() : "";
    const requestedRepo = typeof metadata?.repo === "string" ? metadata.repo.trim().replace(/\.git$/i, "") : "";
    if (!requestedOwner || !requestedRepo) {
      throw unprocessable("GitHub Actions operations require metadata.owner and metadata.repo");
    }
    const [primary, project] = await Promise.all([
      executor
        .select({ repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(and(
          eq(projectWorkspaces.companyId, issue.companyId),
          eq(projectWorkspaces.projectId, issue.projectId),
        ))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      executor
        .select({ env: projects.env })
        .from(projects)
        .where(and(eq(projects.companyId, issue.companyId), eq(projects.id, issue.projectId)))
        .then((rows) => rows[0] ?? null),
    ]);
    const configuredRepo = githubRepoFromUrl(primary?.repoUrl);
    if (!configuredRepo) {
      throw unprocessable("GitHub Actions operations require a parseable repository on the issue project's primary workspace");
    }
    const requested = `${requestedOwner}/${requestedRepo}`.toLowerCase();
    if (configuredRepo.fullName !== requested) {
      throw unprocessable("GitHub Actions operation repository must match the issue project's configured repository");
    }
    const projectEnv = asRecord(project?.env);
    const configuredWorkflowId = plainProjectEnvValue(projectEnv.GITHUB_ACTIONS_WORKFLOW_ID);
    if (!configuredWorkflowId || !/^\d+$/.test(configuredWorkflowId) || Number(configuredWorkflowId) < 1) {
      throw unprocessable(
        "GitHub Actions operations require project env GITHUB_ACTIONS_WORKFLOW_ID to identify the required CI workflow",
        { code: "github_ci_workflow_not_configured" },
      );
    }
    const configuredWorkflowPath = plainProjectEnvValue(projectEnv.GITHUB_ACTIONS_WORKFLOW_PATH);
    const configuredWorkflowBlobSha = plainProjectEnvValue(projectEnv.GITHUB_ACTIONS_WORKFLOW_BLOB_SHA)
      ?.toLowerCase() ?? null;
    const configuredWorkflowEvent = plainProjectEnvValue(projectEnv.GITHUB_ACTIONS_EVENT)
      ?.toLowerCase() ?? null;
    if (!configuredWorkflowPath || !configuredWorkflowBlobSha || !configuredWorkflowEvent) {
      throw unprocessable(
        "GitHub Actions operations require project env GITHUB_ACTIONS_WORKFLOW_PATH, GITHUB_ACTIONS_WORKFLOW_BLOB_SHA, and GITHUB_ACTIONS_EVENT",
        { code: "github_ci_attestation_not_configured" },
      );
    }
    const workflowPathSegments = configuredWorkflowPath.split("/");
    if (
      configuredWorkflowPath.length > 512
      || !configuredWorkflowPath.startsWith(".github/workflows/")
      || !/\.ya?ml$/.test(configuredWorkflowPath)
      || configuredWorkflowPath.includes("\\")
      || workflowPathSegments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw unprocessable(
        "GITHUB_ACTIONS_WORKFLOW_PATH must be a normalized .github/workflows/*.yml or *.yaml repository path",
        { code: "github_ci_attestation_invalid", field: "GITHUB_ACTIONS_WORKFLOW_PATH" },
      );
    }
    if (!/^[0-9a-f]{40}$/.test(configuredWorkflowBlobSha)) {
      throw unprocessable(
        "GITHUB_ACTIONS_WORKFLOW_BLOB_SHA must be the exact 40-character Git blob SHA for the trusted workflow file",
        { code: "github_ci_attestation_invalid", field: "GITHUB_ACTIONS_WORKFLOW_BLOB_SHA" },
      );
    }
    // Dispatch/call events can carry unattested inputs. Keep the initial
    // allowlist to candidate-bound CI events; add future events only with their
    // own explicit trigger attestation.
    if (!new Set(["push", "pull_request"]).has(configuredWorkflowEvent)) {
      throw unprocessable(
        "GITHUB_ACTIONS_EVENT must be push or pull_request; dispatch and call events require additional trigger attestation",
        { code: "github_ci_attestation_invalid", field: "GITHUB_ACTIONS_EVENT" },
      );
    }
    const requestedWorkflowId = metadata?.workflowId === undefined
      ? null
      : String(metadata.workflowId).trim();
    if (requestedWorkflowId && requestedWorkflowId !== configuredWorkflowId) {
      throw unprocessable(
        "GitHub Actions operation workflow must match the issue project's configured CI workflow",
        {
          code: "github_ci_workflow_mismatch",
          configuredWorkflowId,
        },
      );
    }
    const requestedWorkflowPath = typeof metadata?.workflowPath === "string"
      ? metadata.workflowPath.trim()
      : typeof metadata?.githubWorkflowPath === "string"
        ? metadata.githubWorkflowPath.trim()
        : null;
    const requestedWorkflowBlobSha = typeof metadata?.workflowBlobSha === "string"
      ? metadata.workflowBlobSha.trim().toLowerCase()
      : typeof metadata?.githubWorkflowBlobSha === "string"
        ? metadata.githubWorkflowBlobSha.trim().toLowerCase()
        : null;
    const requestedWorkflowEvent = typeof metadata?.workflowEvent === "string"
      ? metadata.workflowEvent.trim().toLowerCase()
      : typeof metadata?.githubWorkflowEvent === "string"
        ? metadata.githubWorkflowEvent.trim().toLowerCase()
        : null;
    if (requestedWorkflowPath && requestedWorkflowPath !== configuredWorkflowPath) {
      throw unprocessable("GitHub Actions operation workflow path must match the project configuration", {
        code: "github_ci_workflow_path_mismatch",
        configuredWorkflowPath,
      });
    }
    if (requestedWorkflowBlobSha && requestedWorkflowBlobSha !== configuredWorkflowBlobSha) {
      throw unprocessable("GitHub Actions operation workflow blob must match the project configuration", {
        code: "github_ci_workflow_blob_mismatch",
      });
    }
    if (requestedWorkflowEvent && requestedWorkflowEvent !== configuredWorkflowEvent) {
      throw unprocessable("GitHub Actions operation event must match the project configuration", {
        code: "github_ci_workflow_event_mismatch",
        configuredWorkflowEvent,
      });
    }
    return {
      ...configuredRepo,
      workflowId: configuredWorkflowId,
      workflowPath: configuredWorkflowPath,
      workflowBlobSha: configuredWorkflowBlobSha,
      workflowEvent: configuredWorkflowEvent,
    };
  }

  function plainProjectEnvValue(value: unknown) {
    if (typeof value === "string" && value.trim()) return value.trim();
    const record = asRecord(value);
    return record.type === "plain" && typeof record.value === "string" && record.value.trim()
      ? record.value.trim()
      : null;
  }

  async function assertCloudflareProjectBinding(
    executor: Db,
    issue: Awaited<ReturnType<typeof assertIssueScope>>,
    metadata: Record<string, unknown> | null | undefined,
  ) {
    if (!issue.projectId) throw unprocessable("Cloudflare verification requires an issue project");
    const project = await executor
      .select({ env: projects.env })
      .from(projects)
      .where(and(eq(projects.companyId, issue.companyId), eq(projects.id, issue.projectId)))
      .then((rows) => rows[0] ?? null);
    const env = asRecord(project?.env);
    const accountId = plainProjectEnvValue(env.CLOUDFLARE_ACCOUNT_ID);
    const projectName = plainProjectEnvValue(env.CLOUDFLARE_PAGES_PROJECT_NAME);
    if (!accountId || !projectName) {
      throw unprocessable(
        "Cloudflare operations require project env CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_PROJECT_NAME",
      );
    }
    const requestedAccountId = typeof metadata?.accountId === "string" ? metadata.accountId.trim() : null;
    const requestedProjectName = typeof metadata?.projectName === "string" ? metadata.projectName.trim() : null;
    if (
      (requestedAccountId && requestedAccountId !== accountId)
      || (requestedProjectName && requestedProjectName !== projectName)
    ) {
      throw unprocessable("Cloudflare operation target must match the issue project's configured deployment target");
    }
    return { accountId, projectName };
  }

  function assertProviderStageSemantics(input: Pick<CreateExternalOperation, "kind" | "provider" | "stage">) {
    if (input.kind === "github_actions_workflow_run" && input.provider !== "github") {
      throw unprocessable("GitHub Actions operations require provider=github");
    }
    if (input.kind === "github_actions_workflow_run" && input.stage !== "ci") {
      throw unprocessable("GitHub Actions workflow runs can only provide CI-stage evidence");
    }
    if (input.kind === "cloudflare_pages_deployment" && input.provider !== "cloudflare") {
      throw unprocessable("Cloudflare Pages operations require provider=cloudflare");
    }
    if (input.kind === "cloudflare_pages_deployment" && input.stage !== "deployment") {
      throw unprocessable("Cloudflare Pages deployments can only provide deployment-stage evidence");
    }
  }

  function assertProviderObservationFresh(
    operation: ExternalOperationV1,
    result: ExternalProviderVerification,
  ) {
    const stageActivatedAtRaw = deliveryFactoryProvenance(operation.metadata)?.stageActivatedAt ?? null;
    const stageActivatedAt = stageActivatedAtRaw ? new Date(stageActivatedAtRaw) : null;
    const isFactoryProductionDeployment = Boolean(
      deliveryFactoryProvenance(operation.metadata)
      && operation.stage === "deployment"
      && operation.environment?.trim().toLowerCase() === "production",
    );
    if (isFactoryProductionDeployment) {
      const providerStartedAt = result.startedAt instanceof Date ? result.startedAt : null;
      if (
        !providerStartedAt
        || Number.isNaN(providerStartedAt.getTime())
        || !stageActivatedAt
        || Number.isNaN(stageActivatedAt.getTime())
        || providerStartedAt.getTime() < stageActivatedAt.getTime()
      ) {
        throw unprocessable("Production deployment was not initiated after its authorized factory stage activated", {
          code: "provider_operation_predates_authorization",
          operationId: operation.id,
          providerStartedAt: providerStartedAt && !Number.isNaN(providerStartedAt.getTime())
            ? providerStartedAt.toISOString()
            : null,
          stageActivatedAt: stageActivatedAtRaw,
        });
      }
    }
    const lowerBound = Math.max(
      operation.createdAt.getTime(),
      stageActivatedAt && !Number.isNaN(stageActivatedAt.getTime()) ? stageActivatedAt.getTime() : 0,
    ) - PROVIDER_OBSERVATION_CLOCK_SKEW_MS;
    const observedAt = result.observedAt.getTime();
    if (
      Number.isNaN(observedAt)
      || observedAt < lowerBound
      || observedAt > Date.now() + PROVIDER_OBSERVATION_CLOCK_SKEW_MS
    ) {
      throw unprocessable("Provider observation predates this external operation or factory stage", {
        code: "provider_observation_replayed",
        operationId: operation.id,
        observedAt: Number.isNaN(result.observedAt.getTime()) ? null : result.observedAt.toISOString(),
        operationCreatedAt: operation.createdAt.toISOString(),
        stageActivatedAt: stageActivatedAtRaw,
      });
    }
  }

  function assertProviderStateTuple(result: ExternalProviderVerification) {
    const nonTerminal = result.operationState === "queued"
      || result.operationState === "running"
      || result.operationState === "unknown";
    const valid = result.operationState === "succeeded"
      ? result.eventState === "succeeded"
      : nonTerminal
        ? result.eventState === "pending" || result.eventState === "unknown"
        : result.eventState !== "succeeded" && result.eventState !== "accepted";
    if (!valid) {
      throw unprocessable("Provider operation state is inconsistent with its delivery evidence state", {
        code: "provider_state_tuple_invalid",
        operationState: result.operationState,
        eventState: result.eventState,
      });
    }
  }

  function assertProviderIdentityBinding(
    operation: ExternalOperationV1,
    result: ExternalProviderVerification,
  ) {
    if (result.provider !== operation.provider || result.externalId !== operation.externalId) {
      throw new ExternalProviderAttestationError(
        "Provider observation identity does not match the registered external operation",
        "provider_operation_identity_mismatch",
      );
    }
    safeHttpUrl(result.url);
    if (operation.kind === "cloudflare_pages_deployment") {
      const expected = asRecord(operation.metadata);
      const observed = asRecord(result.metadata);
      if (
        typeof expected.cloudflareAccountId !== "string"
        || typeof expected.cloudflareProjectName !== "string"
        || observed.accountId !== expected.cloudflareAccountId
        || observed.projectName !== expected.cloudflareProjectName
      ) {
        throw new ExternalProviderAttestationError(
          "Cloudflare provider observation target does not match the project-bound operation",
          "cloudflare_target_mismatch",
        );
      }
      return;
    }
    if (operation.kind !== "github_actions_workflow_run") return;
    const expected = asRecord(operation.metadata);
    const observed = asRecord(result.metadata);
    const expectedRepo = typeof expected.githubRepositoryFullName === "string"
      ? expected.githubRepositoryFullName.toLowerCase()
      : null;
    const observedRepo = typeof observed.repositoryFullName === "string"
      ? observed.repositoryFullName.toLowerCase()
      : null;
    const expectedHost = typeof expected.githubRepositoryHost === "string"
      ? expected.githubRepositoryHost.toLowerCase()
      : null;
    if (!expectedRepo || !expectedHost) {
      throw new ExternalProviderAttestationError(
        "GitHub operation is missing its server-bound project repository identity",
        "github_repository_identity_missing",
      );
    }
    if (expectedRepo && expectedRepo !== observedRepo) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation repository does not match the registered operation",
        "github_repository_mismatch",
      );
    }
    const observedUrl = safeHttpUrl(result.url);
    if (
      expectedHost
      && (!observedUrl || new URL(observedUrl).hostname.toLowerCase() !== expectedHost)
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation host does not match the project's configured repository",
        "github_repository_host_mismatch",
      );
    }
    if (
      expected.workflowId !== undefined
      && String(expected.workflowId) !== String(observed.workflowId ?? "")
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation workflow does not match the registered operation",
        "github_workflow_id_mismatch",
      );
    }
    if (
      typeof expected.githubWorkflowPath !== "string"
      || typeof expected.githubWorkflowBlobSha !== "string"
      || typeof expected.githubWorkflowEvent !== "string"
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub operation is missing its server-bound workflow attestation identity",
        "github_workflow_attestation_missing",
      );
    }
    if (observed.workflowPath !== expected.githubWorkflowPath) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation workflow path does not match the registered operation",
        "github_workflow_path_mismatch",
      );
    }
    if (
      typeof observed.workflowBlobSha !== "string"
      || observed.workflowBlobSha.toLowerCase() !== expected.githubWorkflowBlobSha.toLowerCase()
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation workflow blob does not match the registered operation",
        "github_workflow_blob_mismatch",
      );
    }
    if (
      typeof observed.workflowEvent !== "string"
      || observed.workflowEvent.toLowerCase() !== expected.githubWorkflowEvent.toLowerCase()
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub provider observation event does not match the registered operation",
        "github_workflow_event_mismatch",
      );
    }
    if (
      typeof observed.workflowBlobHeadSha !== "string"
      || !candidateShasMatch(result.candidateSha, observed.workflowBlobHeadSha)
    ) {
      throw new ExternalProviderAttestationError(
        "GitHub provider workflow blob was not attested at the observed run head SHA",
        "github_workflow_blob_ref_mismatch",
      );
    }
  }

  return {
    async listEvents(companyId: string, issueId: string) {
      await assertIssueScope(companyId, issueId);
      return db
        .select()
        .from(deliveryEvents)
        .where(and(eq(deliveryEvents.companyId, companyId), eq(deliveryEvents.issueId, issueId)))
        .orderBy(asc(deliveryEvents.createdAt), asc(deliveryEvents.id))
        .then((rows) => rows.map(toDeliveryEvent));
    },

    async getSnapshot(companyId: string, issueId: string) {
      const issue = await assertIssueScope(companyId, issueId);
      const [events, supersededOperationIds] = await Promise.all([
        db
          .select()
          .from(deliveryEvents)
          .where(and(eq(deliveryEvents.companyId, companyId), eq(deliveryEvents.issueId, issueId)))
          .orderBy(asc(deliveryEvents.createdAt), asc(deliveryEvents.id))
          .then((rows) => rows.map(toDeliveryEvent)),
        readSupersededOperationIds(db, companyId, issueId),
      ]);
      const snapshot = projectDeliverySnapshot(companyId, issueId, events, supersededOperationIds);
      const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
      const state = issueExecutionStateSchema.safeParse(issue.executionState);
      const policyHasStableIds = policy.success && policy.data.stages.every(
        (stage) => Boolean(stage.id) && stage.participants.every((participant) => Boolean(participant.id)),
      );
      return policyHasStableIds && state.success
        ? applyFactoryDeliverySnapshotFreshness({
            snapshot,
            policy: policy.data as IssueExecutionPolicy,
            state: state.data,
          })
        : snapshot;
    },

    withIssueDeliveryLock<T>(companyId: string, issueId: string, work: () => Promise<T>) {
      return runWithIssueDeliveryLock(companyId, issueId, async () => work());
    },

    appendAgentClaim(
      companyId: string,
      issueId: string,
      event: CreateDeliveryEvent,
      actor: DeliveryActor,
      factoryProvenance?: DeliveryFactoryProvenanceV1 | null,
    ) {
      return appendEvent({
        companyId,
        issueId,
        event,
        sourceKind: "agent_submission",
        authority: "agent_claim",
        actor,
        factoryProvenance,
      });
    },

    appendUserAssertion(
      companyId: string,
      issueId: string,
      event: CreateDeliveryEvent,
      actor: DeliveryActor,
      factoryProvenance?: DeliveryFactoryProvenanceV1 | null,
    ) {
      return appendEvent({
        companyId,
        issueId,
        event,
        sourceKind: "user_submission",
        authority: "user_asserted",
        actor,
        factoryProvenance,
      });
    },

    appendPaperclipAction(companyId: string, issueId: string, event: AppendVerifiedDeliveryEvent, actor: DeliveryActor) {
      return appendEvent({
        companyId,
        issueId,
        event,
        sourceKind: "paperclip_action",
        authority: "paperclip_verified",
        actor,
        sourceFingerprint: event.sourceFingerprint,
        allowReservedMetadata: true,
      });
    },

    appendProviderObservation(companyId: string, issueId: string, event: AppendVerifiedDeliveryEvent) {
      return appendEvent({
        companyId,
        issueId,
        event,
        sourceKind: "provider_observation",
        authority: "provider_verified",
        actor: { actorType: "system" },
        sourceFingerprint: event.sourceFingerprint,
        allowReservedMetadata: true,
      });
    },

    async backfillLegacyWorkProducts(companyId: string, issueId: string, workProductIds?: string[]) {
      await assertIssueScope(companyId, issueId);
      const filters = [
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
      ];
      if (workProductIds?.length) filters.push(inArray(issueWorkProducts.id, [...new Set(workProductIds)]));
      const products = await db
        .select()
        .from(issueWorkProducts)
        .where(and(...filters))
        .orderBy(asc(issueWorkProducts.createdAt), asc(issueWorkProducts.id));
      const appended: DeliveryEventV1[] = [];
      for (const product of products) {
        const result = await appendEvent({
          companyId,
          issueId,
          event: {
            stage: legacyStage(product.type),
            state: legacyState(product.status),
            candidateSha: typeof product.metadata?.candidateSha === "string" ? product.metadata.candidateSha : null,
            environment: typeof product.metadata?.environment === "string" ? product.metadata.environment : null,
            provider: product.provider,
            providerExternalId: product.externalId,
            providerUrl: product.url,
            summary: `Legacy work product: ${product.title}`,
            metadata: { workProductType: product.type, workProductStatus: product.status },
            observedAt: product.updatedAt,
          },
          sourceKind: "legacy_backfill",
          authority: "legacy_unverified",
          actor: { actorType: "system" },
          sourceFingerprint: `legacy-work-product:${product.id}`,
          sourceWorkProductId: product.id,
        });
        if (result.created) appended.push(result.event);
      }
      return { inspected: products.length, appended };
    },

    async listExternalOperations(companyId: string, issueId: string) {
      await assertIssueScope(companyId, issueId);
      return db
        .select()
        .from(externalOperations)
        .where(and(eq(externalOperations.companyId, companyId), eq(externalOperations.issueId, issueId)))
        .orderBy(desc(externalOperations.updatedAt), desc(externalOperations.id))
        .then((rows) => rows.map(toExternalOperation));
    },

    async getExternalOperation(companyId: string, issueId: string, operationId: string) {
      return db
        .select()
        .from(externalOperations)
        .where(and(
          eq(externalOperations.id, operationId),
          eq(externalOperations.companyId, companyId),
          eq(externalOperations.issueId, issueId),
        ))
        .then((rows) => rows[0] ? toExternalOperation(rows[0]) : null);
    },

    async createExternalOperation(
      companyId: string,
      issueId: string,
      input: CreateExternalOperation,
      actor: DeliveryActor,
      factoryProvenance?: DeliveryFactoryProvenanceV1 | null,
    ) {
      await assertCredentialSecret(companyId, input.credentialSecretId);
      assertNoReservedDeliveryMetadata(input.metadata);
      assertProviderStageSemantics(input);
      safeHttpUrl(input.url);
      if (factoryProvenance && input.kind === "custom") {
        throw unprocessable("Factory external operations require a registered provider verifier");
      }
      const normalizedCandidate = normalizeCandidateSha(input.candidateSha);
      return runWithIssueDeliveryLock(companyId, issueId, async (executor) => {
        const issue = await assertIssueScope(companyId, issueId, executor);
        await assertMutationNotHeld(companyId, issueId, executor);
        const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
        const factoryExecution = policy.success && policy.data.factory?.laneKind === "execution";
        if (factoryExecution && !factoryProvenance) {
          unauthorizedFactoryMutation("Factory external operations require server-stamped workflow provenance");
        }
        let registeredEnvironment = input.environment ?? null;
        let supersedesOperationId: string | null = null;
        if (factoryProvenance) {
          const factoryContext = await assertCurrentFactoryMutation({
            executor,
            issue,
            actor,
            provenance: factoryProvenance,
            deliveryStage: input.stage,
            candidateSha: input.candidateSha,
          });
          if (
            factoryContext.stage.key === "deployment"
            && factoryContext.policy.factory?.production === true
          ) {
            if (
              input.environment
              && input.environment.trim().toLowerCase() !== "production"
            ) {
              throw unprocessable("Factory production deployment operations cannot target a non-production environment", {
                code: "factory_production_environment_required",
              });
            }
            registeredEnvironment = "production";
          }
          if (input.nextCheckAt !== undefined || input.timeoutAt !== undefined) {
            throw unprocessable("Factory operation polling schedule is server-owned", {
              code: "factory_operation_schedule_reserved",
            });
          }
          const sameRevisionOperations = await executor
            .select()
            .from(externalOperations)
            .where(and(
              eq(externalOperations.companyId, companyId),
              eq(externalOperations.issueId, issueId),
              eq(externalOperations.stage, input.stage),
            ));
          const lineageOperations = sameRevisionOperations.filter((candidate) => {
            const candidateProvenance = deliveryFactoryProvenance(candidate.metadata);
            return candidateProvenance?.stageId === factoryProvenance.stageId
              && candidateProvenance.stageKey === factoryProvenance.stageKey
              && candidateProvenance.stageRevision === factoryProvenance.stageRevision;
          });
          const supersededIds = new Set(
            lineageOperations.flatMap((candidate) => (
              candidate.supersedesOperationId ? [candidate.supersedesOperationId] : []
            )),
          );
          const canonicalHeads = lineageOperations.filter((candidate) => !supersededIds.has(candidate.id));
          if (canonicalHeads.length > 1) {
            throw conflict("Factory external operation lineage has more than one canonical head", {
              code: "factory_external_operation_lineage_fork",
              operationIds: canonicalHeads.map((candidate) => candidate.id).sort(),
              stage: input.stage,
              stageId: factoryProvenance.stageId,
              stageRevision: factoryProvenance.stageRevision,
            });
          }
          if (lineageOperations.length > 0 && canonicalHeads.length === 0) {
            throw conflict("Factory external operation lineage has no canonical head", {
              code: "factory_external_operation_lineage_invalid",
              stage: input.stage,
              stageId: factoryProvenance.stageId,
              stageRevision: factoryProvenance.stageRevision,
            });
          }
          const canonicalOperation = canonicalHeads[0] ?? null;
          if (canonicalOperation) {
            const sameIdentity = canonicalOperation.provider === input.provider
              && canonicalOperation.kind === input.kind
              && canonicalOperation.externalId === input.externalId
              && candidateShasMatch(canonicalOperation.candidateSha, normalizedCandidate)
              && canonicalOperation.environment === registeredEnvironment;
            if (sameIdentity) {
              return { operation: toExternalOperation(canonicalOperation), created: false };
            }
            // A provider can report its run as succeeded while proving the
            // wrong candidate or environment. That is terminal provider state,
            // but not a successful delivery head. Only a lineage-matching,
            // provider-verified success seals the lineage against replacement.
            const verifiedSuccess = canonicalOperation.state === "succeeded"
              && canonicalOperation.verificationStatus === "verified";
            const replaceable = !verifiedSuccess
              && terminalOperationState(canonicalOperation.state as ExternalOperationState);
            if (!replaceable) {
              throw conflict("Factory stage revision already has a canonical external operation", {
                code: "factory_external_operation_already_registered",
                operationId: canonicalOperation.id,
                operationState: canonicalOperation.state,
                stage: input.stage,
                stageId: factoryProvenance.stageId,
                stageRevision: factoryProvenance.stageRevision,
              });
            }
            supersedesOperationId = canonicalOperation.id;
          }
        }
        const githubBinding = input.kind === "github_actions_workflow_run"
          ? await assertGithubProjectBinding(executor, issue, input.metadata)
          : null;
        const cloudflareBinding = input.kind === "cloudflare_pages_deployment"
          ? await assertCloudflareProjectBinding(executor, issue, input.metadata)
          : null;
        const controller = factoryProvenance ? factoryControllerMetadata(issue) : null;
        const createdAt = new Date();
        const firstAttemptMinutes = controller?.attemptMinutes[0] ?? 0;
        const schedule = boundedOperationSchedule(
          input,
          input.kind,
          createdAt,
          firstAttemptMinutes * 60_000,
        );
        if (controller && schedule.timeoutAt) {
          const finalAttemptIndex = Math.max(0, controller.maxAttempts - 1);
          const finalAttemptMinutes = controller.attemptMinutes[finalAttemptIndex] ?? firstAttemptMinutes;
          if (schedule.timeoutAt.getTime() < createdAt.getTime() + finalAttemptMinutes * 60_000) {
            throw unprocessable("Factory operation timeout must include its frozen recovery schedule");
          }
        }
        const metadata = {
          ...(input.metadata ?? {}),
          ...(githubBinding ? {
            githubRepositoryHost: githubBinding.host,
            githubRepositoryFullName: githubBinding.fullName,
            // The workflow identity comes from board-controlled project
            // configuration, never from the stage participant's claim.
            workflowId: githubBinding.workflowId,
            githubWorkflowPath: githubBinding.workflowPath,
            githubWorkflowBlobSha: githubBinding.workflowBlobSha,
            githubWorkflowEvent: githubBinding.workflowEvent,
          } : {}),
          ...(cloudflareBinding ? {
            cloudflareAccountId: cloudflareBinding.accountId,
            cloudflareProjectName: cloudflareBinding.projectName,
          } : {}),
          ...(factoryProvenance ? {
            paperclipFactory: factoryProvenance,
            paperclipController: controller ? {
              ...controller,
              scheduleStartedAt: createdAt.toISOString(),
              scheduleIndex: 0,
            } : null,
          } : {}),
        };
        const values = {
          companyId,
          issueId,
          kind: input.kind,
          provider: input.provider,
          stage: input.stage,
          externalId: input.externalId,
          supersedesOperationId,
          candidateSha: normalizedCandidate,
          environment: registeredEnvironment,
          url: input.url ?? null,
          state: "unknown",
          verificationStatus: "unverified",
          credentialSecretId: input.credentialSecretId ?? null,
          nextCheckAt: schedule.nextCheckAt,
          timeoutAt: schedule.timeoutAt,
          metadata: Object.keys(metadata).length > 0 ? metadata : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          createdAt,
          updatedAt: createdAt,
        };
        const [created] = await executor.insert(externalOperations).values(values).onConflictDoNothing().returning();
        if (created) return { operation: toExternalOperation(created), created: true };
        const existing = await executor
          .select()
          .from(externalOperations)
          .where(and(
            eq(externalOperations.companyId, companyId),
            eq(externalOperations.issueId, issueId),
            eq(externalOperations.provider, input.provider),
            eq(externalOperations.kind, input.kind),
            eq(externalOperations.externalId, input.externalId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw conflict("External operation could not be created");
        const existingCandidate = normalizeCandidateSha(existing.candidateSha);
        const sameCandidate = existingCandidate === null && normalizedCandidate === null
          ? true
          : candidateShasMatch(existingCandidate, normalizedCandidate);
        if (
          existing.stage !== input.stage
          || !sameCandidate
          || existing.environment !== registeredEnvironment
        ) {
          throw conflict("External operation identity already exists with different delivery lineage", {
            code: "external_operation_identity_conflict",
            operationId: existing.id,
          });
        }
        return { operation: toExternalOperation(existing), created: false };
      });
    },

    async updateExternalOperation(
      companyId: string,
      issueId: string,
      operationId: string,
      input: UpdateExternalOperation,
    ) {
      await assertCredentialSecret(companyId, input.credentialSecretId);
      assertNoReservedDeliveryMetadata(input.metadata);
      return runWithIssueDeliveryLock(companyId, issueId, async (executor) => {
        await assertMutationNotHeld(companyId, issueId, executor);
        const existing = await executor
          .select()
          .from(externalOperations)
          .where(and(
            eq(externalOperations.id, operationId),
            eq(externalOperations.companyId, companyId),
            eq(externalOperations.issueId, issueId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        const immutableRegistrationKeys = [
          "externalId",
          "candidateSha",
          "environment",
          "url",
          "metadata",
        ] as const;
        if (immutableRegistrationKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
          throw conflict("External operation delivery identity is immutable after registration", {
            code: "external_operation_identity_frozen",
            operationId,
          });
        }
        const scheduleChanged = input.nextCheckAt !== undefined || input.timeoutAt !== undefined;
        if (deliveryFactoryProvenance(existing.metadata) && scheduleChanged) {
          throw conflict("Factory operation polling schedule is immutable", {
            code: "factory_operation_schedule_frozen",
            operationId,
          });
        }
        const schedule = scheduleChanged
          ? boundedOperationSchedule({
            nextCheckAt: input.nextCheckAt === undefined ? existing.nextCheckAt : input.nextCheckAt,
            timeoutAt: input.timeoutAt === undefined ? existing.timeoutAt : input.timeoutAt,
          }, existing.kind as ExternalOperationV1["kind"], new Date(), 0, existing.createdAt)
          : null;
        const patch = {
          ...input,
          ...(input.candidateSha !== undefined ? { candidateSha: normalizeCandidateSha(input.candidateSha) } : {}),
          ...(schedule ? schedule : {}),
          updatedAt: new Date(),
        };
        const [updated] = await executor
          .update(externalOperations)
          .set(patch)
          .where(and(
            eq(externalOperations.id, operationId),
            eq(externalOperations.companyId, companyId),
            eq(externalOperations.issueId, issueId),
          ))
          .returning();
        return updated ? toExternalOperation(updated) : null;
      });
    },

    async verifyExternalOperation(
      companyId: string,
      issueId: string,
      operationId: string,
      actor: DeliveryActor,
    ) {
      const initialOperation = await runWithIssueDeliveryLock(companyId, issueId, async (executor) => {
        await assertMutationNotHeld(companyId, issueId, executor);
        const row = await executor
          .select()
          .from(externalOperations)
          .where(and(
            eq(externalOperations.id, operationId),
            eq(externalOperations.companyId, companyId),
            eq(externalOperations.issueId, issueId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("External operation not found");
        const operation = toExternalOperation(row);
        await assertFactoryOperationCanonicalHead(executor, operation);
        await assertFactoryOperationStageStillActive(executor, operation);
        return operation;
      });
      const verifier = verifiers.get(`${initialOperation.provider}:${initialOperation.kind}`);
      if (!verifier) {
        throw unprocessable(`No provider verifier is registered for ${initialOperation.provider}:${initialOperation.kind}`);
      }
      let result: ExternalProviderVerification;
      try {
        const credentials = await resolveVerificationCredential(initialOperation, actor);
        // Provider I/O deliberately occurs before the database transaction. The
        // result is then committed atomically with its append-only ledger event.
        result = await verifier.verify({ operation: initialOperation, ...credentials });
        assertProviderStateTuple(result);
        assertProviderIdentityBinding(initialOperation, result);
        assertProviderObservationFresh(initialOperation, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const permanentAttestationMismatch = error instanceof ExternalProviderAttestationError;
        await runWithIssueDeliveryLock(companyId, issueId, async (executor) => {
          await assertMutationNotHeld(companyId, issueId, executor);
          const currentRow = await executor
            .select()
            .from(externalOperations)
            .where(and(
              eq(externalOperations.id, initialOperation.id),
              eq(externalOperations.companyId, companyId),
              eq(externalOperations.issueId, issueId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!currentRow) throw notFound("External operation not found");
          const currentOperation = toExternalOperation(currentRow);
          await assertFactoryOperationCanonicalHead(executor, currentOperation);
          await assertFactoryOperationStageStillActive(executor, currentOperation);
          const preserveVerifiedSuccess = currentOperation.state === "succeeded"
            && currentOperation.verificationStatus === "verified";
          const now = new Date();
          await executor
            .update(externalOperations)
            .set({
              state: permanentAttestationMismatch && !preserveVerifiedSuccess
                ? "failed"
                : currentOperation.state,
              verificationStatus: preserveVerifiedSuccess
                ? "verified"
                : permanentAttestationMismatch
                  ? "mismatch"
                  : "error",
              lastVerificationError: message.slice(0, 4_000),
              lastVerifiedAt: now,
              terminalAt: permanentAttestationMismatch && !preserveVerifiedSuccess
                ? now
                : currentOperation.terminalAt,
              nextCheckAt: permanentAttestationMismatch && !preserveVerifiedSuccess
                ? null
                : currentOperation.nextCheckAt,
              metadata: permanentAttestationMismatch && !preserveVerifiedSuccess
                ? {
                    ...(currentOperation.metadata ?? {}),
                    providerAttestationMismatch: {
                      code: error.code,
                      message: message.slice(0, 4_000),
                      terminalAt: now.toISOString(),
                    },
                  }
                : currentOperation.metadata,
              updatedAt: now,
            })
            .where(and(
              eq(externalOperations.id, initialOperation.id),
              eq(externalOperations.companyId, companyId),
              eq(externalOperations.issueId, issueId),
              eq(externalOperations.updatedAt, initialOperation.updatedAt),
            ));
        });
        throw error;
      }
      return runWithIssueDeliveryLock(companyId, issueId, async (executor) => {
          await assertMutationNotHeld(companyId, issueId, executor);
          const currentRow = await executor
            .select()
            .from(externalOperations)
            .where(and(
              eq(externalOperations.id, operationId),
              eq(externalOperations.companyId, companyId),
              eq(externalOperations.issueId, issueId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!currentRow) throw notFound("External operation not found");
          const operation = toExternalOperation(currentRow);
          if (
            operation.externalId !== initialOperation.externalId
            || operation.provider !== initialOperation.provider
            || operation.kind !== initialOperation.kind
            || operation.stage !== initialOperation.stage
            || operation.updatedAt.getTime() !== initialOperation.updatedAt.getTime()
          ) {
            throw conflict("External operation changed while provider verification was in flight", {
              code: "external_operation_verification_conflict",
              operationId,
            });
          }
          await assertFactoryOperationCanonicalHead(executor, operation);
          await assertFactoryOperationStageStillActive(executor, operation);
          assertProviderIdentityBinding(operation, result);
          assertProviderObservationFresh(operation, result);
          const providerFingerprint = deliveryEventFingerprint(operation, result);
          const existingController = asRecord(asRecord(operation.metadata).paperclipController);
          const attemptMinutes = readExternalOperationControllerAttemptMinutes(operation.metadata);
          const existingEvidenceFingerprint = typeof existingController.evidenceFingerprint === "string"
            ? existingController.evidenceFingerprint
            : null;
          const controllerCanRearm = Boolean(
            result.operationState !== "succeeded"
            && !terminalOperationState(result.operationState)
            && existingController.status === "exhausted"
            && attemptMinutes?.length
            && operation.timeoutAt
            && operation.timeoutAt.getTime() > Date.now()
            && providerFingerprint !== existingEvidenceFingerprint
          );
          if (
            (operation.terminalAt || terminalOperationState(operation.state))
            && !terminalOperationState(result.operationState)
            && !controllerCanRearm
          ) {
            throw conflict("A terminal external operation cannot regress to a nonterminal provider state", {
              code: "external_operation_terminal_regression",
              operationId,
              previousState: operation.state,
              observedState: result.operationState,
            });
          }
          const candidateMismatch = Boolean(
            operation.candidateSha && !candidateShasMatch(operation.candidateSha, result.candidateSha),
          );
          const environmentMismatch = Boolean(
            operation.environment
            && (
              !result.environment
              || operation.environment.trim().toLowerCase() !== result.environment.trim().toLowerCase()
            ),
          );
          const lineageMismatch = candidateMismatch || environmentMismatch;
          const now = new Date();
          const rearmedNextCheckAt = terminalOperationState(result.operationState)
            ? null
            : controllerCanRearm && attemptMinutes
              ? new Date(Math.min(
                  now.getTime() + attemptMinutes[0]! * 60_000,
                  operation.timeoutAt?.getTime() ?? Number.POSITIVE_INFINITY,
                ))
              : operation.nextCheckAt;
          const operationMetadata = {
            ...(operation.metadata ?? {}),
            providerObservation: result.metadata,
            ...(controllerCanRearm ? {
              paperclipController: {
                ...existingController,
                attemptCount: 0,
                scheduleIndex: 0,
                scheduleStartedAt: now.toISOString(),
                evidenceFingerprint: providerFingerprint,
                evidenceFingerprintChangedAt: now.toISOString(),
                status: "waiting",
                completedAt: null,
                claimToken: null,
                leaseUntil: null,
                nextCheckAt: rearmedNextCheckAt?.toISOString() ?? null,
              },
            } : {}),
            ...(candidateMismatch
              ? { candidateMismatch: { expected: operation.candidateSha, observed: result.candidateSha } }
              : {}),
            ...(environmentMismatch
              ? { environmentMismatch: { expected: operation.environment, observed: result.environment } }
              : {}),
          };
          const [updated] = await executor
            .update(externalOperations)
            .set({
              state: result.operationState,
              verificationStatus: lineageMismatch ? "mismatch" : "verified",
              url: result.url ?? operation.url,
              // Only a provider-observed environment is elevated to verified
              // operation state. Caller expectations remain in the event metadata.
              environment: result.environment ?? operation.environment,
              terminalAt: terminalOperationState(result.operationState) ? now : null,
              lastVerifiedAt: now,
              lastVerificationError: null,
              nextCheckAt: rearmedNextCheckAt,
              metadata: operationMetadata,
              updatedAt: now,
            })
            .where(and(
              eq(externalOperations.id, operation.id),
              eq(externalOperations.companyId, companyId),
              eq(externalOperations.issueId, issueId),
            ))
            .returning();
          if (!updated) throw notFound("External operation not found");
          const eventResult = await appendEventLocked(executor, {
            companyId,
            issueId,
            event: {
              stage: operation.stage,
              state: result.eventState,
              candidateSha: result.candidateSha,
              environment: result.environment,
              provider: result.provider,
              providerExternalId: result.externalId,
              providerUrl: safeHttpUrl(result.url),
              summary: result.summary,
              metadata: {
                ...result.metadata,
                operationId: operation.id,
                providerStartedAt: result.startedAt?.toISOString() ?? null,
                candidateMismatch,
                environmentMismatch,
                stale: lineageMismatch,
                expectedCandidateSha: operation.candidateSha,
                expectedEnvironment: operation.environment,
              },
              observedAt: result.observedAt,
            },
            sourceKind: "provider_observation",
            authority: "provider_verified",
            actor: { actorType: "system" },
            sourceFingerprint: providerFingerprint,
            factoryProvenance: deliveryFactoryProvenance(operation.metadata),
            allowReservedMetadata: true,
          });
          return {
            operation: toExternalOperation(updated),
            event: eventResult.event,
            eventCreated: eventResult.created,
            candidateMismatch,
            environmentMismatch,
          };
        });
    },
  };
}
