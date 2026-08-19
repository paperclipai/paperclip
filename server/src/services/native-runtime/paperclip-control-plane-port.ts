import { and, asc, eq, gt, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
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
  validatePrpEvent,
  validatePrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { nativeSha256 } from "./canonical.js";

export interface PaperclipControlPlaneBinding {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  completionContractId: string;
  completionContractSha256: string;
  sourceInstanceId: string;
  controlPlaneSourceInstanceId: string;
}

function isPrpEvent(value: NativeRunEvent | PrpEvent): value is PrpEvent {
  return "schema" in value && value.schema === "paperclip.prp.event.v1";
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
  readonly #binding: PaperclipControlPlaneBinding;
  #sessionId: string | null = null;

  constructor(db: Db, binding: PaperclipControlPlaneBinding) {
    this.#db = db;
    this.#binding = structuredClone(binding);
  }

  async openRun(input: OpenControlPlaneRunInput): Promise<void> {
    const identity = input.identity;
    if (
      identity.companyId !== this.#binding.companyId
      || identity.issueId !== this.#binding.issueId
      || identity.runId !== this.#binding.runId
      || identity.agentId !== this.#binding.agentId
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
    if (!run || run.runtimeMode !== "native" || run.completionContractId !== this.#binding.completionContractId) {
      throw new Error("native_open_run_not_authorized");
    }
    this.#sessionId = identity.sessionId;
  }

  async loadSessionCheckpoint(): Promise<PersistedNativeSession | null> {
    const run = await this.#db.select({
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      runtimeMode: heartbeatRuns.runtimeMode,
      nativeSessionId: heartbeatRuns.nativeSessionId,
      runnerProfileJson: heartbeatRuns.runnerProfileJson,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, this.#binding.runId))
      .limit(1).then((rows) => rows[0] ?? null);
    if (
      !run
      || run.companyId !== this.#binding.companyId
      || run.agentId !== this.#binding.agentId
      || run.runtimeMode !== "native"
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

  async checkpointSession(snapshot: PersistedNativeSession): Promise<void> {
    const identity = snapshot.identity;
    if (
      identity.companyId !== this.#binding.companyId
      || identity.issueId !== this.#binding.issueId
      || identity.runId !== this.#binding.runId
      || identity.agentId !== this.#binding.agentId
      || this.#sessionId !== identity.sessionId
    ) throw new Error("native_session_checkpoint_binding_mismatch");
    await this.#db.transaction(async (tx) => {
      const run = await tx.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, this.#binding.runId)).for("update").limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !run
        || run.companyId !== this.#binding.companyId
        || run.agentId !== this.#binding.agentId
        || run.runtimeMode !== "native"
        || run.nativeSessionId !== identity.sessionId
      ) throw new Error("native_session_checkpoint_binding_mismatch");
      await tx.update(heartbeatRuns).set({
        runnerProfileJson: {
          ...record(run.runnerProfileJson),
          sessionCheckpoint: structuredClone(snapshot) as unknown as Record<string, unknown>,
        },
        sessionIdAfter: snapshot.providerSessionId ?? snapshot.sessionId,
        nativePhase: snapshot.semanticResult ? "workspace_finalizing" : "observed",
        nativePhaseUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.#binding.runId));
    });
  }

  async appendEvent(value: NativeRunEvent | PrpEvent) {
    if (!isPrpEvent(value)) throw new Error("native_legacy_event_not_supported");
    const validated = validatePrpEvent(value);
    if (!validated.ok) throw new Error(`native_event_schema_invalid:${validated.issues[0]?.message ?? "unknown"}`);
    const event = validated.event;
    if (event.runId !== this.#binding.runId || (this.#sessionId && event.normalizedSessionId !== this.#sessionId)) {
      throw new Error("native_event_binding_mismatch");
    }
    const expectedSourceInstanceId = event.sourceKind === "control_plane"
      ? this.#binding.controlPlaneSourceInstanceId
      : this.#binding.sourceInstanceId;
    if (event.sourceInstanceId !== expectedSourceInstanceId) {
      throw new Error("native_event_source_binding_mismatch");
    }
    const persisted = await appendHeartbeatRunEvent(this.#db, {
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

  async completeRun(value: NativeRunResult | CompleteControlPlaneRunInput): Promise<void> {
    if (!isCompleteInput(value)) throw new Error("native_structured_result_required");
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

    await this.#db.transaction(async (tx) => {
      const run = await tx.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, this.#binding.runId)).for("update").limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !run
        || run.companyId !== this.#binding.companyId
        || run.runtimeMode !== "native"
        || run.completionContractId !== this.#binding.completionContractId
        || run.completionContractSha256 !== this.#binding.completionContractSha256
      ) throw new Error("native_result_binding_mismatch");

      const callerConditions = [eq(nativeRunResults.serverFingerprint, serverFingerprint)];
      if (value.callerResultId) callerConditions.push(eq(nativeRunResults.callerResultId, value.callerResultId));
      if (value.callerDedupeKey) callerConditions.push(eq(nativeRunResults.callerDedupeKey, value.callerDedupeKey));
      const existing = await tx.select().from(nativeRunResults)
        .where(and(eq(nativeRunResults.runId, this.#binding.runId), or(...callerConditions)))
        .limit(1).then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.canonicalSha256 !== canonicalSha256) throw new Error("structured_result_replay_conflict");
        return;
      }
      const resultJson = {
        result: validated.result,
        terminal: value.terminal,
      } as unknown as Record<string, unknown>;
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
          failureCode: null,
          failureDetail: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
        },
      });
      await tx.update(heartbeatRuns).set({
        nativePhase: "workspace_finalizing",
        nativePhaseUpdatedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.#binding.runId));
    });
  }
}
