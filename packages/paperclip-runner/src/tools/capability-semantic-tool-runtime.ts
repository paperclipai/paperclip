import { randomUUID } from "node:crypto";

import type {
  CapabilityCommandEnvelope,
  CapabilityJsonValue,
  CapabilityMockControlPlanePort,
  CapabilitySemanticToolRuntimeSnapshot,
  CapabilitySemanticCommand,
} from "../mock-core/capability-control-plane-types.js";
import { capabilitySemanticTool } from "./capability-semantic-tool-catalog.js";
import { CapabilityToolAuthorizationEngine } from "./capability-tool-authorization.js";
import type {
  CapabilityAuthorizationRecord,
  CapabilityJsonSchema,
  CapabilityModelToolDelivery,
  CapabilityModelToolInvocationResult,
  CapabilityModelToolSuccess,
  CapabilityPolicyDenial,
  CapabilityScenarioToolPolicy,
  CapabilitySemanticToolDescriptor,
  CapabilityToolAuthorizationContext,
  CapabilityToolInvocation,
  CapabilityToolInvocationResult,
  CapabilityToolSuccess,
  CapabilityVisibleToolSet,
} from "./capability-semantic-tool-types.js";

export interface CapabilitySemanticToolRuntimeOptions {
  adapter: CapabilityMockControlPlanePort;
  runId: string;
  scenarioGrants?: string[];
  policy?: CapabilityScenarioToolPolicy;
  resolveSecretValue?: (name: string) => Promise<string | null> | string | null;
  /**
   * Optional trusted backend receipt lookup for an expired extension. The
   * package-local mock runtime falls back to the exact prepared receipt stored
   * before execution. Legacy records without a prepared receipt are recoverable
   * only for fixture computations whose output is independent of mutable
   * adapter state. State-derived exports require an exact prepared receipt or
   * a trusted backend lookup so a retry cannot substitute a newer projection
   * for the value observed by the original execution.
   */
  resolveExpiredExtensionReceipt?: (input: {
    operationId: string;
    input: Record<string, CapabilityJsonValue>;
    idempotencyKey: string;
  }) => Promise<Pick<CapabilityExpiredExtensionReceipt, "value" | "entityRefs"> | null> |
    Pick<CapabilityExpiredExtensionReceipt, "value" | "entityRefs"> | null;
  now?: () => number;
}

export interface CapabilityExpiredExtensionReceipt {
  operationId: string;
  input: Record<string, CapabilityJsonValue>;
  idempotencyKey: string;
  value: CapabilityJsonValue;
  entityRefs?: string[];
}

interface ExtensionExecution {
  value: CapabilityJsonValue;
  commandResult: CapabilityToolSuccess["commandResult"];
  entityRefs: string[];
}

interface ExtensionIdempotencyRecord {
  input: string;
  execution: Promise<{ resultId: string; value: ExtensionExecution }> | null;
  ownerId: string | null;
  leaseExpiresAtMs: number;
  leaseHeartbeat: ReturnType<typeof setInterval> | null;
  cleanupRetry: ReturnType<typeof setTimeout> | null;
  completed?: { resultId: string; value: ExtensionExecution };
  recoveryFailure?: "idempotency_receipt_unavailable";
}

interface CapabilitySemanticRuntimeState {
  extensionIdempotency: Map<string, ExtensionIdempotencyRecord>;
  operationResults: Map<string, CapabilityJsonValue>;
  resultSequence: number;
}

const RUNTIME_STATE_BY_ADAPTER = new WeakMap<
  CapabilityMockControlPlanePort,
  Map<string, CapabilitySemanticRuntimeState>
>();
const EXTENSION_EXECUTION_LEASE_MS = 30_000;
const EXTENSION_EXECUTION_HEARTBEAT_MS = Math.floor(
  EXTENSION_EXECUTION_LEASE_MS / 3,
);
const RUNTIME_PERSIST_CAS_ATTEMPTS = 8;
const RUNTIME_COMPLETION_CAS_ATTEMPTS = 64;
const REPLAY_SAFE_LEGACY_MOCK_EXTENSIONS = new Set([
  "discovery.projects",
  "discovery.goals",
  "cases.list",
  "routines.list",
  "company_skills.list",
  "secrets.metadata",
  "company_skills.sync",
  "routines.manage",
  "cases.upsert",
  "company.admin",
  "test.generic_api",
]);

export class CapabilitySemanticToolRuntime {
  readonly #adapter: CapabilityMockControlPlanePort;
  readonly #runId: string;
  readonly #scenarioGrants: string[];
  readonly #policy: CapabilityScenarioToolPolicy | undefined;
  readonly #resolveSecretValue: CapabilitySemanticToolRuntimeOptions["resolveSecretValue"];
  readonly #resolveExpiredExtensionReceipt: CapabilitySemanticToolRuntimeOptions["resolveExpiredExtensionReceipt"];
  readonly #now: () => number;
  readonly #authorization = new CapabilityToolAuthorizationEngine();
  readonly #state: CapabilitySemanticRuntimeState;

  constructor(options: CapabilitySemanticToolRuntimeOptions) {
    this.#adapter = options.adapter;
    this.#runId = options.runId;
    this.#scenarioGrants = [...new Set(options.scenarioGrants ?? [])].sort();
    this.#policy = options.policy === undefined ? undefined : structuredClone(options.policy);
    this.#resolveSecretValue = options.resolveSecretValue;
    this.#resolveExpiredExtensionReceipt = options.resolveExpiredExtensionReceipt;
    this.#now = options.now ?? Date.now;
    let adapterState = RUNTIME_STATE_BY_ADAPTER.get(options.adapter);
    if (adapterState === undefined) {
      adapterState = new Map();
      RUNTIME_STATE_BY_ADAPTER.set(options.adapter, adapterState);
    }
    const existingState = adapterState.get(options.runId);
    if (existingState !== undefined) this.#state = existingState;
    else {
      this.#state = this.#restoreState(
        options.adapter.loadSemanticToolRuntime(options.runId),
      );
      adapterState.set(options.runId, this.#state);
    }
  }

  visibleTools(): CapabilityVisibleToolSet {
    return this.#authorization.computeVisibleTools(this.#context());
  }

  authorizationRecords(): readonly CapabilityAuthorizationRecord[] {
    return this.#authorization.records();
  }

