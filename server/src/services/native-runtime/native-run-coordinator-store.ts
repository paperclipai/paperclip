import { createHash } from "node:crypto";

import { and, desc, eq, inArray, lt } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  type PrpEvent,
  type PrpStructuredRunResult,
  type PrpTerminalState,
  validatePrpEvent,
  validatePrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";

export interface NativeRunStoreBinding {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly normalizedSessionId: string;
  readonly runnerSourceInstanceId: string;
  readonly completionContractId: string;
  readonly completionContractSha256: string;
  readonly completionContractRevision: string;
  readonly completionContractCriterionIds: readonly string[];
}

export interface CompleteNativeRunInput {
  readonly result: PrpStructuredRunResult;
  readonly terminal: PrpTerminalState;
  readonly turnId?: string;
  readonly callerResultId?: string;
  readonly callerDedupeKey?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function assertTerminal(value: unknown): asserts value is PrpTerminalState {
  const terminal = value as Partial<PrpTerminalState> | null;
  if (
    typeof value !== "object" ||
    terminal === null ||
    Array.isArray(value) ||
    terminal.schema !== "paperclip.prp.terminal.v1" ||
    typeof terminal.turnTerminalState !== "string" ||
    !["completed", "failed", "interrupted", "cancelled"].includes(
      terminal.turnTerminalState,
    ) ||
    typeof terminal.runTerminalState !== "string" ||
    !["succeeded", "failed", "cancelled"].includes(terminal.runTerminalState) ||
    typeof terminal.reportedWorkDisposition !== "string" ||
    !["done", "blocked", "needs_review", "yielded"].includes(
      terminal.reportedWorkDisposition,
    )
  ) {
    throw new Error("native_terminal_schema_invalid");
  }
}

function validateBoundCompletion(
  binding: NativeRunStoreBinding,
  result: unknown,
  terminal: unknown,
): { result: PrpStructuredRunResult; terminal: PrpTerminalState } {
  const validated = validatePrpStructuredRunResult(result);
  if (!validated.ok) throw new Error("native_result_schema_invalid");
  assertTerminal(terminal);
  if (
    validated.result.completionClaim.contractRevision !==
    binding.completionContractRevision
  ) {
    throw new Error("native_result_completion_contract_mismatch");
  }
  const reportedCriterionIds = validated.result.completionClaim.criteria.map(
    (criterion) => criterion.criterionId,
  );
  if (
    reportedCriterionIds.length !== binding.completionContractCriterionIds.length
    || reportedCriterionIds.some(
      (criterionId, index) =>
        criterionId !== binding.completionContractCriterionIds[index],
    )
  ) {
    throw new Error("native_result_completion_contract_mismatch");
  }
  if (
    validated.result.reportedWorkDisposition !==
    terminal.reportedWorkDisposition
  ) {
    throw new Error("native_result_terminal_disposition_mismatch");
  }
  return { result: validated.result, terminal };
}

/** Durable DB boundary used by the hidden PRP coordinator. */
export class NativeRunCoordinatorStore {
  readonly #db: Db;
  readonly #binding: NativeRunStoreBinding;

  constructor(db: Db, binding: NativeRunStoreBinding) {
    this.#db = db;
    this.#binding = structuredClone(binding);
  }

