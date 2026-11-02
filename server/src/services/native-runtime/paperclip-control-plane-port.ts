import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import { notifyNativeWorkspaceFinalization } from "../native-workspace-finalization-notifications.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  nativeRunnerCheckpoints,
} from "@paperclipai/db";
import type {
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  NativeRunEvent,
  NativeRunResult,
  OpenControlPlaneRunInput,
  PersistedNativeSession,
  PrpEvent,
  PrpTerminalState,
  ReplayControlPlaneEventsInput,
} from "../../vendor/paperclip-runner/index.js";
import {
  normalizePrpResultSignals,
  validatePrpEvent,
  validatePrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { publishLiveEvent } from "../live-events.js";
import { nativeSha256 } from "./canonical.js";
import { redactRunnerApiEvent, redactRunnerApiPayloads } from "./runner-api-log-redaction.js";
import { createNativeControllerRecovery, NATIVE_CONTROLLER_RECOVERY_MAX_BYTES, type NativeControllerCompatibility } from "./native-controller-recovery.js";
import { eligibleNativeTaskSessionPublication, publishNativeTaskSessionInTransaction, NATIVE_TASK_SESSION_PUBLICATION_KEY,
  type NativeTaskSessionPublicationContext, type NativeTaskSessionPublicationIssue } from "./native-task-session-publication.js";
import { lockNativeRunnerCheckpointOwner, nativeRunnerCheckpointOwnerLock, validateNativeRunnerCheckpointOwner, inspectNativeRunnerUpgradeHeader, type NativeRunnerCheckpointOwner } from "./native-runner-checkpoint.js";

export interface PaperclipControlPlaneBinding {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  completionContractId: string;
  completionContractSha256: string;
  sourceInstanceId: string;
  controlPlaneSourceInstanceId: string;
}

const IDENTITY_DELTA_RETRY_WINDOW = 1_024;
const IDENTITY_DELTA_RETRY_BYTES = 4 * 1024 * 1024;

function isPrpEvent(value: NativeRunEvent | PrpEvent): value is PrpEvent {
  return "schema" in value && [
    "paperclip.prp.event.v1",
    "paperclip.prp.event.v2",
    "paperclip.prp.event.v3",
  ].includes(value.schema);
}

function isCompleteInput(value: NativeRunResult | CompleteControlPlaneRunInput): value is CompleteControlPlaneRunInput {
  return "result" in value && "terminal" in value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertTerminal(value: unknown): asserts value is PrpTerminalState {
  const terminal = value as Partial<PrpTerminalState> | null;
  if (
    terminal?.schema !== "paperclip.prp.terminal.v1"
    || !["completed", "failed", "interrupted", "cancelled"].includes(String(terminal.turnTerminalState))
    || !["succeeded", "failed", "cancelled"].includes(String(terminal.runTerminalState))
    || !["done", "blocked", "needs_review", "yielded"].includes(String(terminal.reportedWorkDisposition))
  ) {
    throw new Error("native_terminal_schema_invalid");
  }
}

/** Production implementation of the runner package's deliberately narrow persistence port. */
export class PaperclipControlPlanePort implements ControlPlanePort {
  readonly #db: Db;
  readonly #identityRedactor: ReturnType<typeof createAgentIdentityRedactor>;
  readonly #redactedDeltas = new Map<string, { event: PrpEvent; originalSha: string; bytes: number }>();
  #redactedDeltaBytes = 0;
  readonly #binding: PaperclipControlPlaneBinding;
  #sessionId: string | null = null;
  readonly #assertControllerActive?: () => void;
  readonly #assertRunAdmissionActive?: () => void;
  readonly #onResultCommitted?: () => Promise<void>;
  readonly #onEventPersistence?: (event: PrpEvent, startedAtMs: number, endedAtMs: number) => Promise<void>;
  readonly #onCommittedEvent?: (event: PrpEvent, cursor: number) => Promise<void>;
  readonly #onDuplicateEvent?: (event: PrpEvent, cursor: number) => Promise<void>;
  readonly #nativeRecovery?: { compatibility: NativeControllerCompatibility; owner: NativeRunnerCheckpointOwner };
  readonly #taskSessionPublication?: NativeTaskSessionPublicationContext;
  readonly #taskSessionPublicationOwner?: NativeRunnerCheckpointOwner;

  constructor(
    db: Db,
    binding: PaperclipControlPlaneBinding,
    options: {
      /** Runtime-only secret; never part of the persisted binding. */
      privateKeyPem?: string;
      /** Synchronous revocation fence for a controller handing off on restart. */
      assertControllerActive?: () => void;
      /** Read-only admission may finish an existing startup solely for restart detachment. */
      assertRunAdmissionActive?: () => void;
      onResultCommitted?: () => Promise<void>;
      onEventPersistence?: (event: PrpEvent, startedAtMs: number, endedAtMs: number) => Promise<void>;
      onCommittedEvent?: (event: PrpEvent, cursor: number) => Promise<void>;
      onDuplicateEvent?: (event: PrpEvent, cursor: number) => Promise<void>;
      nativeRecovery?: { compatibility: NativeControllerCompatibility; owner: NativeRunnerCheckpointOwner };
      taskSessionPublication?: NativeTaskSessionPublicationContext;
      taskSessionPublicationOwner?: NativeRunnerCheckpointOwner;
    } = {},
  ) {
    this.#db = db;
    this.#assertControllerActive = options.assertControllerActive;
    this.#assertRunAdmissionActive = options.assertRunAdmissionActive ?? options.assertControllerActive;
    this.#identityRedactor = createAgentIdentityRedactor(options.privateKeyPem);
    this.#binding = structuredClone(binding);
    this.#onCommittedEvent = options.onCommittedEvent;
    this.#onEventPersistence = options.onEventPersistence;
    this.#onResultCommitted = options.onResultCommitted;
    this.#onDuplicateEvent = options.onDuplicateEvent;
    this.#nativeRecovery = options.nativeRecovery;
    this.#taskSessionPublication = options.taskSessionPublication ? structuredClone(options.taskSessionPublication) : undefined;
    this.#taskSessionPublicationOwner = options.taskSessionPublicationOwner;
  }

  #assertActive(options?: { signal: AbortSignal }): void {
    this.#assertControllerActive?.();
    options?.signal.throwIfAborted();
  }

  #matchesPersistedBinding(run: Pick<typeof heartbeatRuns.$inferSelect,
    "companyId" | "agentId" | "runtimeMode" | "nativeIssueId" | "nativeSessionId" |
    "runnerInstanceId" | "completionContractId" | "completionContractSha256">): boolean {
    return run.companyId === this.#binding.companyId
      && run.agentId === this.#binding.agentId
      && run.runtimeMode === "native"
      && run.nativeIssueId === this.#binding.issueId
      && run.nativeSessionId === this.#binding.sessionId
      && run.runnerInstanceId === this.#binding.sourceInstanceId
      && run.completionContractId === this.#binding.completionContractId
      && run.completionContractSha256 === this.#binding.completionContractSha256;
  }

  async openRun(input: OpenControlPlaneRunInput): Promise<void> {
    this.#assertRunAdmissionActive?.();
    const identity = input.identity;
    if (
      identity.companyId !== this.#binding.companyId
      || identity.issueId !== this.#binding.issueId
      || identity.runId !== this.#binding.runId
      || identity.agentId !== this.#binding.agentId
      || identity.sessionId !== this.#binding.sessionId
      || input.sourceInstanceId !== this.#binding.sourceInstanceId
    ) {
      throw new Error("native_open_run_binding_mismatch");
    }
    const run = await this.#db.select().from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, this.#binding.runId),
        eq(heartbeatRuns.companyId, this.#binding.companyId),
        eq(heartbeatRuns.agentId, this.#binding.agentId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || !this.#matchesPersistedBinding(run)) {
      throw new Error("native_open_run_not_authorized");
    }
    this.#assertRunAdmissionActive?.();
    this.#sessionId = identity.sessionId;
  }

  async loadSessionCheckpoint(): Promise<PersistedNativeSession | null> {
    const run = await this.#db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, this.#binding.runId))
      .limit(1).then((rows) => rows[0] ?? null);
    if (
      !run
      || !this.#matchesPersistedBinding(run)
    ) throw new Error("native_session_checkpoint_binding_mismatch");
    const candidate = record(run.runnerProfileJson).sessionCheckpoint;
    if (candidate === undefined || candidate === null) return null;
    const snapshot = record(candidate) as Partial<PersistedNativeSession>;
    const identity = record(snapshot.identity);
    if (
      typeof snapshot.sessionId !== "string"
      || identity.companyId !== this.#binding.companyId
      || identity.issueId !== this.#binding.issueId
      || identity.runId !== this.#binding.runId
      || identity.agentId !== this.#binding.agentId
      || identity.sessionId !== run.nativeSessionId
    ) throw new Error("native_session_checkpoint_invalid");
    return structuredClone(snapshot as PersistedNativeSession);
  }

  normalizeReplayPayload(payload: PrpEvent["payload"]): PrpEvent["payload"] {
    return redactRunnerApiPayloads(this.#identityRedactor.redact(payload));
  }

  async checkpointSession(snapshot: PersistedNativeSession, options?: { signal: AbortSignal }): Promise<void> {
    this.#assertActive(options);
    snapshot = redactRunnerApiPayloads(this.#identityRedactor.redact(snapshot));
    const identity = snapshot.identity;
    if (
      identity.companyId !== this.#binding.companyId
      || identity.issueId !== this.#binding.issueId
      || identity.runId !== this.#binding.runId
      || identity.agentId !== this.#binding.agentId
      || this.#sessionId !== identity.sessionId
    ) throw new Error("native_session_checkpoint_binding_mismatch");
    const publication = this.#taskSessionPublication && eligibleNativeTaskSessionPublication(snapshot)
      ? this.#taskSessionPublication : null;
    if (publication && !this.#taskSessionPublicationOwner) throw new Error("native_task_session_publication_owner_required");
    await this.#db.transaction(async (tx) => {
      const recovery = this.#nativeRecovery;
      const owner = recovery?.owner ?? (publication ? this.#taskSessionPublicationOwner : undefined);
      if (publication && recovery && nativeSha256(recovery.owner) !== nativeSha256(this.#taskSessionPublicationOwner)) {
        throw new Error("native_task_session_publication_owner_mismatch");
      }
      const ownerLock = owner ? nativeRunnerCheckpointOwnerLock(tx, owner) : null;
      // NO KEY UPDATE serializes reset/admission fields while remaining compatible
      // with completeRun's parent KEY SHARE. Keep coordinator → issue → run order.
      const publicationIssue = publication ? tx.$with("publication_issue").as(tx.select({
        id: issues.id, companyId: issues.companyId, executionRunId: issues.executionRunId,
        conversationAgentId: issues.conversationAgentId, conversationSessionGeneration: issues.conversationSessionGeneration,
      }).from(issues).where(and(eq(issues.id, this.#binding.issueId), eq(issues.companyId, this.#binding.companyId),
        ownerLock ? sql`exists (select 1 from ${ownerLock})` : undefined)).for("no key update")) : null;
      const lockedRun = tx.$with("snapshot_run").as(tx.select({
        id: heartbeatRuns.id, status: heartbeatRuns.status,
        contextSnapshot: (publication ? sql<Record<string, unknown>>`jsonb_build_object('conversationSessionGeneration', ${heartbeatRuns.contextSnapshot}->'conversationSessionGeneration')` : sql<null>`null`).as("publication_context"),
        resultJson: (publication ? sql<Record<string, unknown>>`jsonb_build_object('nativeCancellation', ${heartbeatRuns.resultJson}->'nativeCancellation',
          'cancellation', ${heartbeatRuns.resultJson}->'cancellation', 'startupCancellation', ${heartbeatRuns.resultJson}->'startupCancellation')` : sql<null>`null`).as("publication_cancellation"),
        startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt,
        companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        runtimeMode: heartbeatRuns.runtimeMode, nativeIssueId: heartbeatRuns.nativeIssueId,
        nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
        completionContractId: heartbeatRuns.completionContractId,
        completionContractSha256: heartbeatRuns.completionContractSha256,
        runnerProfileJson: heartbeatRuns.runnerProfileJson,
      }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, this.#binding.runId), ownerLock
          ? sql`exists (select 1 from ${ownerLock})` : undefined,
          publicationIssue ? sql`exists (select 1 from ${publicationIssue})` : undefined)).for("update"));
      // Project the locking CTE's tuples, including any update committed while
      // the lock waited. A second scan of heartbeat_runs could see an old MVCC tuple.
      // The run CTE depends on the coordinator CTE: both locks precede the
      // outer clock sample, including when either lock waits.
      const selected = await tx.with(...(ownerLock ? [ownerLock] : []), ...(publicationIssue ? [publicationIssue] : []), lockedRun).select({ run: {
        id: lockedRun.id, status: lockedRun.status, contextSnapshot: lockedRun.contextSnapshot, resultJson: lockedRun.resultJson,
        startedAt: lockedRun.startedAt, createdAt: lockedRun.createdAt,
        companyId: lockedRun.companyId, agentId: lockedRun.agentId,
        runtimeMode: lockedRun.runtimeMode, nativeIssueId: lockedRun.nativeIssueId,
        nativeSessionId: lockedRun.nativeSessionId, runnerInstanceId: lockedRun.runnerInstanceId,
        completionContractId: lockedRun.completionContractId,
        completionContractSha256: lockedRun.completionContractSha256,
        runnerProfileJson: lockedRun.runnerProfileJson,
      }, now: sql<Date>`clock_timestamp()`, ...(ownerLock ? {
        leaseOwner: sql<string | null>`(select ${ownerLock.leaseOwner} from ${ownerLock})`,
        leaseExpiresAt: sql<Date | null>`(select ${ownerLock.leaseExpiresAt} from ${ownerLock})`.mapWith(nativeRunFinalizations.leaseExpiresAt),
        resultId: sql<string | null>`(select ${ownerLock.resultId} from ${ownerLock})`,
      } : {}), ...(recovery ? {
        checkpointHeader: sql<Record<string, unknown> | null>`(select material from ${nativeRunnerCheckpoints}
          where ${nativeRunnerCheckpoints.runId} = ${this.#binding.runId}
            and ${nativeRunnerCheckpoints.companyId} = ${this.#binding.companyId}
            and ${nativeRunnerCheckpoints.issueId} = ${this.#binding.issueId}
            and ${nativeRunnerCheckpoints.part} = 'header')`,
        } : {}), ...(publicationIssue ? { publicationIssue: sql<NativeTaskSessionPublicationIssue>`(select jsonb_build_object(
          'id', ${publicationIssue.id}, 'companyId', ${publicationIssue.companyId}, 'executionRunId', ${publicationIssue.executionRunId},
          'conversationAgentId', ${publicationIssue.conversationAgentId}, 'conversationSessionGeneration', ${publicationIssue.conversationSessionGeneration}) from ${publicationIssue})` } : {}),
      }).from(lockedRun).limit(1)
        .then((rows) => rows[0] ?? null);
      const run = selected?.run;
      this.#assertActive(options);
      if (owner && !selected) throw new Error("native_runner_checkpoint_owner_lost");
      if (!run || !this.#matchesPersistedBinding(run)) {
        throw new Error("native_session_checkpoint_binding_mismatch");
      }
      // The run row lock may have waited beyond our lease. Generation cannot
      // change while we hold the coordinator, but wall-clock expiry still can.
      if (owner && selected) await validateNativeRunnerCheckpointOwner(tx, owner,
        { leaseOwner: selected.leaseOwner ?? null, leaseExpiresAt: selected.leaseExpiresAt ?? null,
          resultId: selected.resultId ?? null, now: selected.now }, !snapshot.semanticResult);
      const header = recovery && selected?.checkpointHeader
        ? inspectNativeRunnerUpgradeHeader(this.#binding, selected.checkpointHeader) : null;
      if (header && (header.normalizedSessionId !== identity.sessionId || header.runnerInstanceId !== this.#binding.sourceInstanceId)) {
        throw new Error("native_session_checkpoint_prp_binding_mismatch");
      }
      const profile: Record<string, unknown> = {
          ...record(run.runnerProfileJson),
          sessionCheckpoint: structuredClone(snapshot) as unknown as Record<string, unknown>,
          ...(recovery ? { nativeControllerRecovery: createNativeControllerRecovery(snapshot, recovery.compatibility,
            header ? { runId: this.#binding.runId, runnerInstanceId: header.runnerInstanceId,
              normalizedSessionId: header.normalizedSessionId } : null) } : {}),
        };
      // Driver/live snapshots may already describe a terminal result before
      // completeRun accepts it. Persist that observation without a handled
      // receipt; the existing post-acceptance checkpoint publishes the pointer.
      if (publication && selected?.resultId) {
        const receipt = await publishNativeTaskSessionInTransaction(tx, { binding: this.#binding, context: publication,
          snapshot, run, issue: selected.publicationIssue ?? null, resultId: selected.resultId ?? null,
          recoveryReady: !recovery || header !== null });
        profile[NATIVE_TASK_SESSION_PUBLICATION_KEY] = receipt;
        if (Buffer.byteLength(JSON.stringify({ nativeControllerRecovery: profile.nativeControllerRecovery,
          [NATIVE_TASK_SESSION_PUBLICATION_KEY]: receipt })) > NATIVE_CONTROLLER_RECOVERY_MAX_BYTES) {
          throw new Error("native_task_session_publication_metadata_too_large");
        }
      }
      await tx.update(heartbeatRuns).set({
        runnerProfileJson: profile,
        sessionIdAfter: snapshot.providerSessionId ?? snapshot.sessionId,
        nativePhase: snapshot.semanticResult ? "workspace_finalizing" : "observed",
        nativePhaseUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.#binding.runId));
      this.#assertActive(options);
    });
  }

  async appendEvent(value: NativeRunEvent | PrpEvent, options?: { signal: AbortSignal }) {
    const persistenceStartedAt = Date.now(), persistenceClock = performance.now();
    this.#assertActive(options);
    if (!isPrpEvent(value)) throw new Error("native_legacy_event_not_supported");
    const validated = validatePrpEvent(value);
    if (!validated.ok) throw new Error(`native_event_schema_invalid:${validated.issues[0]?.message ?? "unknown"}`);
    let event = this.#identityRedactor.redact(validated.event);
    if (event.runId !== this.#binding.runId || (this.#sessionId && event.normalizedSessionId !== this.#sessionId)) {
      throw new Error("native_event_binding_mismatch");
    }
    const expectedSourceInstanceId = event.sourceKind === "control_plane"
      ? this.#binding.controlPlaneSourceInstanceId
      : this.#binding.sourceInstanceId;
    if (event.sourceInstanceId !== expectedSourceInstanceId) {
      throw new Error("native_event_source_binding_mismatch");
    }
    const terminalItem = /^item\.(completed|failed|cancelled)$/.test(event.eventType);
    const terminalTurn = /^(turn|session)\.(completed|failed|cancelled|interrupted|closed)$/.test(event.eventType);
    if ((event.eventType === "item.delta" || terminalItem || terminalTurn) && this.#identityRedactor.values.length > 0) {
      const key = `${event.sourceInstanceId}:${event.sourceEventId}`;
      const cached = this.#redactedDeltas.get(key);
      const originalSha = nativeSha256(validated.event);
      if (cached) {
        if (cached.originalSha !== originalSha) throw new Error("native_event_source_payload_conflict");
        event = cached.event;
      } else {
        const stream = `${event.sourceInstanceId}:${event.turnId}:${event.itemId}`;
        event = { ...event, payload: event.eventType === "item.delta"
          ? this.#identityRedactor.delta(stream, validated.event.payload, event.itemId)
          : this.#identityRedactor.settleDeltas(
            terminalTurn ? (event.eventType.startsWith("session.") ? `${event.sourceInstanceId}:` : `${event.sourceInstanceId}:${event.turnId}:`) : stream,
            event.payload, terminalTurn,
          ),
        };
        // Retries must use the same redacted payload without consuming a delta twice.
        const bytes = Buffer.byteLength(JSON.stringify(event));
        this.#redactedDeltas.set(key, { event, originalSha, bytes });
        this.#redactedDeltaBytes += bytes;
        // Match the bounded runner transcript retry window; large tool output
        // also has a byte cap so long runs cannot retain another full transcript.
        while (this.#redactedDeltas.size > IDENTITY_DELTA_RETRY_WINDOW || this.#redactedDeltaBytes > IDENTITY_DELTA_RETRY_BYTES) {
          const oldest = this.#redactedDeltas.keys().next().value!;
          this.#redactedDeltaBytes -= this.#redactedDeltas.get(oldest)!.bytes;
          this.#redactedDeltas.delete(oldest);
        }
      }
    }
    event = redactRunnerApiEvent(event);
    const persisted = await this.#db.transaction(async tx => {
      this.#assertActive(options);
      const receipt = await appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId: this.#binding.companyId,
        runId: this.#binding.runId,
        agentId: this.#binding.agentId,
        eventType: event.eventType,
        stream: "system",
        level: event.eventType.includes("failed") ? "error" : "info",
        payload: { prpEvent: event as unknown as Record<string, unknown> },
        nativeSource: {
          sourceInstanceId: event.sourceInstanceId,
          sourceEventId: event.sourceEventId,
          sourceSeq: event.sourceSeq,
          protocolSchemaVersion: event.schemaVersion,
          canonicalPayload: event as unknown as Record<string, unknown>,
        },
      });
      // The nested append has no publication side effects. Revocation rolls
      // back its event and sequence allocation before the outer commit.
      this.#assertActive(options);
      return receipt;
    });
    this.#assertActive(options);
    try { await this.#onEventPersistence?.(event, persistenceStartedAt, persistenceStartedAt + performance.now() - persistenceClock); } catch {}
    if (persisted.disposition === "committed") {
      try {
        publishLiveEvent({
          companyId: this.#binding.companyId,
          type: "heartbeat.run.event",
          payload: {
            runId: this.#binding.runId,
            agentId: this.#binding.agentId,
            issueId: this.#binding.issueId,
            seq: persisted.row.seq,
            eventType: persisted.row.eventType,
            stream: persisted.row.stream,
            level: persisted.row.level,
            payload: persisted.row.payload,
          },
        });
      } catch {
      }
      await this.#onCommittedEvent?.(event, persisted.row.seq);
    } else {
      // A recovered runner may replay the event whose durable side effects
      // parked the prior attempt. Do not repeat those effects, but let the
      // embedding runtime refresh observational state before appendEvent
      // returns to its synchronous governed-wait boundary.
      await this.#onDuplicateEvent?.(event, persisted.row.seq);
    }
    return {
      cursor: persisted.row.seq,
      highestContiguousSourceSeq: persisted.highestContiguousSourceSeq,
      disposition: persisted.disposition,
    };
  }

  async replayEvents(input: ReplayControlPlaneEventsInput) {
    if (
      input.runId !== this.#binding.runId
      || ![this.#binding.sourceInstanceId, this.#binding.controlPlaneSourceInstanceId].includes(input.sourceInstanceId)
    ) {
      throw new Error("native_replay_binding_mismatch");
    }
    const rows = await this.#db
      .select({ payload: heartbeatRunEvents.payload, sourceSeq: heartbeatRunEvents.sourceSeq })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.runId, this.#binding.runId),
        eq(heartbeatRunEvents.sourceInstanceId, input.sourceInstanceId),
        gt(heartbeatRunEvents.sourceSeq, input.afterSourceSeq),
      ))
      .orderBy(asc(heartbeatRunEvents.sourceSeq))
      .limit(Math.max(1, Math.min(input.limit, 1_000)));
    const events = rows.flatMap((row) => {
      const candidate = row.payload?.prpEvent;
      const parsed = validatePrpEvent(candidate);
      return parsed.ok ? [parsed.event] : [];
    });
    let cursor = input.afterSourceSeq;
    for (const event of events) {
      if (event.sourceSeq === cursor + 1) cursor += 1;
      else if (event.sourceSeq > cursor + 1) break;
    }
    return { events, highestContiguousSourceSeq: cursor };
  }

  async completeRun(value: NativeRunResult | CompleteControlPlaneRunInput, options?: { signal: AbortSignal }): Promise<void> {
    this.#assertActive(options);
    value = redactRunnerApiPayloads(this.#identityRedactor.redact(value));
    if (!isCompleteInput(value)) throw new Error("native_structured_result_required");
    // Capture compatibility diagnostics before canonical validation removes
    // legacy/non-actionable attention payloads. They are operator evidence,
    // not part of the authoritative semantic result.
    const normalizationDiagnostics = normalizePrpResultSignals(value.result);
    const validated = validatePrpStructuredRunResult(value.result);
    if (!validated.ok) throw new Error(`native_result_schema_invalid:${validated.issues[0]?.message ?? "unknown"}`);
    assertTerminal(value.terminal);
    if (validated.result.reportedWorkDisposition !== value.terminal.reportedWorkDisposition) {
      throw new Error("native_result_terminal_disposition_mismatch");
    }
    const canonical = {
      binding: this.#binding,
      result: validated.result,
      terminal: value.terminal,
      turnId: value.turnId ?? null,
    };
    const canonicalSha256 = nativeSha256(canonical);
    const serverFingerprint = nativeSha256({
      runId: this.#binding.runId,
      completionContractSha256: this.#binding.completionContractSha256,
      canonicalSha256,
    });

    const insertedResult = await this.#db.transaction(async (tx) => {
      // Status commit and snapshot publication lock coordinator → issue → run.
      // A replay must follow that order too: holding the issue while waiting
      // for the coordinator deadlocks a status commit's issue UPDATE lock.
      const recovery = this.#nativeRecovery;
      const owner = recovery ? await lockNativeRunnerCheckpointOwner(tx, recovery.owner) : null;
      // Result insertion checks the task FK. Keep its parent lock before run.
      await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, this.#binding.issueId), eq(issues.companyId, this.#binding.companyId)))
        .for("key share");
      const run = await tx.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, this.#binding.runId)).for("update").limit(1)
        .then((rows) => rows[0] ?? null);
      this.#assertActive(options);
      if (!run || !this.#matchesPersistedBinding(run)) {
        throw new Error("native_result_binding_mismatch");
      }
      if (recovery && owner) {
        const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
        await validateNativeRunnerCheckpointOwner(tx, recovery.owner, { ...owner, now: clock.now }, false);
      }

      const callerConditions = [eq(nativeRunResults.serverFingerprint, serverFingerprint)];
      if (value.callerResultId) callerConditions.push(eq(nativeRunResults.callerResultId, value.callerResultId));
      if (value.callerDedupeKey) callerConditions.push(eq(nativeRunResults.callerDedupeKey, value.callerDedupeKey));
      const existing = await tx.select().from(nativeRunResults)
        .where(and(eq(nativeRunResults.runId, this.#binding.runId), or(...callerConditions)))
        .limit(1).then((rows) => rows[0] ?? null);
      if (existing) {
        this.#assertActive(options);
        if (existing.canonicalSha256 !== canonicalSha256) throw new Error("structured_result_replay_conflict");
        return false;
      }
      if (owner?.resultId) throw new Error("structured_result_replay_conflict");
      const resultJson = {
        result: validated.result,
        terminal: value.terminal,
        normalizationDiagnostics: {
          ignoredAttentionRequests: normalizationDiagnostics.ignoredAttentionRequests,
        },
      } as unknown as Record<string, unknown>;
      await notifyNativeResultCommit(tx, this.#binding);
      await notifyNativeWorkspaceFinalization(tx, this.#binding);
      const inserted = await tx.insert(nativeRunResults).values({
        companyId: this.#binding.companyId,
        issueId: this.#binding.issueId,
        runId: this.#binding.runId,
        turnId: value.turnId ?? null,
        completionContractId: this.#binding.completionContractId,
        callerResultId: value.callerResultId ?? null,
        callerDedupeKey: value.callerDedupeKey ?? null,
        serverFingerprint,
        schemaStatus: "accepted",
        resultJson,
        canonicalSha256,
      }).returning().then((rows) => rows[0]);
      if (!inserted) throw new Error("native_result_not_persisted");
      await tx.insert(nativeRunFinalizations).values({
        runId: this.#binding.runId,
        companyId: this.#binding.companyId,
        issueId: this.#binding.issueId,
        phase: "workspace_finalizing",
        resultId: inserted.id,
      }).onConflictDoUpdate({
        target: nativeRunFinalizations.runId,
        set: {
          phase: "workspace_finalizing",
          resultId: inserted.id,
          recoveryState: null,
          recoveryRequestId: null,
          failureCode: null,
          failureDetail: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        },
      });
      await tx.update(heartbeatRuns).set({
        nativePhase: "workspace_finalizing",
        nativePhaseUpdatedAt: new Date(),
        resultJson: {
          ...record(run.resultJson),
          // Publish the accepted contract with its durable receipt. Recovery
          // may settle this run without the original adapter ever returning.
          nativeTerminal: value.terminal,
          prpTurnTerminalState: value.terminal.turnTerminalState,
          prpRunTerminalState: value.terminal.runTerminalState,
          prpReportedWorkDisposition: value.terminal.reportedWorkDisposition,
        },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.#binding.runId));
      this.#assertActive(options);
      return true;
    });
    if (insertedResult) { try { await this.#onResultCommitted?.(); } catch {} }
  }
}