  /**
   * Publishes the exact observed result of an expired extension that entered
   * execution. This is a trusted recovery boundary: normal tool invocations
   * cannot guess, replay, or replace an ambiguous effect after its executor
   * exits.
   */
  reconcileExpiredExtensionReceipt(
    receipt: CapabilityExpiredExtensionReceipt,
  ): { resultId: string } {
    const descriptor = capabilitySemanticTool(receipt.operationId);
    if (
      descriptor?.mockCommandMapping.kind !== "mock_extension" ||
      descriptor.idempotency !== "required"
    ) {
      throw new Error("extension receipt reconciliation is not available");
    }
    const idempotencyKey = receipt.idempotencyKey.trim();
    if (idempotencyKey.length === 0) {
      throw new Error("extension receipt idempotency key is required");
    }
    if (receipt.entityRefs?.some((ref) => typeof ref !== "string")) {
      throw new Error("extension receipt entity references are invalid");
    }
    const key = `${this.#runId}:${receipt.operationId}:${idempotencyKey}`;
    const input = canonicalJson(receipt.input);
    const value = structuredClone(receipt.value);
    const entityRefs = [...new Set(receipt.entityRefs ?? [])].sort();

    for (let attempt = 0; attempt < RUNTIME_COMPLETION_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const extension = durable?.extensions.find(
        (candidate) => candidate.key === key,
      );
      if (durable === null || extension === undefined || extension.input !== input) {
        throw new Error("expired extension receipt does not match durable execution");
      }
      if (
        extension.status !== "pending" &&
        extension.status !== "indeterminate"
      ) {
        const durableResult = durable.operationResults[extension.resultId];
        if (durableResult === undefined) {
          throw new Error("completed extension receipt omitted its operation result");
        }
        // The original authorized executor may publish while trusted recovery
        // is resolving the expired lease. Its durable completion is already
        // authoritative for this exact key and canonical input; adopt it
        // instead of letting a stale recovery observation replace or reject
        // successfully completed work.
        this.#state.operationResults.set(
          extension.resultId,
          structuredClone(durableResult),
        );
        this.#state.resultSequence = Math.max(
          this.#state.resultSequence,
          durable.resultSequence,
        );
        this.#adoptReconciledExtension(
          key,
          input,
          extension.resultId,
          structuredClone(extension.execution),
        );
        return { resultId: extension.resultId };
      }
      if (
        extension.status === "pending" &&
        (extension.phase !== "executing" ||
          (extension.leaseExpiresAtMs ?? 0) > this.#now())
      ) {
        throw new Error("extension execution lease is still live or unproved");
      }
      const replacement = structuredClone(durable);
      let resultSequence = Math.max(
        replacement.resultSequence,
        this.#state.resultSequence,
      );
      let resultId: string;
      do {
        resultId = `tool-result-${++resultSequence}`;
      } while (Object.prototype.hasOwnProperty.call(
        replacement.operationResults,
        resultId,
      ));
      const execution: ExtensionExecution = {
        value,
        commandResult: null,
        entityRefs,
      };
      replacement.resultSequence = resultSequence;
      replacement.operationResults[resultId] = structuredClone(value);
      replacement.extensions = replacement.extensions.map((candidate) =>
        candidate.key === key
          ? {
              key,
              input,
              status: "completed" as const,
              resultId,
              execution: structuredClone(execution),
            }
          : candidate,
      );
      if (!this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) continue;
      this.#state.resultSequence = resultSequence;
      this.#adoptReconciledExtension(key, input, resultId, execution);
      return { resultId };
    }
    throw new Error("durable extension changed during receipt reconciliation");
  }

  /** Returns only the result shape allowed to cross observable boundaries. */
  async invoke(invocation: CapabilityToolInvocation): Promise<CapabilityToolInvocationResult> {
    return (await this.#invoke(invocation, false)).observableResult;
  }

  /**
   * Invokes a tool for provider delivery. The raw result remains in a capsule
   * that serializes and clones as the redacted observable result.
   */
  async invokeForModel(invocation: CapabilityToolInvocation): Promise<CapabilityModelToolDelivery> {
    const result = await this.#invoke(invocation, true);
    const modelResult = result.modelResult !== undefined
      ? result.modelResult
      : !result.observableResult.ok
        ? result.observableResult
        : undefined;
    if (modelResult === undefined) throw new Error("model delivery result was not produced");
    return new CapabilityModelToolDeliveryImpl(
      result.observableResult,
      modelResult,
    );
  }

  async #invoke(
    invocation: CapabilityToolInvocation,
    includeModelResult: boolean,
  ): Promise<{
    observableResult: CapabilityToolInvocationResult;
    modelResult?: CapabilityModelToolInvocationResult;
  }> {
    const context = this.#context();
    const authorization = this.#authorization.authorizeInvocation(
      invocation.operationId,
      invocation.input,
      context,
    );
    if (authorization.outcome !== "allowed") {
      return {
        observableResult: this.#denial(
          invocation.operationId,
          authorization,
          authorization.outcome === "absent" ? "operation_absent" : "policy_denied",
        ),
      };
    }

    const descriptor = capabilitySemanticTool(invocation.operationId)!;
    const validationIssues = validateJsonSchema(descriptor.inputSchema, invocation.input);
    if (validationIssues.length > 0) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "input_schema_invalid",
      );
      return { observableResult: this.#denial(invocation.operationId, denied, "input_invalid") };
    }
    if (descriptor.idempotency === "required" && !invocation.idempotencyKey?.trim()) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "idempotency_key_required",
      );
      return { observableResult: this.#denial(invocation.operationId, denied, "input_invalid") };
    }
    if (invocation.operationId === "decide_approval" && this.#isSelfApproval(invocation.input)) {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "self_approval_conflict",
      );
      return { observableResult: this.#denial(invocation.operationId, denied, "policy_denied") };
    }

    const beforeRevision = this.#adapter.snapshot().revision;
    try {
      const extensionIdempotencyKey = descriptor.mockCommandMapping.kind === "mock_extension" &&
        descriptor.idempotency === "required"
        ? `${this.#runId}:${invocation.operationId}:${invocation.idempotencyKey!.trim()}`
        : null;
      const canonicalInput = extensionIdempotencyKey === null
        ? null
        : canonicalJson(invocation.input);
      const cachedExtension = extensionIdempotencyKey === null
        ? undefined
        : this.#state.extensionIdempotency.get(extensionIdempotencyKey);
      if (cachedExtension !== undefined && cachedExtension.input !== canonicalInput) {
        const denied = this.#authorization.denyInvocation(
          invocation.operationId,
          context,
          "idempotency_key_conflict",
        );
        return { observableResult: this.#denial(invocation.operationId, denied, "input_invalid") };
      }
      let execution: ExtensionExecution;
      let resultId: string | null;
      let extensionRecord: ExtensionIdempotencyRecord | null = null;
      if (extensionIdempotencyKey !== null) {
        let idempotencyRecord = cachedExtension;
        if (idempotencyRecord === undefined) {
          idempotencyRecord = {
            input: canonicalInput!,
            execution: null,
            ownerId: null,
            leaseExpiresAtMs: 0,
            leaseHeartbeat: null,
            cleanupRetry: null,
          };
          this.#state.extensionIdempotency.set(
            extensionIdempotencyKey,
            idempotencyRecord,
          );
          let executionStarted = false;
          try {
            executionStarted = this.#startExtensionExecution(
              extensionIdempotencyKey,
              idempotencyRecord,
              descriptor,
              invocation,
            );
          } catch (error) {
            // Acquisition has not handed an execution promise to this record.
            // Do not let a transient store failure strand the local key; any
            // durable lease that committed before the failure still gates the
            // next attempt through the normal recovery path.
            this.#state.extensionIdempotency.delete(extensionIdempotencyKey);
            throw error;
          }
          if (!executionStarted) {
            this.#state.extensionIdempotency.delete(extensionIdempotencyKey);
            const denied = this.#authorization.denyInvocation(
              invocation.operationId,
              context,
              "idempotency_recovery_in_flight",
            );
            return {
              observableResult: this.#denial(
                invocation.operationId,
                denied,
                "operation_unsupported",
              ),
            };
          }
        }
        if (idempotencyRecord.execution === null) {
          let durableState = this.#adapter.loadSemanticToolRuntime(this.#runId);
          let durableExtension = durableState?.extensions.find(
            (extension) => extension.key === extensionIdempotencyKey,
          );
          if (durableState === null || durableExtension === undefined) {
            const denied = this.#authorization.denyInvocation(
              invocation.operationId,
              context,
              "idempotency_recovery_in_flight",
            );
            return {
              observableResult: this.#denial(
                invocation.operationId,
                denied,
                "operation_unsupported",
              ),
            };
          }
          if (durableExtension.status === "indeterminate") {
            const recovered = await this.#resolveExpiredExtension(invocation);
            if (!recovered) {
              const denied = this.#authorization.denyInvocation(
                invocation.operationId,
                context,
                durableExtension.reason,
              );
              return {
                observableResult: this.#denial(
                  invocation.operationId,
                  denied,
                  "operation_unsupported",
                ),
              };
            }
            durableState = this.#adapter.loadSemanticToolRuntime(this.#runId);
            durableExtension = durableState?.extensions.find(
              (extension) => extension.key === extensionIdempotencyKey,
            );
            if (durableState === null || durableExtension?.status !== "completed") {
              throw new Error("indeterminate extension recovery did not publish a durable receipt");
            }
          }
          if (durableExtension.status === "pending") {
            if ((durableExtension.leaseExpiresAtMs ?? 0) > this.#now()) {
              const denied = this.#authorization.denyInvocation(
                invocation.operationId,
                context,
                "idempotency_recovery_in_flight",
              );
              return {
                observableResult: this.#denial(
                  invocation.operationId,
                  denied,
                  "operation_unsupported",
                ),
              };
            }
            if (
              durableExtension.phase === "executing"
            ) {
              const recovered = await this.#resolveExpiredExtension(
                invocation,
              );
              if (!recovered) {
                this.#markExpiredExtensionIndeterminate(
                  extensionIdempotencyKey,
                  idempotencyRecord,
                );
              }
              durableState = this.#adapter.loadSemanticToolRuntime(this.#runId);
              durableExtension = durableState?.extensions.find(
                (extension) => extension.key === extensionIdempotencyKey,
              );
              if (durableExtension?.status === "indeterminate") {
                const denied = this.#authorization.denyInvocation(
                  invocation.operationId,
                  context,
                  durableExtension.reason,
                );
                return {
                  observableResult: this.#denial(
                    invocation.operationId,
                    denied,
                    "operation_unsupported",
                  ),
                };
              }
              if (durableState === null || durableExtension?.status !== "completed") {
                const denied = this.#authorization.denyInvocation(
                  invocation.operationId,
                  context,
                  "idempotency_recovery_in_flight",
                );
                return {
                  observableResult: this.#denial(
                    invocation.operationId,
                    denied,
                    "operation_unsupported",
                  ),
                };
              }
            }
          }
          if (durableExtension.status === "pending") {
            if (!this.#startExtensionExecution(
              extensionIdempotencyKey,
              idempotencyRecord,
              descriptor,
              invocation,
            )) {
              const denied = this.#authorization.denyInvocation(
                invocation.operationId,
                context,
                "idempotency_recovery_in_flight",
              );
              return {
                observableResult: this.#denial(
                  invocation.operationId,
                  denied,
                  "operation_unsupported",
                ),
              };
            }
          } else {
            if (durableExtension.input !== idempotencyRecord.input) {
              throw new Error("durable extension input changed during recovery");
            }
            const completed = {
              resultId: durableExtension.resultId,
              value: structuredClone(durableExtension.execution),
            };
            const durableResult = durableState.operationResults[completed.resultId];
            if (durableResult === undefined) {
              throw new Error("durable extension receipt omitted its operation result");
            }
            idempotencyRecord.completed = structuredClone(completed);
            idempotencyRecord.execution = Promise.resolve(structuredClone(completed));
            idempotencyRecord.ownerId = null;
            idempotencyRecord.leaseExpiresAtMs = 0;
            this.#state.operationResults.set(
              completed.resultId,
              structuredClone(durableResult),
            );
            this.#state.resultSequence = Math.max(
              this.#state.resultSequence,
              durableState.resultSequence,
            );
          }
        }
        if (idempotencyRecord.execution === null) {
          throw new Error("durable extension execution was not acquired");
        }
        const completed = await idempotencyRecord.execution;
        execution = structuredClone(completed.value);
        resultId = completed.resultId;
        extensionRecord = idempotencyRecord;
      } else {
        execution = await this.#execute(descriptor, invocation);
        resultId = execution.commandResult?.commandId ?? null;
      }
      let observableValue = redactForBoundary(descriptor, execution.value, "output");
      let observableCommandResult = execution.commandResult === null
        ? null
        : redactForBoundary(descriptor, toJsonValue(execution.commandResult), "output") as CapabilityToolSuccess["commandResult"];
      if (
        extensionIdempotencyKey !== null &&
        extensionRecord !== null &&
        extensionRecord.completed === undefined
      ) {
        if (resultId === null) {
          throw new Error("durable extension execution omitted its result id");
        }
        const completed = {
          resultId,
          value: structuredClone(execution),
        };
        const published = await this.#completeExtensionExecution(
          extensionIdempotencyKey,
          extensionRecord,
          completed,
          observableValue,
        );
        if (published === null) {
          // The extension already ran. Retain and renew its durable ownership
          // so another runtime cannot execute it again while this runtime can
          // still publish the exact completed receipt on an identical retry.
          try {
            const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
            const extension = durable?.extensions.find(
              (candidate) => candidate.key === extensionIdempotencyKey,
            );
            if (
              durable === null ||
              extension?.status !== "pending" ||
              extension.ownerId !== extensionRecord.ownerId
            ) {
              this.#stopExtensionExecutionLease(extensionRecord);
            }
          } catch {
            // A read failure cannot prove ownership was lost. Keep renewing it.
          }
          throw new Error("durable extension execution lease was superseded");
        }
        // A trusted recovery may publish the durable receipt while this
        // executor is still completing after heartbeat-store failures. Adopt
        // that receipt instead of turning already-completed work into a
        // denial; the durable key and canonical input were verified below.
        resultId = published.resultId;
        execution = structuredClone(published.value);
        observableValue = structuredClone(published.observableValue);
        observableCommandResult = execution.commandResult === null
          ? null
          : redactForBoundary(
              descriptor,
              toJsonValue(execution.commandResult),
              "output",
            ) as CapabilityToolSuccess["commandResult"];
        completed.resultId = published.resultId;
        completed.value = structuredClone(published.value);
        this.#stopExtensionExecutionLease(extensionRecord);
        extensionRecord.completed = completed;
        extensionRecord.execution = Promise.resolve(
          structuredClone(extensionRecord.completed),
        );
        extensionRecord.ownerId = null;
        extensionRecord.leaseExpiresAtMs = 0;
      }
      const finalAuthorization = this.#authorization.attachStateChange(
        authorization.sequence,
        beforeRevision,
        this.#adapter.snapshot().revision,
        execution.entityRefs,
      );
      let sequencedResultPersisted = false;
      if (extensionIdempotencyKey === null && resultId === null) {
        resultId = this.#persistSequencedOperationResult(observableValue);
        sequencedResultPersisted = true;
      }
      if (resultId === null) throw new Error("semantic tool result id was not allocated");
      this.#state.operationResults.set(resultId, structuredClone(observableValue));
      if (extensionIdempotencyKey === null && !sequencedResultPersisted) {
        this.#persistState();
      }
      const success: CapabilityToolSuccess = {
        schema: "paperclip.capability.tool-result.v1",
        ok: true,
        operationId: invocation.operationId,
        operationResultId: resultId,
        value: observableValue,
        commandResult: observableCommandResult,
        authorization: finalAuthorization,
      };
      const observableResult = deepFreeze(success);
      if (!includeModelResult) return { observableResult };
      const modelResult: CapabilityModelToolSuccess = deepFreeze({
        schema: "paperclip.capability.model-tool-result.v1",
        ok: true,
        operationId: invocation.operationId,
        operationResultId: resultId,
        value: structuredClone(execution.value),
        commandResult: execution.commandResult === null ? null : structuredClone(execution.commandResult),
        authorization: finalAuthorization,
      });
      return { observableResult, modelResult };
    } catch {
      const denied = this.#authorization.denyInvocation(
        invocation.operationId,
        context,
        "mock_operation_rejected",
      );
      return { observableResult: this.#denial(invocation.operationId, denied, "operation_unsupported") };
    }
  }

  #nextResultId(): string {
    const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
    this.#state.resultSequence = Math.max(
      this.#state.resultSequence,
      durable?.resultSequence ?? 0,
    );
    return `tool-result-${++this.#state.resultSequence}`;
  }

  #adoptReconciledExtension(
    key: string,
    input: string,
    resultId: string,
    value: ExtensionExecution,
  ): void {
    const completed = { resultId, value: structuredClone(value) };
    const existing = this.#state.extensionIdempotency.get(key);
    if (existing) this.#stopExtensionExecutionLease(existing);
    this.#state.extensionIdempotency.set(key, {
      input,
      execution: Promise.resolve(structuredClone(completed)),
      ownerId: null,
      leaseExpiresAtMs: 0,
      leaseHeartbeat: null,
      cleanupRetry: null,
      completed,
    });
    this.#state.operationResults.set(resultId, structuredClone(value.value));
  }

  async #resolveExpiredExtension(
    invocation: CapabilityToolInvocation,
  ): Promise<boolean> {
    const idempotencyKey = invocation.idempotencyKey?.trim();
    if (!idempotencyKey) return false;
    const recoveryInput = {
      operationId: invocation.operationId,
      input: structuredClone(invocation.input) as Record<string, CapabilityJsonValue>,
      idempotencyKey,
    };
    const key = `${this.#runId}:${invocation.operationId}:${idempotencyKey}`;
    const extension = this.#adapter
      .loadSemanticToolRuntime(this.#runId)
      ?.extensions.find((candidate) => candidate.key === key);
    let observed: Pick<
      CapabilityExpiredExtensionReceipt,
      "value" | "entityRefs"
    > | null =
      extension?.status === "pending" &&
      extension.phase === "executing" &&
      extension.input === canonicalJson(invocation.input) &&
      extension.preparedExecution !== undefined
        ? {
            value: structuredClone(extension.preparedExecution.value),
            entityRefs: [...extension.preparedExecution.entityRefs],
          }
        : null;
    if (observed === null && this.#resolveExpiredExtensionReceipt !== undefined) {
      observed = await this.#resolveExpiredExtensionReceipt(recoveryInput);
    }
    if (observed === null) {
      const descriptor = capabilitySemanticTool(invocation.operationId);
      if (
        descriptor?.mockCommandMapping.kind === "mock_extension" &&
        descriptor.idempotency === "required" &&
        REPLAY_SAFE_LEGACY_MOCK_EXTENSIONS.has(
          descriptor.mockCommandMapping.extension,
        )
      ) {
        // Snapshots written before preparedExecution existed can still be
        // recovered without replaying an external mutation. Every idempotent
        // extension in this explicit allowlist is a pure fixture computation.
        // Secret reads and mutable state-derived exports are deliberately
        // excluded: neither can recover the exact value observed by the lost
        // executor without a prepared or authoritative receipt.
        const reconstructed = this.#prepareBuiltInExtensionExecution(
          descriptor,
          asObject(invocation.input),
        );
        observed = {
          value: structuredClone(reconstructed.value),
          entityRefs: [...reconstructed.entityRefs],
        };
      }
    }
    if (observed === null) return false;
    this.reconcileExpiredExtensionReceipt({
      ...recoveryInput,
      value: structuredClone(observed.value),
      ...(observed.entityRefs === undefined
        ? {}
        : { entityRefs: [...observed.entityRefs] }),
    });
    return true;
  }

  #markExpiredExtensionIndeterminate(
    key: string,
    record: ExtensionIdempotencyRecord,
  ): void {
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const extension = durable?.extensions.find((candidate) => candidate.key === key);
      if (
        durable === null ||
        extension === undefined ||
        extension.status !== "pending" ||
        extension.input !== record.input ||
        extension.phase !== "executing" ||
        (extension.leaseExpiresAtMs ?? 0) > this.#now()
      ) {
        return;
      }
      const replacement = structuredClone(durable);
      replacement.extensions = replacement.extensions.map((candidate) =>
        candidate.key === key
          ? {
              key,
              input: record.input,
              status: "indeterminate" as const,
              reason: "idempotency_receipt_unavailable" as const,
            }
          : candidate,
      );
      if (!this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) continue;
      this.#stopExtensionExecutionLease(record);
      record.ownerId = null;
      record.leaseExpiresAtMs = 0;
      record.recoveryFailure = "idempotency_receipt_unavailable";
      return;
    }
  }

  #startExtensionExecution(
    key: string,
    record: ExtensionIdempotencyRecord,
    descriptor: CapabilitySemanticToolDescriptor,
    invocation: CapabilityToolInvocation,
  ): boolean {
    const ownerId = randomUUID();
    let leaseExpiresAtMs = 0;
    let acquired = false;
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const existing = durable?.extensions.find((candidate) => candidate.key === key);
      if (
        existing !== undefined &&
        (existing.status !== "pending" ||
          existing.input !== record.input ||
          existing.phase === "executing" ||
          (existing.leaseExpiresAtMs ?? 0) > this.#now())
      ) {
        return false;
      }
      leaseExpiresAtMs = this.#now() + EXTENSION_EXECUTION_LEASE_MS;
      const replacement: CapabilitySemanticToolRuntimeSnapshot = durable === null
        ? {
            schema: "paperclip.capability.semantic-tool-runtime.v1",
            resultSequence: this.#state.resultSequence,
            operationResults: Object.fromEntries(this.#state.operationResults),
            extensions: [],
          }
        : structuredClone(durable);
      const pending = {
        key,
        input: record.input,
        status: "pending" as const,
        ownerId,
        leaseExpiresAtMs,
        phase: "reserved" as const,
      };
      const existingIndex = replacement.extensions.findIndex(
        (candidate) => candidate.key === key,
      );
      if (existingIndex === -1) replacement.extensions.push(pending);
      else replacement.extensions[existingIndex] = pending;
      if (this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) {
        this.#state.resultSequence = Math.max(
          this.#state.resultSequence,
          replacement.resultSequence,
        );
        acquired = true;
        break;
      }
    }
    if (!acquired) return false;
    if (record.cleanupRetry !== null) clearTimeout(record.cleanupRetry);
    record.cleanupRetry = null;
    record.ownerId = ownerId;
    record.leaseExpiresAtMs = leaseExpiresAtMs;
    // Deterministic package-local mock extensions can persist their exact
    // result before crossing the executing boundary. Async/custom effects do
    // not guess a receipt and retain the external reconciliation boundary.
    const preparedExecution = this.#prepareBuiltInExtensionExecution(
      descriptor,
      asObject(invocation.input),
    );
    let executionStarted = false;
    try {
      executionStarted = this.#markExtensionExecutionStarted(
        key,
        record,
        preparedExecution,
      );
    } catch {
      executionStarted = false;
    }
    if (!executionStarted) {
      this.#scheduleFailedExtensionCleanup(key, record);
      return false;
    }
    const execution = Promise.resolve(structuredClone(preparedExecution)).then((value) => ({
      resultId: value.commandResult?.commandId ?? this.#nextResultId(),
      value,
    }));
    record.execution = execution;
    record.leaseHeartbeat = setInterval(() => {
      try {
        this.#renewExtensionExecutionLease(key, record);
      } catch {
        // A transient durable-store failure does not prove that ownership was
        // lost. Keep the execution alive and retry at the next heartbeat; the
        // completion CAS still validates the exact owner before publishing.
      }
    }, EXTENSION_EXECUTION_HEARTBEAT_MS);
    record.leaseHeartbeat.unref();
    void execution.catch(() => {
      record.execution = null;
      this.#scheduleFailedExtensionCleanup(key, record);
    });
    return true;
  }

  #scheduleFailedExtensionCleanup(
    key: string,
    record: ExtensionIdempotencyRecord,
  ): void {
    if (record.cleanupRetry !== null) return;
    const failedOwnerId = record.ownerId;
    if (failedOwnerId === null) return;
    const cleanup = () => {
      record.cleanupRetry = null;
      if (this.#removeFailedExtensionLease(key, failedOwnerId)) {
        if (record.ownerId === failedOwnerId) {
          this.#stopExtensionExecutionLease(record);
          if (this.#state.extensionIdempotency.get(key) === record) {
            this.#state.extensionIdempotency.delete(key);
          }
        }
        return;
      }
      if (record.ownerId !== failedOwnerId) return;
      record.cleanupRetry = setTimeout(cleanup, 1_000);
      record.cleanupRetry.unref();
    };
    cleanup();
  }

  #removeFailedExtensionLease(
    key: string,
    failedOwnerId: string,
  ): boolean {
    try {
      for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
        const current = this.#adapter.loadSemanticToolRuntime(this.#runId);
        const currentExtension = current?.extensions.find(
          (candidate) => candidate.key === key,
        );
        if (
          current === null ||
          currentExtension?.status !== "pending" ||
          currentExtension.ownerId !== failedOwnerId
        ) {
          return true;
        }
        const withoutFailedLease = structuredClone(current);
        withoutFailedLease.extensions = withoutFailedLease.extensions.filter(
          (candidate) => candidate.key !== key,
        );
        if (this.#adapter.compareAndSwapSemanticToolRuntime(
          this.#runId,
          current,
          withoutFailedLease,
        )) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  #markExtensionExecutionStarted(
    key: string,
    record: ExtensionIdempotencyRecord,
    preparedExecution: ExtensionExecution | undefined,
  ): boolean {
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const extension = durable?.extensions.find((candidate) => candidate.key === key);
      if (
        durable === null ||
        extension?.status !== "pending" ||
        extension.ownerId !== record.ownerId ||
        extension.phase === "executing"
      ) {
        return false;
      }
      const replacement = structuredClone(durable);
      const leaseExpiresAtMs = this.#now() + EXTENSION_EXECUTION_LEASE_MS;
      replacement.extensions = replacement.extensions.map((candidate) =>
        candidate.key === key
          ? {
              ...candidate,
              phase: "executing" as const,
              leaseExpiresAtMs,
              ...(preparedExecution === undefined
                ? {}
                : { preparedExecution: structuredClone(preparedExecution) }),
            }
          : candidate,
      );
      if (!this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) continue;
      record.leaseExpiresAtMs = leaseExpiresAtMs;
      return true;
    }
    return false;
  }

  #renewExtensionExecutionLease(
    key: string,
    record: ExtensionIdempotencyRecord,
  ): boolean {
    if (record.ownerId === null) return false;
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const extension = durable?.extensions.find((candidate) => candidate.key === key);
      if (durable === null || extension?.status !== "pending" ||
        extension.ownerId !== record.ownerId) return false;
      const replacement = structuredClone(durable);
      const leaseExpiresAtMs = this.#now() + EXTENSION_EXECUTION_LEASE_MS;
      replacement.extensions = replacement.extensions.map((candidate) =>
        candidate.key === key
          ? { ...candidate, leaseExpiresAtMs }
          : candidate,
      );
      if (!this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) continue;
      record.leaseExpiresAtMs = leaseExpiresAtMs;
      return true;
    }
    return false;
  }

  async #completeExtensionExecution(
    key: string,
    record: ExtensionIdempotencyRecord,
    completed: { resultId: string; value: ExtensionExecution },
    observableValue: CapabilityJsonValue,
  ): Promise<{
    resultId: string;
    value: ExtensionExecution;
    observableValue: CapabilityJsonValue;
  } | null> {
    // Execution already happened. Retry only the durable completion merge so
    // a lease heartbeat or unrelated snapshot update cannot discard its
    // receipt or cause the operation to execute again.
    for (let attempt = 0; attempt < RUNTIME_COMPLETION_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const extension = durable?.extensions.find((candidate) => candidate.key === key);
      if (durable === null || extension === undefined) return null;
      if (extension.status === "completed") {
        const durableResult = durable.operationResults[extension.resultId];
        return extension.input === record.input && durableResult !== undefined
          ? {
              resultId: extension.resultId,
              value: structuredClone(extension.execution),
              observableValue: structuredClone(durableResult),
            }
          : null;
      }
      if (extension.status !== "pending" || record.ownerId === null ||
        extension.ownerId !== record.ownerId) {
        return null;
      }
      const replacement = structuredClone(durable);
      const existingResult = replacement.operationResults[completed.resultId];
      if (
        existingResult !== undefined &&
        canonicalJson(existingResult) !== canonicalJson(observableValue)
      ) {
        replacement.resultSequence = Math.max(
          replacement.resultSequence,
          this.#state.resultSequence,
        ) + 1;
        completed.resultId = `tool-result-${replacement.resultSequence}`;
        this.#state.resultSequence = replacement.resultSequence;
      }
      replacement.resultSequence = Math.max(
        replacement.resultSequence,
        this.#state.resultSequence,
      );
      replacement.operationResults[completed.resultId] = structuredClone(observableValue);
      replacement.extensions = replacement.extensions.map((candidate) =>
        candidate.key === key
          ? {
              key,
              input: record.input,
              status: "completed" as const,
              resultId: completed.resultId,
              execution: structuredClone(completed.value),
            }
          : candidate,
      );
      if (this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) {
        return {
          resultId: completed.resultId,
          value: structuredClone(completed.value),
          observableValue: structuredClone(observableValue),
        };
      }
      if ((attempt + 1) % RUNTIME_PERSIST_CAS_ATTEMPTS === 0) {
        // Yield so lease heartbeats and other runtimes can make progress. The
        // bounded outer loop prevents a broken store from pinning invocation
        // completion forever; the fulfilled local execution remains available
        // for an exact publication retry without re-executing the extension.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return null;
  }

  #stopExtensionExecutionLease(record: ExtensionIdempotencyRecord): void {
    if (record.leaseHeartbeat !== null) clearInterval(record.leaseHeartbeat);
    record.leaseHeartbeat = null;
    if (record.cleanupRetry !== null) clearTimeout(record.cleanupRetry);
    record.cleanupRetry = null;
  }

  #restoreState(
    snapshot: CapabilitySemanticToolRuntimeSnapshot | null,
  ): CapabilitySemanticRuntimeState {
    if (snapshot === null) {
      return {
        extensionIdempotency: new Map(),
        operationResults: new Map(),
        resultSequence: 0,
      };
    }
    const extensionIdempotency = new Map<string, ExtensionIdempotencyRecord>();
    for (const extension of snapshot.extensions) {
      if (extension.status === "pending") {
        extensionIdempotency.set(extension.key, {
          input: extension.input,
          execution: null,
          ownerId: extension.ownerId ?? null,
          leaseExpiresAtMs: extension.leaseExpiresAtMs ?? 0,
          leaseHeartbeat: null,
          cleanupRetry: null,
        });
        continue;
      }
      if (extension.status === "indeterminate") {
        extensionIdempotency.set(extension.key, {
          input: extension.input,
          execution: null,
          ownerId: null,
          leaseExpiresAtMs: 0,
          leaseHeartbeat: null,
          cleanupRetry: null,
          recoveryFailure: extension.reason,
        });
        continue;
      }
      const completed = {
        resultId: extension.resultId,
        value: structuredClone(extension.execution),
      };
      extensionIdempotency.set(extension.key, {
        input: extension.input,
        execution: Promise.resolve(structuredClone(completed)),
        ownerId: null,
        leaseExpiresAtMs: 0,
        leaseHeartbeat: null,
        cleanupRetry: null,
        completed,
      });
    }
    return {
      extensionIdempotency,
      operationResults: new Map(
        Object.entries(snapshot.operationResults).map(([key, value]) => [
          key,
          structuredClone(value),
        ]),
      ),
      resultSequence: snapshot.resultSequence,
    };
  }

  #localSnapshot(): CapabilitySemanticToolRuntimeSnapshot {
    return {
      schema: "paperclip.capability.semantic-tool-runtime.v1",
      resultSequence: this.#state.resultSequence,
      operationResults: Object.fromEntries(
        [...this.#state.operationResults].map(([key, value]) => [
          key,
          structuredClone(value),
        ]),
      ),
      extensions: [...this.#state.extensionIdempotency]
        .map(([key, record]) =>
          record.completed === undefined
            ? record.recoveryFailure === undefined
              ? {
                  key,
                  input: record.input,
                  status: "pending" as const,
                  ...(record.ownerId === null ? {} : { ownerId: record.ownerId }),
                  leaseExpiresAtMs: record.leaseExpiresAtMs,
                }
              : {
                  key,
                  input: record.input,
                  status: "indeterminate" as const,
                  reason: record.recoveryFailure,
                }
            : {
                key,
                input: record.input,
                status: "completed" as const,
                resultId: record.completed.resultId,
                execution: structuredClone(record.completed.value),
              },
        ),
    };
  }

  #persistSequencedOperationResult(value: CapabilityJsonValue): string {
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const replacement = durable === null
        ? this.#localSnapshot()
        : structuredClone(durable);
      const sequence = Math.max(
        replacement.resultSequence,
        this.#state.resultSequence,
      ) + 1;
      const resultId = `tool-result-${sequence}`;
      replacement.resultSequence = sequence;
      replacement.operationResults[resultId] = structuredClone(value);
      if (!this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) continue;
      this.#state.resultSequence = sequence;
      this.#state.operationResults.set(resultId, structuredClone(value));
      return resultId;
    }
    throw new Error("durable semantic tool runtime changed during result allocation");
  }

  #persistState(): void {
    const localSnapshot = this.#localSnapshot();
    for (let attempt = 0; attempt < RUNTIME_PERSIST_CAS_ATTEMPTS; attempt += 1) {
      const durable = this.#adapter.loadSemanticToolRuntime(this.#runId);
      const replacement = durable === null
        ? structuredClone(localSnapshot)
        : structuredClone(durable);
      replacement.resultSequence = Math.max(
        replacement.resultSequence,
        localSnapshot.resultSequence,
      );
      for (const [resultId, value] of Object.entries(localSnapshot.operationResults)) {
        const existing = replacement.operationResults[resultId];
        if (existing !== undefined && canonicalJson(existing) !== canonicalJson(value)) {
          throw new Error("durable semantic tool result id was reused");
        }
        replacement.operationResults[resultId] = structuredClone(value);
      }
      // Extension leases and completed receipts use their own CAS path. A
      // general invocation must preserve the latest durable copy instead of
      // replacing it with a stale restored adapter snapshot.
      if (this.#adapter.compareAndSwapSemanticToolRuntime(
        this.#runId,
        durable,
        replacement,
      )) {
        this.#state.resultSequence = replacement.resultSequence;
        return;
      }
    }
    throw new Error("durable semantic tool runtime changed during persistence");
  }

  async #execute(
    descriptor: CapabilitySemanticToolDescriptor,
    invocation: CapabilityToolInvocation,
  ): Promise<{ value: CapabilityJsonValue; commandResult: CapabilityToolSuccess["commandResult"]; entityRefs: string[] }> {
    const input = asObject(invocation.input);
    switch (descriptor.mockCommandMapping.kind) {
      case "context_read":
        return { value: toJsonValue(this.#adapter.context(this.#runId)), commandResult: null, entityRefs: [] };
      case "snapshot_read":
        return {
          value: this.#snapshotProjection(descriptor.mockCommandMapping.projection, input),
          commandResult: null,
          entityRefs: [],
        };
      case "operation_result": {
        const id = requireString(input.operationResultId);
        const result = this.#state.operationResults.get(id);
        if (result === undefined) throw new Error("operation result is not available");
        return { value: structuredClone(result), commandResult: null, entityRefs: [] };
      }
      case "semantic_command": {
        const command = commandForOperation(descriptor.operationId, input);
        const envelope: CapabilityCommandEnvelope = {
          runId: this.#runId,
          idempotencyKey: invocation.idempotencyKey!,
          command,
        };
        const commandResult = await this.#adapter.applyCommand(envelope);
        return {
          value: toJsonValue(commandResult),
          commandResult,
          entityRefs: commandResult.entityRefs,
        };
      }
      case "mock_extension":
        return this.#executeExtension(descriptor, input);
    }
  }

  async #executeExtension(
    descriptor: CapabilitySemanticToolDescriptor,
    input: Record<string, CapabilityJsonValue>,
  ): Promise<ExtensionExecution> {
    const extension = descriptor.mockCommandMapping.kind === "mock_extension"
      ? descriptor.mockCommandMapping.extension
      : "";
    if (extension === "secrets.value") {
      // Secret reads are explicitly non-idempotent and never enter the durable
      // extension lease path, which also keeps secret values out of receipts.
      const name = requireString(input.name);
      const value = await this.#resolveSecretValue?.(name);
      if (value === null || value === undefined) throw new Error("secret is not available");
      return { value: { name, value }, commandResult: null, entityRefs: [] };
    }
    return this.#prepareBuiltInExtensionExecution(descriptor, input);
  }

  #prepareBuiltInExtensionExecution(
    descriptor: CapabilitySemanticToolDescriptor,
    input: Record<string, CapabilityJsonValue>,
  ): ExtensionExecution {
    switch (descriptor.mockCommandMapping.kind === "mock_extension"
      ? descriptor.mockCommandMapping.extension
      : "") {
      case "discovery.projects":
      case "discovery.goals":
      case "cases.list":
      case "routines.list":
      case "company_skills.list":
      case "secrets.metadata":
        return { value: [], commandResult: null, entityRefs: [] };
      case "portability.export": {
        const snapshot = this.#adapter.snapshot();
        return {
          value: {
            schema: "paperclip.capability.mock-export.v1",
            company: { id: snapshot.company.id, name: snapshot.company.name },
            taskCount: snapshot.tasks.length,
            actorCount: snapshot.actors.length,
          },
          commandResult: null,
          entityRefs: [],
        };
      }
      case "company_skills.sync":
        return {
          value: { synced: true },
          commandResult: null,
          entityRefs: [],
        };
      case "routines.manage":
        return {
          value: { managed: true },
          commandResult: null,
          entityRefs: [],
        };
      case "cases.upsert":
        return {
          value: {
            key: requireString(input.key),
            body: requireString(input.body),
            upserted: true,
          },
          commandResult: null,
          entityRefs: [],
        };
      case "company.admin":
        return {
          value: {
            action: requireString(input.action),
            applied: true,
          },
          commandResult: null,
          entityRefs: [],
        };
      case "test.generic_api":
        return {
          value: {
            status: 200,
            body: null,
            warning: "TEST-ONLY mock request; no control plane or network was contacted.",
          },
          commandResult: null,
          entityRefs: [],
        };
      case "secrets.value":
        throw new Error("non-idempotent secret reads cannot enter durable extension execution");
      default:
        throw new Error("mock extension is not implemented");
    }
  }

  #snapshotProjection(
    projection: string,
    input: Record<string, CapabilityJsonValue>,
  ): CapabilityJsonValue {
    const snapshot = this.#adapter.snapshot();
    const context = this.#adapter.context(this.#runId);
    switch (projection) {
      case "active_task_history":
        return toJsonValue(snapshot.comments.filter((comment) => comment.taskId === context.activeTask.id));
      case "active_task_documents":
        return toJsonValue(snapshot.documents
          .filter((document) => document.taskId === context.activeTask.id)
          .map(({ id, key, title, format, latestRevisionId, revisions }) => ({
            id, key, title, format, latestRevisionId, revisionCount: revisions.length,
          })));
      case "active_task_document": {
        const key = requireString(input.key);
        const document = snapshot.documents.find(
          (candidate) => candidate.taskId === context.activeTask.id && candidate.key === key,
        );
        if (document === undefined) throw new Error("document is not available");
        return toJsonValue(document);
      }
      case "active_task_document_revisions": {
        const key = requireString(input.key);
        const document = snapshot.documents.find(
          (candidate) => candidate.taskId === context.activeTask.id && candidate.key === key,
        );
        if (document === undefined) throw new Error("document is not available");
        return toJsonValue(document.revisions);
      }
      case "company_tasks": {
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const status = typeof input.status === "string" ? input.status : null;
        return toJsonValue(snapshot.tasks.filter(
          (task) =>
            (query === "" || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query)) &&
            (status === null || task.status === status),
        ));
      }
      case "company_actors":
        return toJsonValue(snapshot.actors.map(({ id, companyId, name, role, status }) => ({ id, companyId, name, role, status })));
      case "company_approvals":
        return toJsonValue(snapshot.approvals);
      case "active_task_workspace":
        return toJsonValue(snapshot.workspaceServices.filter((service) => service.taskId === context.activeTask.id));
      default:
        throw new Error("snapshot projection is not implemented");
    }
  }

  #context(): CapabilityToolAuthorizationContext {
    const runContext = this.#adapter.context(this.#runId);
    return {
      runId: this.#runId,
      actor: {
        id: runContext.actor.id,
        role: runContext.actor.role,
        capabilityGrants: [...runContext.actor.capabilityGrants],
      },
      task: {
        id: runContext.activeTask.id,
        assigneeActorId: runContext.activeTask.assigneeActorId,
        workMode: runContext.activeTask.workMode,
      },
      scenarioGrants: [...this.#scenarioGrants],
      policy: this.#policy,
    };
  }

  #isSelfApproval(input: CapabilityJsonValue): boolean {
    const approvalId = asObject(input).approvalId;
    if (typeof approvalId !== "string") return false;
    const actorId = this.#adapter.context(this.#runId).actor.id;
    const approval = this.#adapter.snapshot().approvals.find((candidate) => candidate.id === approvalId);
    return approval?.requestedByActorId === actorId;
  }

  #denial(
    operationId: string,
    authorization: CapabilityAuthorizationRecord,
    code: CapabilityPolicyDenial["error"]["code"],
  ): CapabilityPolicyDenial {
    return deepFreeze({
      schema: "paperclip.capability.tool-result.v1",
      ok: false,
      error: {
        code,
        message: code === "operation_absent"
          ? "The requested semantic operation is not available."
          : "The requested semantic operation was not executed.",
        operationId,
        reason: authorization.reason,
      },
      authorization,
    });
  }
}