  async readCompletedRun(): Promise<{
    readonly result: PrpStructuredRunResult;
    readonly terminal: PrpTerminalState;
    readonly turnId?: string;
  } | null> {
    const [row] = await this.#db
      .select({ resultJson: nativeRunResults.resultJson })
      .from(nativeRunResults)
      .where(
        and(
          eq(nativeRunResults.companyId, this.#binding.companyId),
          eq(nativeRunResults.issueId, this.#binding.issueId),
          eq(nativeRunResults.runId, this.#binding.runId),
          eq(nativeRunResults.schemaStatus, "accepted"),
        ),
      )
      .limit(1);
    if (!row) return null;
    const envelope = row.resultJson as Record<string, unknown>;
    if (!("result" in envelope) || !("terminal" in envelope)) {
      throw new Error("native_result_envelope_invalid");
    }
    const validated = validateBoundCompletion(
      this.#binding,
      envelope.result,
      envelope.terminal,
    );
    if (envelope.turnId !== null && envelope.turnId !== undefined && typeof envelope.turnId !== "string") {
      throw new Error("native_result_envelope_invalid");
    }
    return {
      ...validated,
      ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    };
  }

  async readProviderSessionId(): Promise<string | null> {
    const rows = await this.#db
      .select({ payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.runId, this.#binding.runId),
        eq(heartbeatRunEvents.sourceInstanceId, this.#binding.runnerSourceInstanceId),
        inArray(heartbeatRunEvents.eventType, [
          "session.started",
          "session.resumed",
          "session.reconciled",
        ]),
      ))
      .orderBy(desc(heartbeatRunEvents.sourceSeq))
      .limit(3);
    for (const row of rows) {
      const event = (row.payload as Record<string, unknown> | null)?.prpEvent;
      const payload = typeof event === "object" && event !== null && !Array.isArray(event)
        ? (event as Record<string, unknown>).payload
        : null;
      const providerSessionId = typeof payload === "object"
        && payload !== null
        && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).providerSessionId
        : null;
      if (
        typeof providerSessionId === "string"
        && providerSessionId.length > 0
        && providerSessionId.length <= 240
        && ![...providerSessionId].some((character) => /[\u0000-\u001f\u007f]/.test(character))
      ) {
        return providerSessionId;
      }
    }
    return null;
  }

  async appendEvent(value: PrpEvent): Promise<{
    readonly disposition: "committed" | "duplicate";
    readonly cursor: number;
    readonly highestContiguousSourceSeq: number;
  }> {
    const validated = validatePrpEvent(value);
    if (!validated.ok) throw new Error("native_event_schema_invalid");
    const event = validated.event;
    if (
      event.runId !== this.#binding.runId ||
      event.normalizedSessionId !== this.#binding.normalizedSessionId ||
      event.sourceKind !== "runner" ||
      event.sourceInstanceId !== this.#binding.runnerSourceInstanceId
    ) {
      throw new Error("native_event_binding_mismatch");
    }
    const canonicalPayload = event as unknown as Record<string, unknown>;
    const payloadDigest = sha256(canonicalPayload);

    return this.#db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, this.#binding.runId),
            eq(heartbeatRuns.companyId, this.#binding.companyId),
            eq(heartbeatRuns.agentId, this.#binding.agentId),
            eq(heartbeatRuns.nativeIssueId, this.#binding.issueId),
            eq(
              heartbeatRuns.nativeSessionId,
              this.#binding.normalizedSessionId,
            ),
            eq(heartbeatRuns.runtimeMode, "native"),
          ),
        )
        .for("update")
        .limit(1);
      if (!run) throw new Error("native_event_run_not_authorized");

      const [existing] = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, this.#binding.runId),
            eq(heartbeatRunEvents.sourceEventId, event.sourceEventId),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.sourcePayloadSha256 !== payloadDigest ||
          existing.sourceInstanceId !== event.sourceInstanceId ||
          existing.sourceSeq !== event.sourceSeq
        ) {
          throw new Error("native_event_replay_conflict");
        }
        const [latest] = await tx
          .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.runId, this.#binding.runId),
              eq(heartbeatRunEvents.sourceInstanceId, event.sourceInstanceId),
            ),
          )
          .orderBy(desc(heartbeatRunEvents.sourceSeq))
          .limit(1);
        return {
          disposition: "duplicate" as const,
          cursor: existing.seq,
          highestContiguousSourceSeq: latest?.sourceSeq ?? event.sourceSeq,
        };
      }

      const [previous] = await tx
        .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, this.#binding.runId),
            eq(heartbeatRunEvents.sourceInstanceId, event.sourceInstanceId),
          ),
        )
        .orderBy(desc(heartbeatRunEvents.sourceSeq))
        .limit(1);
      const expectedSourceSeq = (previous?.sourceSeq ?? 0) + 1;
      if (event.sourceSeq !== expectedSourceSeq) {
        throw new Error("native_event_source_gap");
      }