function commandForOperation(
  operationId: string,
  input: Record<string, CapabilityJsonValue>,
): CapabilitySemanticCommand {
  switch (operationId) {
    case "report_progress":
    case "answer_status_question":
      return { kind: "report_progress", body: requireString(input.body) };
    case "finish_task":
      return { kind: "finish_task", summary: requireString(input.summary) };
    case "block_task":
      return {
        kind: "block_task",
        reason: requireString(input.reason),
        blockedByTaskIds: optionalStringArray(input.blockedByTaskIds),
      };
    case "request_review":
      return { kind: "request_review", summary: requireString(input.summary) };
    case "write_document":
      return {
        kind: "write_document",
        key: requireString(input.key),
        title: requireString(input.title),
        body: requireString(input.body, true),
        baseRevisionId: input.baseRevisionId === null ? null : requireString(input.baseRevisionId),
        changeSummary: typeof input.changeSummary === "string" ? input.changeSummary : undefined,
      };
    case "request_human_input":
      return {
        kind: "request_human_input",
        interactionKind: requireString(input.interactionKind) as never,
        title: requireString(input.title),
        prompt: requireString(input.prompt),
        payload: input.payload,
        targetRevisionId: input.targetRevisionId === null || input.targetRevisionId === undefined
          ? input.targetRevisionId
          : requireString(input.targetRevisionId),
        continuationPolicy: requireString(input.continuationPolicy) as never,
      };
    case "register_deliverable":
      return {
        kind: "register_deliverable",
        filename: requireString(input.filename),
        contentType: requireString(input.contentType),
        byteSize: input.byteSize as number,
        sha256: requireString(input.sha256),
        contentRef: requireString(input.contentRef),
        title: requireString(input.title),
      };
    case "create_task":
      return {
        kind: "create_task",
        title: requireString(input.title),
        description: typeof input.description === "string" ? input.description : undefined,
        assigneeActorId: typeof input.assigneeActorId === "string" ? input.assigneeActorId : undefined,
        priority: typeof input.priority === "string" ? input.priority as never : undefined,
        blockedByTaskIds: optionalStringArray(input.blockedByTaskIds),
      };
    case "set_dependencies":
      return { kind: "set_dependencies", blockedByTaskIds: optionalStringArray(input.blockedByTaskIds) ?? [] };
    case "request_approval":
      return { kind: "request_approval", approvalType: requireString(input.approvalType), payload: input.payload ?? {} };
    case "decide_approval":
      return {
        kind: "decide_approval",
        approvalId: requireString(input.approvalId),
        decision: requireString(input.decision) as never,
        note: requireString(input.note),
      };
    case "comment_on_approval":
      return { kind: "comment_on_approval", approvalId: requireString(input.approvalId), body: requireString(input.body) };
    case "control_workspace_service":
      return {
        kind: "control_workspace_service",
        serviceId: requireString(input.serviceId),
        action: requireString(input.action) as never,
        url: typeof input.url === "string" ? input.url : undefined,
      };
    default:
      throw new Error("semantic command mapping is not implemented");
  }
}