      const cursor = run.nextEventSeq;
      const [inserted] = await tx
        .insert(heartbeatRunEvents)
        .values({
          companyId: this.#binding.companyId,
          runId: this.#binding.runId,
          agentId: this.#binding.agentId,
          seq: cursor,
          eventType: event.eventType,
          stream: "system",
          level: event.eventType.includes("failed") ? "error" : "info",
          payload: { prpEvent: canonicalPayload },
          sourceInstanceId: event.sourceInstanceId,
          sourceEventId: event.sourceEventId,
          sourceSeq: event.sourceSeq,
          sourcePayloadSha256: payloadDigest,
          protocolSchemaVersion: event.schemaVersion,
        })
        .returning({ seq: heartbeatRunEvents.seq });
      if (!inserted) throw new Error("native_event_not_persisted");
      await tx
        .update(heartbeatRuns)
        .set({ nextEventSeq: cursor + 1, updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, this.#binding.runId));
      return {
        disposition: "committed" as const,
        cursor: inserted.seq,
        highestContiguousSourceSeq: event.sourceSeq,
      };
    });
  }

  async completeRun(input: CompleteNativeRunInput): Promise<{
    readonly disposition: "committed" | "duplicate";
    readonly resultId: string;
  }> {
    const validated = validateBoundCompletion(this.#binding, input.result, input.terminal);
    const canonical = {
      result: validated.result,
      terminal: validated.terminal,
      turnId: input.turnId ?? null,
    };
    const canonicalSha256 = sha256(canonical);
    const serverFingerprint = sha256({
      runId: this.#binding.runId,
      completionContractSha256: this.#binding.completionContractSha256,
      canonicalSha256,
    });

    return this.#db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, this.#binding.runId))
        .for("update")
        .limit(1);
      if (
        !run ||
        run.companyId !== this.#binding.companyId ||
        run.agentId !== this.#binding.agentId ||
        run.nativeIssueId !== this.#binding.issueId ||
        run.runtimeMode !== "native" ||
        run.completionContractId !== this.#binding.completionContractId ||
        run.completionContractSha256 !== this.#binding.completionContractSha256
      ) {
        throw new Error("native_result_run_not_authorized");
      }

      const [existing] = await tx
        .select()
        .from(nativeRunResults)
        .where(
          and(
            eq(nativeRunResults.runId, this.#binding.runId),
            eq(nativeRunResults.schemaStatus, "accepted"),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.canonicalSha256 !== canonicalSha256) {
          throw new Error("native_result_replay_conflict");
        }
        return { disposition: "duplicate" as const, resultId: existing.id };
      }

      const [inserted] = await tx
        .insert(nativeRunResults)
        .values({
          companyId: this.#binding.companyId,
          issueId: this.#binding.issueId,
          runId: this.#binding.runId,
          turnId: input.turnId ?? null,
          completionContractId: this.#binding.completionContractId,
          callerResultId: input.callerResultId ?? null,
          callerDedupeKey: input.callerDedupeKey ?? null,
          serverFingerprint,
          schemaStatus: "accepted",
          resultJson: canonical as unknown as Record<string, unknown>,
          canonicalSha256,
        })
        .returning({ id: nativeRunResults.id });
      if (!inserted) throw new Error("native_result_not_persisted");
      await tx
        .insert(nativeRunFinalizations)
        .values({
          runId: this.#binding.runId,
          companyId: this.#binding.companyId,
          issueId: this.#binding.issueId,
          phase: "workspace_finalizing",
          resultId: inserted.id,
        })
        .onConflictDoUpdate({
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
      await tx
        .update(heartbeatRuns)
        .set({
          nativePhase: "workspace_finalizing",
          nativePhaseUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, this.#binding.runId));
      return { disposition: "committed" as const, resultId: inserted.id };
    });
  }

  /** Rebuild the accepted result/finalization record from durable PRP events. */
  async reconcileTerminalEvent(event: PrpEvent): Promise<{
    readonly disposition: "committed" | "duplicate";
    readonly resultId: string;
  } | null> {
    if (event.eventType !== "run.terminal") return null;
    if (
      event.runId !== this.#binding.runId ||
      event.normalizedSessionId !== this.#binding.normalizedSessionId ||
      event.sourceInstanceId !== this.#binding.runnerSourceInstanceId
    ) {
      throw new Error("native_terminal_binding_mismatch");
    }
    const terminal = event.payload as PrpTerminalState;
    assertTerminal(terminal);
    const [proposed] = await this.#db
      .select({ payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.runId, this.#binding.runId),
          eq(
            heartbeatRunEvents.sourceInstanceId,
            this.#binding.runnerSourceInstanceId,
          ),
          eq(heartbeatRunEvents.eventType, "run.result.proposed"),
          lt(heartbeatRunEvents.sourceSeq, event.sourceSeq),
        ),
      )
      .orderBy(desc(heartbeatRunEvents.sourceSeq))
      .limit(1);
    const proposedEnvelope = (
      proposed?.payload as Record<string, unknown> | undefined
    )?.prpEvent as Record<string, unknown> | undefined;
    if (proposedEnvelope?.payload === undefined) {
      throw new Error("native_terminal_result_missing");
    }
    return this.completeRun({
      result: proposedEnvelope.payload as PrpStructuredRunResult,
      terminal,
      turnId: event.turnId,
      callerDedupeKey: `prp-terminal:${event.sourceEventId}`,
    });
  }

  async claimFinalization(input: {
    readonly leaseOwner: string;
    readonly leaseTtlMs?: number;
  }): Promise<{ readonly attempt: number; readonly resultId: string }> {
    const leaseTtlMs = input.leaseTtlMs ?? 30_000;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(input.leaseOwner) ||
      !Number.isInteger(leaseTtlMs) ||
      leaseTtlMs < 1_000 ||
      leaseTtlMs > 300_000
    ) {
      throw new Error("native_finalization_lease_invalid");
    }
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(nativeRunFinalizations)
        .where(
          and(
            eq(nativeRunFinalizations.runId, this.#binding.runId),
            eq(nativeRunFinalizations.companyId, this.#binding.companyId),
            eq(nativeRunFinalizations.issueId, this.#binding.issueId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row?.resultId || ["completed", "failed"].includes(row.phase)) {
        throw new Error("native_finalization_not_claimable");
      }
      if (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) {
        throw new Error("native_finalization_retry_not_due");
      }
      if (
        row.leaseOwner &&
        row.leaseOwner !== input.leaseOwner &&
        row.leaseExpiresAt &&
        row.leaseExpiresAt.getTime() > Date.now()
      ) {
        throw new Error("native_finalization_lease_conflict");
      }
      if (
        row.leaseOwner === input.leaseOwner &&
        row.leaseExpiresAt &&
        row.leaseExpiresAt.getTime() > Date.now()
      ) {
        await tx
          .update(nativeRunFinalizations)
          .set({
            leaseExpiresAt: new Date(Date.now() + leaseTtlMs),
            updatedAt: new Date(),
          })
          .where(eq(nativeRunFinalizations.runId, this.#binding.runId));
        return { attempt: row.attempt, resultId: row.resultId };
      }
      const attempt = row.attempt + 1;
      await tx
        .update(nativeRunFinalizations)
        .set({
          attempt,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: new Date(Date.now() + leaseTtlMs),
          updatedAt: new Date(),
        })
        .where(eq(nativeRunFinalizations.runId, this.#binding.runId));
      return { attempt, resultId: row.resultId };
    });
  }

  async markFinalizationRetry(input: {
    readonly leaseOwner: string;
    readonly failureCode: string;
    readonly retryAfterMs: number;
  }): Promise<void> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(input.failureCode) ||
      !Number.isInteger(input.retryAfterMs) ||
      input.retryAfterMs < 1_000 ||
      input.retryAfterMs > 24 * 60 * 60 * 1_000
    ) {
      throw new Error("native_finalization_retry_invalid");
    }
    const [updated] = await this.#db
      .update(nativeRunFinalizations)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode: input.failureCode,
        nextAttemptAt: new Date(Date.now() + input.retryAfterMs),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nativeRunFinalizations.runId, this.#binding.runId),
          eq(nativeRunFinalizations.companyId, this.#binding.companyId),
          eq(nativeRunFinalizations.issueId, this.#binding.issueId),
          eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ runId: nativeRunFinalizations.runId });
    if (!updated) throw new Error("native_finalization_lease_lost");
  }
}