export function validateJsonSchema(schema: CapabilityJsonSchema, value: CapabilityJsonValue, path = "$" ): string[] {
  if (schema.oneOf !== undefined) {
    return schema.oneOf.some((candidate) => validateJsonSchema(candidate, value, path).length === 0)
      ? []
      : [`${path} does not match any allowed shape`];
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) return [`${path} must be ${schema.type}`];
  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return [`${path} must be an allowed value`];
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    return [`${path} is too short`];
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return [`${path} is below the minimum`];
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    return value.flatMap((item, index) => validateJsonSchema(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, CapabilityJsonValue>;
    const issues = (schema.required ?? [])
      .filter((key) => !(key in object))
      .map((key) => `${path}.${key} is required`);
    for (const [key, child] of Object.entries(object)) {
      const childSchema = schema.properties?.[key];
      if (childSchema !== undefined) issues.push(...validateJsonSchema(childSchema, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} is not allowed`);
      else if (typeof schema.additionalProperties === "object") {
        issues.push(...validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
    return issues;
  }
  return [];
}

function matchesType(type: NonNullable<CapabilityJsonSchema["type"]>, value: CapabilityJsonValue): boolean {
  if (Array.isArray(type)) return type.some((candidate) => matchesType(candidate, value));
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    default: return typeof value === type;
  }
}

function redactForBoundary(
  descriptor: CapabilitySemanticToolDescriptor,
  value: CapabilityJsonValue,
  boundary: CapabilitySemanticToolDescriptor["redaction"][number]["appliesTo"][number],
): CapabilityJsonValue {
  let redacted = structuredClone(value);
  for (const rule of descriptor.redaction) {
    if (!rule.appliesTo.includes(boundary)) continue;
    redacted = replaceJsonPath(redacted, rule.path, rule.replacement);
  }
  return redacted;
}

function replaceJsonPath(
  value: CapabilityJsonValue,
  path: string,
  replacement: CapabilityJsonValue,
): CapabilityJsonValue {
  if (path === "$") return replacement;
  if (!path.startsWith("$.")) return value;
  const segments = path.slice(2).split(".");
  if (segments.some((segment) => segment.length === 0)) return value;

  const root = structuredClone(value);
  let cursor: CapabilityJsonValue = root;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return root;
    const next: CapabilityJsonValue | undefined = cursor[segment];
    if (next === undefined) return root;
    cursor = next;
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return root;
  const leaf = segments.at(-1)!;
  if (!(leaf in cursor)) return root;
  cursor[leaf] = replacement;
  return root;
}

function optionalStringArray(value: CapabilityJsonValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("expected string array");
  return value as string[];
}

function requireString(value: CapabilityJsonValue | undefined, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error("expected string");
  return value;
}

function asObject(value: CapabilityJsonValue): Record<string, CapabilityJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object input");
  return value;
}

function toJsonValue(value: unknown): CapabilityJsonValue {
  return structuredClone(value) as CapabilityJsonValue;
}

function canonicalJson(value: CapabilityJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

class CapabilityModelToolDeliveryImpl implements CapabilityModelToolDelivery {
  readonly observableResult: CapabilityToolInvocationResult;
  readonly #modelResult: CapabilityModelToolInvocationResult;

  constructor(
    observableResult: CapabilityToolInvocationResult,
    modelResult: CapabilityModelToolInvocationResult,
  ) {
    this.observableResult = observableResult;
    this.#modelResult = modelResult;
    Object.freeze(this);
  }

  readModelResult(): CapabilityModelToolInvocationResult {
    return deepFreeze(structuredClone(this.#modelResult));
  }

  toJSON(): CapabilityToolInvocationResult {
    return this.observableResult;
  }
}
