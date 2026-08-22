import type {
  AppendedEventReceipt,
  CompleteControlPlaneRunInput,
  OpenControlPlaneRunInput,
  ReplayControlPlaneEventsInput,
  ReplayedControlPlaneEvents,
} from "../contracts/control-plane-port.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";
import {
  validatePrpEvent,
  validatePrpStructuredRunResult,
  type PrpEvent,
} from "../protocol/phase1-contract.js";
import {
  PHASE7_COMMAND_REQUIRED_CLAIMS,
  createPhase7FixtureState,
  type Phase7AuditRecord,
  type Phase7CommandEnvelope,
  type Phase7CommandOutcome,
  type Phase7CommandResult,
  type Phase7DecisionRecord,
  type Phase7FaultRule,
  type Phase7FixtureActor,
  type Phase7FixtureDocument,
  type Phase7FixtureRun,
  type Phase7FixtureSeed,
  type Phase7FixtureState,
  type Phase7FixtureTask,
  type Phase7JsonValue,
  type Phase7MockControlPlanePort,
  type Phase7OpenFixtureRunInput,
  type Phase7RunContext,
  type Phase7SemanticCommand,
  type Phase7WakeContext,
} from "./phase7-control-plane-types.js";

const DEFAULT_WAKE: Phase7WakeContext = { reason: "manual", payload: {} };

export class Phase7MockControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "Phase7MockControlPlaneError";
  }
}

/**
 * Deterministic, serializable control-plane authority for Phase 7 scenarios.
 *
 * The adapter deliberately models Paperclip semantics instead of Paperclip
 * transport. It imports no server route, service, database, or provider binding.
 */
export class Phase7MockControlPlaneAdapter implements Phase7MockControlPlanePort {
  #state: Phase7FixtureState;

  constructor(seed: Phase7FixtureSeed | Phase7FixtureState = {}) {
    this.#state = isFixtureState(seed)
      ? clone(seed)
      : createPhase7FixtureState(seed);
    this.#validateState();
  }

  static restore(serialized: string): Phase7MockControlPlaneAdapter {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error) {
      throw new Phase7MockControlPlaneError(
        "fixture_state_invalid",
        `fixture state is not valid JSON: ${String(error)}`,
      );
    }
    if (!isFixtureState(parsed)) {
      throw new Phase7MockControlPlaneError(
        "fixture_state_invalid",
        "fixture state schema must be paperclip.phase7.mock-state.v1",
      );
    }
    return new Phase7MockControlPlaneAdapter(parsed);
  }

  async start(): Promise<void> {
    if (this.#state.lifecycle === "running") {
      throw new Phase7MockControlPlaneError(
        "mock_already_running",
        "Phase 7 mock control plane is already running",
      );
    }
    this.#state.lifecycle = "running";
  }

  async stop(): Promise<void> {
    this.#state.lifecycle = "stopped";
    this.#state.activeRunId = null;
  }

  async openRun(input: OpenControlPlaneRunInput): Promise<void> {
    await this.openFixtureRun(input);
  }

  async openFixtureRun(input: Phase7OpenFixtureRunInput): Promise<Phase7RunContext> {
    this.#assertRunning();
    const existing = this.#state.runs.find((run) => run.id === input.identity.runId);
    if (existing !== undefined) {
      this.#assertRunBinding(existing, input);
      this.#state.activeRunId = existing.id;
      this.#recordDecisionOnly(existing.id, "open_run", "duplicate", "run_binding_resumed", [
        `run:${existing.id}`,
      ]);
      return this.context(existing.id);
    }

    const actor = this.#actor(input.identity.agentId);
    const task = this.#task(input.identity.issueId);
    this.#assertCompany(input.identity.companyId, actor.companyId, task.companyId);
    if (actor.status !== "active") {
      this.#deny(input.identity.runId, "open_run", "actor_not_active", [`actor:${actor.id}`]);
      throw new Phase7MockControlPlaneError("actor_not_active", "fixture actor is not active");
    }
    this.#assertBudgetAvailable(actor, input.identity.runId);
    if (task.assigneeActorId !== null && task.assigneeActorId !== actor.id) {
      this.#deny(input.identity.runId, "open_run", "checkout_assignee_conflict", [
        `task:${task.id}`,
      ]);
      throw new Phase7MockControlPlaneError(
        "checkout_conflict",
        "fixture task is assigned to another actor",
      );
    }
    if (task.checkoutRunId !== null && task.checkoutRunId !== input.identity.runId) {
      this.#deny(input.identity.runId, "open_run", "checkout_lock_conflict", [`task:${task.id}`]);
      throw new Phase7MockControlPlaneError(
        "checkout_conflict",
        `fixture task is checked out by ${task.checkoutRunId}`,
      );
    }
    if (["done", "cancelled"].includes(task.status) && input.resume !== true) {
      this.#deny(input.identity.runId, "open_run", "terminal_task_requires_resume", [
        `task:${task.id}`,
      ]);
      throw new Phase7MockControlPlaneError(
        "terminal_task_requires_resume",
        "terminal fixture tasks require an explicit resume",
      );
    }
    if (
      !["backlog", "todo", "blocked", "in_review"].includes(task.status) &&
      !(input.resume === true && ["done", "cancelled"].includes(task.status))
    ) {
      this.#deny(input.identity.runId, "open_run", "checkout_status_illegal", [
        `task:${task.id}`,
      ]);
      throw new Phase7MockControlPlaneError(
        "task_transition_illegal",
        `fixture task cannot be checked out from ${task.status}`,
      );
    }

    const fault = this.#consumeFault("open_run");
    this.#throwBeforeFault(fault, input.identity.runId, "open_run");
    const openedAt = this.#now();
    task.assigneeActorId = actor.id;
    task.checkoutRunId = input.identity.runId;
    task.executionRunId = input.identity.runId;
    task.status = "in_progress";
    task.startedAt ??= openedAt;
    const run: Phase7FixtureRun = {
      id: input.identity.runId,
      companyId: input.identity.companyId,
      actorId: actor.id,
      taskId: task.id,
      sessionId: input.identity.sessionId,
      backendKind: input.backendKind,
      sourceInstanceId: input.sourceInstanceId ?? "phase7-mock",
      status: "running",
      attempt: input.resume === true ? 2 : 1,
      openedAt,
      finishedAt: null,
      wake: sanitizeWake(input.wake ?? DEFAULT_WAKE),
      capabilities: sortedUnique(input.capabilities ?? actor.capabilityGrants),
      events: [],
      result: null,
      sessionCheckpoint: null,
    };
    this.#state.runs.push(run);
    this.#state.activeRunId = run.id;
    this.#recordMutation(run.id, actor.id, "run.opened", "run", run.id, {
      taskId: task.id,
      wakeReason: run.wake.reason,
      capabilities: run.capabilities,
    }, "open_run", "allowed", "atomic_checkout_acquired", [
      `run:${run.id}`,
      `task:${task.id}`,
    ]);
    this.#throwAfterFault(fault, run.id, "open_run");
    return this.context(run.id);
  }

  context(runId: string): Phase7RunContext {
    const run = this.#run(runId);
    const actor = this.#actor(run.actorId);
    const task = this.#task(run.taskId);
    const ancestors: Phase7FixtureTask[] = [];
    const visited = new Set<string>();
    let parentId = task.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        throw new Phase7MockControlPlaneError(
          "fixture_state_invalid",
          "fixture task ancestry contains a cycle",
        );
      }
      visited.add(parentId);
      const parent = this.#task(parentId);
      ancestors.push(clone(parent));
      parentId = parent.parentId;
    }
    const budgets = this.#effectiveBudgets(actor);
    const limitCents = Math.min(...budgets.map((budget) => budget.limitCents));
    const remainingCents = Math.min(
      ...budgets.map((budget) => Math.max(0, budget.limitCents - budget.spentCents)),
    );
    return deepFreeze({
      schema: "paperclip.phase7.run-context.v1",
      company: {
        id: this.#state.company.id,
        name: this.#state.company.name,
        issuePrefix: this.#state.company.issuePrefix,
        status: this.#state.company.status,
      },
      actor: {
        id: actor.id,
        name: actor.name,
        role: actor.role,
        status: actor.status,
        capabilityGrants: clone(actor.capabilityGrants),
      },
      activeTask: clone(task),
      ancestors,
      wake: sanitizeWake(run.wake),
      capabilities: clone(run.capabilities),
      budget: {
        limitCents,
        spentCents: limitCents - remainingCents,
        remainingCents,
      },
      interactionResults: this.#state.interactions
        .filter((interaction) => interaction.taskId === task.id && interaction.result !== null)
        .map(({ id, kind, status, result }) => ({ id, kind, status, result: clone(result) })),
    });
  }

  async appendEvent(event: NativeRunEvent | PrpEvent): Promise<AppendedEventReceipt> {
    this.#assertRunning();
    const run = this.#run(event.runId);
    this.#assertRunWritable(run);
    const fault = this.#consumeFault("append_event");
    this.#throwBeforeFault(fault, run.id, "append_event");
    if ("sourceEventId" in event) {
      const validation = validatePrpEvent(event);
      if (!validation.ok) {
        throw new Phase7MockControlPlaneError(
          "native_event_invalid",
          validation.issues[0]?.message ?? "event failed validation",
        );
      }
      const sameId = run.events.find(
        (candidate): candidate is PrpEvent =>
          "sourceEventId" in candidate && candidate.sourceEventId === event.sourceEventId,
      );
      const sameSequence = run.events.find(
        (candidate): candidate is PrpEvent =>
          "sourceSeq" in candidate &&
          candidate.sourceInstanceId === event.sourceInstanceId &&
          candidate.sourceSeq === event.sourceSeq,
      );
      for (const candidate of [sameId, sameSequence]) {
        if (candidate !== undefined) {
          if (canonicalJson(candidate) !== canonicalJson(event)) {
            throw new Phase7MockControlPlaneError(
              "native_event_replay_conflict",
              "event id or source sequence was replayed with different content",
            );
          }
          this.#recordDecisionOnly(run.id, "append_event", "duplicate", "event_already_committed", [
            `event:${event.sourceEventId}`,
          ]);
          return {
            cursor: event.sourceSeq,
            highestContiguousSourceSeq: this.#highestContiguous(run, event.sourceInstanceId),
            disposition: "duplicate",
          };
        }
      }
      run.events.push(clone(event));
      this.#recordMutation(run.id, run.actorId, "run.event_appended", "run", run.id, {
        sourceEventId: event.sourceEventId,
        sourceSeq: event.sourceSeq,
      }, "append_event", "allowed", "event_committed", [`event:${event.sourceEventId}`]);
      const receipt: AppendedEventReceipt = {
        cursor: event.sourceSeq,
        highestContiguousSourceSeq: this.#highestContiguous(run, event.sourceInstanceId),
        disposition: "committed",
      };
      this.#throwAfterFault(fault, run.id, "append_event");
      return receipt;
    }

    const nativeEvents = run.events.filter(
      (candidate): candidate is NativeRunEvent => "sequence" in candidate,
    );
    const sameSequence = nativeEvents.find((candidate) => candidate.sequence === event.sequence);
    if (sameSequence !== undefined) {
      if (canonicalJson(sameSequence) !== canonicalJson(event)) {
        throw new Phase7MockControlPlaneError(
          "native_event_replay_conflict",
          "native event sequence was replayed with different content",
        );
      }
      this.#recordDecisionOnly(run.id, "append_event", "duplicate", "event_already_committed", [
        `event:${event.eventId}`,
      ]);
      return {
        cursor: event.sequence,
        highestContiguousSourceSeq: nativeEvents.length,
        disposition: "duplicate",
      };
    }
    if (event.sequence !== nativeEvents.length + 1) {
      throw new Phase7MockControlPlaneError(
        "native_event_sequence_gap",
        `native event sequence must be ${nativeEvents.length + 1}`,
      );
    }
    run.events.push(clone(event));
    this.#recordMutation(run.id, run.actorId, "run.event_appended", "run", run.id, {
      eventId: event.eventId,
      sequence: event.sequence,
    }, "append_event", "allowed", "event_committed", [`event:${event.eventId}`]);
    const receipt: AppendedEventReceipt = {
      cursor: event.sequence,
      highestContiguousSourceSeq: event.sequence,
      disposition: "committed",
    };
    this.#throwAfterFault(fault, run.id, "append_event");
    return receipt;
  }

  async replayEvents(input: ReplayControlPlaneEventsInput): Promise<ReplayedControlPlaneEvents> {
    const run = this.#run(input.runId);
    if (input.sourceInstanceId !== run.sourceInstanceId) {
      throw new Phase7MockControlPlaneError(
        "replay_binding_mismatch",
        "replay source does not match the fixture run binding",
      );
    }
    return {
      events: run.events
        .filter(
          (event): event is PrpEvent =>
            "sourceSeq" in event &&
            event.sourceInstanceId === input.sourceInstanceId &&
            event.sourceSeq > input.afterSourceSeq,
        )
        .sort((left, right) => left.sourceSeq - right.sourceSeq)
        .slice(0, input.limit)
        .map(clone),
      highestContiguousSourceSeq: this.#highestContiguous(run, input.sourceInstanceId),
    };
  }

  async loadSessionCheckpoint(): Promise<PersistedNativeSession | null> {
    const run = this.#activeRun();
    return run.sessionCheckpoint === null ? null : clone(run.sessionCheckpoint);
  }

  async checkpointSession(snapshot: PersistedNativeSession): Promise<void> {
    const run = this.#activeRun();
    this.#assertRunWritable(run);
    run.sessionCheckpoint = clone(snapshot);
    this.#recordMutation(run.id, run.actorId, "run.session_checkpointed", "run", run.id, {},
      "apply_command", "allowed", "session_checkpoint_persisted", [`run:${run.id}`]);
  }

  async applyCommand(envelope: Phase7CommandEnvelope): Promise<Phase7CommandResult> {
    this.#assertRunning();
    if (envelope.idempotencyKey.trim().length === 0) {
      throw new Phase7MockControlPlaneError(
        "idempotency_key_required",
        "semantic commands require a non-empty idempotency key",
      );
    }
    const run = this.#run(envelope.runId);
    this.#assertRunWritable(run);
    const inputCanonical = canonicalJson(envelope.command);
    const scope = `${run.id}:semantic-command`;
    const existing = this.#state.idempotency.find(
      (record) => record.scope === scope && record.key === envelope.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.inputCanonical !== inputCanonical) {
        throw new Phase7MockControlPlaneError(
          "idempotency_conflict",
          "idempotency key was reused with a different semantic command",
        );
      }
      this.#recordDecisionOnly(run.id, envelope.command.kind, "duplicate", "command_already_applied", [
        ...existing.result.entityRefs,
      ]);
      return deepFreeze({ ...clone(existing.result), disposition: "duplicate" });
    }
    if (
      envelope.expectedRevision !== undefined &&
      envelope.expectedRevision !== this.#state.revision
    ) {
      throw new Phase7MockControlPlaneError(
        "state_revision_conflict",
        `expected state revision ${envelope.expectedRevision}, found ${this.#state.revision}`,
      );
    }
    this.#authorizeCommand(run, envelope.command);

    const fault = this.#consumeFault("apply_command", envelope.command.kind);
    this.#throwBeforeFault(fault, run.id, envelope.command.kind);
    const commandId = this.#id("command");
    const { entityRefs, scheduledWakeIds } = this.#executeCommand(run, envelope.command);
    this.#recordMutation(run.id, run.actorId, "semantic_command.applied", "command", commandId, {
      kind: envelope.command.kind,
      idempotencyKey: envelope.idempotencyKey,
      entityRefs,
    }, envelope.command.kind, "allowed", "semantic_command_applied", entityRefs);
    const result: Phase7CommandResult = {
      commandId,
      commandKind: envelope.command.kind,
      disposition: "applied",
      stateRevision: this.#state.revision,
      entityRefs,
      scheduledWakeIds,
    };
    this.#state.idempotency.push({
      scope,
      key: envelope.idempotencyKey,
      inputCanonical,
      result: clone(result),
    });
    this.#throwAfterFault(fault, run.id, envelope.command.kind);
    return deepFreeze(clone(result));
  }

  async tryApplyCommand(envelope: Phase7CommandEnvelope): Promise<Phase7CommandOutcome> {
    try {
      return { ok: true, result: await this.applyCommand(envelope) };
    } catch (error) {
      if (!(error instanceof Phase7MockControlPlaneError)) throw error;
      return deepFreeze({
        ok: false,
        commandKind: envelope.command.kind,
        stateRevision: this.#state.revision,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      });
    }
  }

  async completeRun(result: NativeRunResult | CompleteControlPlaneRunInput): Promise<void> {
    this.#assertRunning();
    const run = "runId" in result ? this.#run(result.runId) : this.#activeRun();
    if (run.result !== null) {
      if (canonicalJson(run.result) !== canonicalJson(result)) {
        throw new Phase7MockControlPlaneError(
          "native_result_replay_conflict",
          "run result was replayed with different content",
        );
      }
      this.#recordDecisionOnly(run.id, "complete_run", "duplicate", "terminal_result_already_committed", [
        `run:${run.id}`,
      ]);
      return;
    }
    this.#assertRunWritable(run);
    const fault = this.#consumeFault("complete_run");
    this.#throwBeforeFault(fault, run.id, "complete_run");
    const task = this.#task(run.taskId);
    const entityRefs = [`run:${run.id}`, `task:${task.id}`];
    if ("terminal" in result) {
      const validation = validatePrpStructuredRunResult(result.result);
      if (!validation.ok) {
        throw new Phase7MockControlPlaneError(
          "native_result_invalid",
          validation.issues[0]?.message ?? "structured result failed validation",
        );
      }
      if (!run.events.some((event) => "eventType" in event && event.eventType === "run.terminal")) {
        throw new Phase7MockControlPlaneError(
          "terminal_event_missing",
          "run.terminal must be committed before terminal reconciliation",
        );
      }
      this.#reconcileDisposition(run, task, result);
      run.status = result.terminal.runTerminalState;
    } else {
      if (!run.events.some((event) => "type" in event && event.type === "run.completed")) {
        throw new Phase7MockControlPlaneError(
          "terminal_event_missing",
          "run.completed must be committed before terminal reconciliation",
        );
      }
      run.status = result.status;
    }
    run.result = clone(result);
    run.finishedAt = this.#now();
    if (task.checkoutRunId === run.id) task.checkoutRunId = null;
    if (task.executionRunId === run.id) task.executionRunId = null;
    const wakeIds = this.#reconcileBlockerWakes(task);
    entityRefs.push(...wakeIds.map((id) => `wake:${id}`));
    this.#recordMutation(run.id, run.actorId, "run.completed", "run", run.id, {
      status: run.status,
      reconciledTaskStatus: task.status,
      wakeIds,
    }, "complete_run", "reconciled", "terminal_state_reconciled", entityRefs);
    this.#throwAfterFault(fault, run.id, "complete_run");
  }

  snapshot(): Readonly<Phase7FixtureState> {
    return deepFreeze(clone(this.#state));
  }

  decisionRecords(): readonly Phase7DecisionRecord[] {
    return deepFreeze(clone(this.#state.decisions));
  }

  serialize(): string {
    return canonicalJson(this.#state);
  }

  #executeCommand(
    run: Phase7FixtureRun,
    command: Phase7SemanticCommand,
  ): { entityRefs: string[]; scheduledWakeIds: string[] } {
    const task = this.#commandTask(run, command);
    const entityRefs = [`task:${task.id}`];
    const scheduledWakeIds: string[] = [];
    switch (command.kind) {
      case "report_progress": {
        requireText(command.body, "progress body");
        const comment = this.#appendComment(task.id, run.actorId, command.body);
        entityRefs.push(`comment:${comment.id}`);
        break;
      }
      case "write_document": {
        requireText(command.key, "document key");
        requireText(command.title, "document title");
        const existing = this.#state.documents.find(
          (document) => document.taskId === task.id && document.key === command.key,
        );
        if (existing === undefined && command.baseRevisionId !== null) {
          throw new Phase7MockControlPlaneError(
            "document_revision_conflict",
            "a new document must use a null base revision",
          );
        }
        if (existing !== undefined && existing.latestRevisionId !== command.baseRevisionId) {
          throw new Phase7MockControlPlaneError(
            "document_revision_conflict",
            `document latest revision is ${existing.latestRevisionId}`,
          );
        }
        const document = existing ?? this.#newDocument(task.id, command.key, command.title);
        const revision = {
          id: this.#id("revision"),
          documentId: document.id,
          revision: document.revisions.length + 1,
          body: command.body,
          changeSummary: command.changeSummary ?? null,
          createdAt: this.#now(),
        };
        document.title = command.title;
        document.latestRevisionId = revision.id;
        document.revisions.push(revision);
        entityRefs.push(`document:${document.id}`, `revision:${revision.id}`);
        break;
      }
      case "request_human_input": {
        const interaction = {
          id: this.#id("interaction"),
          taskId: task.id,
          kind: command.interactionKind,
          status: "pending" as const,
          title: requireText(command.title, "interaction title"),
          prompt: requireText(command.prompt, "interaction prompt"),
          payload: clone(command.payload ?? {}),
          targetRevisionId: command.targetRevisionId ?? null,
          continuationPolicy: command.continuationPolicy,
          result: null,
          createdAt: this.#now(),
          resolvedAt: null,
        };
        if (
          interaction.targetRevisionId !== null &&
          !this.#state.documents.some(
            (document) =>
              document.taskId === task.id &&
              document.revisions.some((revision) => revision.id === interaction.targetRevisionId),
          )
        ) {
          throw new Phase7MockControlPlaneError(
            "interaction_target_missing",
            "interaction target revision does not exist",
          );
        }
        if (
          interaction.targetRevisionId !== null &&
          !this.#state.documents.some(
            (document) =>
              document.taskId === task.id &&
              document.latestRevisionId === interaction.targetRevisionId,
          )
        ) {
          throw new Phase7MockControlPlaneError(
            "interaction_target_stale",
            "interaction target revision is not current",
          );
        }
        this.#state.interactions.push(interaction);
        this.#transitionTask(run, task, "in_review", command.kind);
        entityRefs.push(`interaction:${interaction.id}`);
        break;
      }
      case "resolve_human_input": {
        const interaction = this.#state.interactions.find(
          (candidate) => candidate.id === command.interactionId && candidate.taskId === task.id,
        );
        if (interaction === undefined) {
          throw new Phase7MockControlPlaneError("interaction_missing", "fixture interaction not found");
        }
        if (interaction.status !== "pending") {
          throw new Phase7MockControlPlaneError(
            "interaction_already_resolved",
            "fixture interaction has already been resolved",
          );
        }
        const allowedOutcomes = interaction.kind === "questions" || interaction.kind === "item_verdicts"
          ? ["answered", "rejected", "expired"]
          : ["accepted", "rejected", "expired"];
        if (!allowedOutcomes.includes(command.outcome)) {
          throw new Phase7MockControlPlaneError(
            "interaction_outcome_invalid",
            `${command.outcome} is not valid for ${interaction.kind}`,
          );
        }
        interaction.status = command.outcome;
        interaction.result = clone(command.result);
        interaction.resolvedAt = this.#now();
        const shouldWake =
          interaction.continuationPolicy === "wake_assignee" ||
          (interaction.continuationPolicy === "wake_assignee_on_accept" &&
            command.outcome === "accepted");
        if (shouldWake && task.assigneeActorId !== null) {
          const wakeId = this.#scheduleWake(
            task.assigneeActorId,
            task.id,
            "interaction_resolved",
            { interactionId: interaction.id, outcome: command.outcome },
            0,
          );
          scheduledWakeIds.push(wakeId);
        }
        entityRefs.push(`interaction:${interaction.id}`);
        break;
      }
      case "register_deliverable": {
        if (!Number.isSafeInteger(command.byteSize) || command.byteSize < 0) {
          throw new Phase7MockControlPlaneError(
            "artifact_invalid",
            "artifact byteSize must be a non-negative safe integer",
          );
        }
        const artifact = {
          id: this.#id("artifact"),
          taskId: task.id,
          filename: requireText(command.filename, "artifact filename"),
          contentType: requireText(command.contentType, "artifact content type"),
          byteSize: command.byteSize,
          sha256: requireText(command.sha256, "artifact sha256"),
          contentRef: requireText(command.contentRef, "artifact content ref"),
          createdAt: this.#now(),
        };
        const workProduct = {
          id: this.#id("work-product"),
          taskId: task.id,
          type: "artifact" as const,
          title: requireText(command.title, "work product title"),
          metadata: {
            filename: artifact.filename,
            contentType: artifact.contentType,
            byteSize: artifact.byteSize,
            contentRef: artifact.contentRef,
          },
          artifactId: artifact.id,
          createdAt: this.#now(),
        };
        this.#state.artifacts.push(artifact);
        this.#state.workProducts.push(workProduct);
        entityRefs.push(`artifact:${artifact.id}`, `work-product:${workProduct.id}`);
        break;
      }
      case "set_dependencies": {
        this.#replaceDependencies(task, command.blockedByTaskIds);
        if (command.blockedByTaskIds.length > 0) {
          this.#transitionTask(run, task, "blocked", command.kind);
        }
        entityRefs.push(...command.blockedByTaskIds.map((id) => `task:${id}`));
        break;
      }
      case "create_task": {
        if (command.assigneeActorId !== undefined && command.assigneeActorId !== null) {
          const assignee = this.#actor(command.assigneeActorId);
          this.#assertCompany(this.#state.company.id, assignee.companyId);
        }
        const childId = this.#id("task");
        const child: Phase7FixtureTask = {
          id: childId,
          companyId: task.companyId,
          identifier: `${this.#state.company.issuePrefix}-${this.#nextCounter("issue-number")}`,
          title: requireText(command.title, "task title"),
          description: command.description ?? null,
          status: command.blockedByTaskIds?.length ? "blocked" : "todo",
          priority: command.priority ?? "medium",
          workMode: "standard",
          parentId: task.id,
          assigneeActorId: command.assigneeActorId ?? null,
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        };
        this.#state.tasks.push(child);
        if (command.blockedByTaskIds?.length) {
          this.#replaceDependencies(child, command.blockedByTaskIds);
        }
        entityRefs.push(`task:${child.id}`);
        break;
      }
      case "request_approval": {
        const approval = {
          id: this.#id("approval"),
          companyId: task.companyId,
          taskIds: [task.id],
          type: requireText(command.approvalType, "approval type"),
          status: "pending" as const,
          requestedByActorId: run.actorId,
          payload: clone(command.payload),
          decisionNote: null,
          comments: [],
          createdAt: this.#now(),
          decidedAt: null,
        };
        this.#state.approvals.push(approval);
        this.#transitionTask(run, task, "in_review", command.kind);
        entityRefs.push(`approval:${approval.id}`);
        break;
      }
      case "decide_approval": {
        const approval = this.#state.approvals.find(
          (candidate) => candidate.id === command.approvalId && candidate.companyId === task.companyId,
        );
        if (approval === undefined) {
          throw new Phase7MockControlPlaneError("approval_missing", "fixture approval not found");
        }
        if (approval.status !== "pending") {
          throw new Phase7MockControlPlaneError(
            "approval_already_decided",
            "fixture approval has already been decided",
          );
        }
        approval.status = command.decision;
        approval.decisionNote = requireText(command.note, "approval decision note");
        approval.decidedAt = this.#now();
        for (const linkedTaskId of approval.taskIds) {
          const linkedTask = this.#task(linkedTaskId);
          if (linkedTask.assigneeActorId !== null) {
            const wakeId = this.#scheduleWake(
              linkedTask.assigneeActorId,
              linkedTask.id,
              "approval_resolved",
              { approvalId: approval.id, decision: command.decision },
              0,
            );
            scheduledWakeIds.push(wakeId);
          }
        }
        entityRefs.push(`approval:${approval.id}`);
        break;
      }
      case "comment_on_approval": {
        const approval = this.#state.approvals.find(
          (candidate) => candidate.id === command.approvalId && candidate.companyId === task.companyId,
        );
        if (approval === undefined) {
          throw new Phase7MockControlPlaneError("approval_missing", "fixture approval not found");
        }
        const comment = {
          id: this.#id("approval-comment"),
          authorActorId: run.actorId,
          body: requireText(command.body, "approval comment body"),
          createdAt: this.#now(),
        };
        approval.comments.push(comment);
        entityRefs.push(`approval:${approval.id}`, `approval-comment:${comment.id}`);
        break;
      }
      case "control_workspace_service": {
        const service = this.#state.workspaceServices.find(
          (candidate) => candidate.id === command.serviceId && candidate.taskId === task.id,
        );
        if (service === undefined) {
          throw new Phase7MockControlPlaneError(
            "workspace_service_missing",
            "fixture workspace service not found",
          );
        }
        service.status = command.action === "start" ? "running" : command.action === "stop" ? "stopped" : "failed";
        service.url = command.action === "start" ? command.url ?? service.url : null;
        service.lastTransitionAt = this.#now();
        entityRefs.push(`workspace-service:${service.id}`);
        break;
      }
      case "record_budget_usage": {
        if (!Number.isSafeInteger(command.cents) || command.cents < 0) {
          throw new Phase7MockControlPlaneError(
            "budget_usage_invalid",
            "budget usage must be a non-negative safe integer",
          );
        }
        const actor = this.#actor(run.actorId);
        const budgets = this.#effectiveBudgets(actor);
        for (const budget of budgets) budget.spentCents += command.cents;
        const stopped = budgets.some(
          (budget) => budget.hardStop && budget.spentCents >= budget.limitCents,
        );
        entityRefs.push(...budgets.map((budget) => `budget:${budget.id}`));
        if (stopped) {
          actor.status = "paused";
          run.status = "budget_stopped";
          this.#transitionTask(run, task, "blocked", command.kind);
          if (task.checkoutRunId === run.id) task.checkoutRunId = null;
          if (task.executionRunId === run.id) task.executionRunId = null;
          const comment = this.#appendComment(
            task.id,
            null,
            "Budget hard stop reached; the fixture actor was paused and the run lock was released.",
          );
          entityRefs.push(`comment:${comment.id}`, `actor:${actor.id}`);
        }
        break;
      }
      case "finish_task": {
        requireText(command.summary, "completion summary");
        if (this.#state.blockers.some((blocker) => blocker.taskId === task.id)) {
          throw new Phase7MockControlPlaneError(
            "task_has_blockers",
            "a fixture task with unresolved blockers cannot be finished",
          );
        }
        this.#transitionTask(run, task, "done", command.kind);
        task.completedAt = this.#now();
        const comment = this.#appendComment(task.id, run.actorId, command.summary);
        entityRefs.push(`comment:${comment.id}`);
        break;
      }
      case "block_task": {
        requireText(command.reason, "block reason");
        if (command.blockedByTaskIds !== undefined) {
          this.#replaceDependencies(task, command.blockedByTaskIds);
          entityRefs.push(...command.blockedByTaskIds.map((id) => `task:${id}`));
        }
        this.#transitionTask(run, task, "blocked", command.kind);
        const comment = this.#appendComment(task.id, run.actorId, command.reason);
        entityRefs.push(`comment:${comment.id}`);
        break;
      }
      case "request_review": {
        this.#transitionTask(run, task, "in_review", command.kind);
        const comment = this.#appendComment(
          task.id,
          run.actorId,
          requireText(command.summary, "review summary"),
        );
        entityRefs.push(`comment:${comment.id}`);
        break;
      }
      case "release_task": {
        requireText(command.reason, "release reason");
        if (task.checkoutRunId !== run.id) {
          throw new Phase7MockControlPlaneError(
            "release_lock_mismatch",
            "the fixture run does not own the task checkout lock",
          );
        }
        this.#transitionTask(run, task, "todo", command.kind);
        task.checkoutRunId = null;
        task.executionRunId = null;
        const comment = this.#appendComment(task.id, run.actorId, command.reason);
        entityRefs.push(`comment:${comment.id}`);
        break;
      }
      case "schedule_wake": {
        if (!Number.isSafeInteger(command.delayTicks) || command.delayTicks < 0) {
          throw new Phase7MockControlPlaneError(
            "wake_delay_invalid",
            "wake delayTicks must be a non-negative safe integer",
          );
        }
        if (task.assigneeActorId === null) {
          throw new Phase7MockControlPlaneError(
            "wake_assignee_missing",
            "cannot schedule a fixture wake for an unassigned task",
          );
        }
        const wakeId = this.#scheduleWake(
          task.assigneeActorId,
          task.id,
          command.reason,
          command.payload ?? {},
          command.delayTicks,
        );
        scheduledWakeIds.push(wakeId);
        entityRefs.push(`wake:${wakeId}`);
        break;
      }
      default:
        return assertNever(command);
    }
    return { entityRefs: sortedUnique(entityRefs), scheduledWakeIds };
  }

  #reconcileDisposition(
    run: Phase7FixtureRun,
    task: Phase7FixtureTask,
    completion: CompleteControlPlaneRunInput,
  ): void {
    switch (completion.result.reportedWorkDisposition) {
      case "done":
        if (this.#state.blockers.some((blocker) => blocker.taskId === task.id)) {
          throw new Phase7MockControlPlaneError(
            "terminal_reconciliation_failed",
            "a done result cannot reconcile a task with unresolved blockers",
          );
        }
        task.status = "done";
        task.completedAt ??= this.#now();
        break;
      case "blocked":
        task.status = "blocked";
        break;
      case "needs_review":
        task.status = "in_review";
        break;
      case "yielded": {
        task.status = "todo";
        if (task.assigneeActorId !== null) {
          this.#scheduleWake(
            task.assigneeActorId,
            task.id,
            "scheduled_retry",
            {
              runId: run.id,
              continuation: toJsonValue(completion.result.continuation ?? {}),
            },
            1,
          );
        }
        break;
      }
    }
  }

  #reconcileBlockerWakes(completedTask: Phase7FixtureTask): string[] {
    if (completedTask.status !== "done") return [];
    const dependentIds = sortedUnique(
      this.#state.blockers
        .filter((blocker) => blocker.blockedByTaskId === completedTask.id)
        .map((blocker) => blocker.taskId),
    );
    const wakeIds: string[] = [];
    for (const dependentId of dependentIds) {
      const unresolved = this.#state.blockers.filter(
        (blocker) =>
          blocker.taskId === dependentId && this.#task(blocker.blockedByTaskId).status !== "done",
      );
      if (unresolved.length > 0) continue;
      this.#state.blockers = this.#state.blockers.filter(
        (blocker) => blocker.taskId !== dependentId,
      );
      const dependent = this.#task(dependentId);
      if (dependent.status === "blocked") dependent.status = "todo";
      if (dependent.assigneeActorId !== null) {
        wakeIds.push(
          this.#scheduleWake(
            dependent.assigneeActorId,
            dependent.id,
            "blockers_resolved",
            { completedTaskId: completedTask.id },
            0,
          ),
        );
      }
    }
    return wakeIds;
  }

  #replaceDependencies(task: Phase7FixtureTask, blockedByTaskIds: string[]): void {
    const unique = sortedUnique(blockedByTaskIds);
    if (unique.includes(task.id)) {
      throw new Phase7MockControlPlaneError("dependency_cycle", "a task cannot block itself");
    }
    for (const blockerId of unique) {
      const blocker = this.#task(blockerId);
      this.#assertCompany(task.companyId, blocker.companyId);
      if (this.#dependsOn(blocker.id, task.id)) {
        throw new Phase7MockControlPlaneError(
          "dependency_cycle",
          `dependency ${blocker.id} would create a cycle`,
        );
      }
    }
    this.#state.blockers = this.#state.blockers.filter((blocker) => blocker.taskId !== task.id);
    for (const blockerId of unique) {
      this.#state.blockers.push({
        id: this.#id("blocker"),
        taskId: task.id,
        blockedByTaskId: blockerId,
        createdAt: this.#now(),
      });
    }
  }

  #dependsOn(taskId: string, candidateAncestorId: string, visited = new Set<string>()): boolean {
    if (taskId === candidateAncestorId) return true;
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    return this.#state.blockers
      .filter((blocker) => blocker.taskId === taskId)
      .some((blocker) => this.#dependsOn(blocker.blockedByTaskId, candidateAncestorId, visited));
  }

  #newDocument(taskId: string, key: string, title: string): Phase7FixtureDocument {
    const document: Phase7FixtureDocument = {
      id: this.#id("document"),
      taskId,
      key,
      title,
      format: "markdown",
      latestRevisionId: "",
      revisions: [],
    };
    this.#state.documents.push(document);
    return document;
  }

  #appendComment(taskId: string, authorActorId: string | null, body: string) {
    const comment = {
      id: this.#id("comment"),
      taskId,
      authorActorId,
      body,
      createdAt: this.#now(),
    };
    this.#state.comments.push(comment);
    return comment;
  }

  #scheduleWake(
    actorId: string,
    taskId: string,
    reason: Phase7WakeContext["reason"],
    payload: Phase7JsonValue,
    delayTicks: number,
  ): string {
    const createdAt = this.#now();
    const dueAt = new Date(
      Date.parse(createdAt) + delayTicks * 1_000,
    ).toISOString();
    const id = this.#id("wake");
    this.#state.wakes.push({
      id,
      actorId,
      taskId,
      reason,
      payload: sanitizeJson(payload),
      dueAt,
      status: "scheduled",
      createdAt,
    });
    return id;
  }

  #assertBudgetAvailable(actor: Phase7FixtureActor, runId: string): void {
    const exceeded = this.#effectiveBudgets(actor).find(
      (budget) => budget.hardStop && budget.spentCents >= budget.limitCents,
    );
    if (exceeded === undefined) return;
    actor.status = "paused";
    this.#recordMutation(runId, actor.id, "budget.hard_stop", "budget", exceeded.id, {
      spentCents: exceeded.spentCents,
      limitCents: exceeded.limitCents,
    }, "open_run", "denied", "budget_hard_stop", [`budget:${exceeded.id}`, `actor:${actor.id}`]);
    throw new Phase7MockControlPlaneError(
      "budget_hard_stop",
      `fixture budget ${exceeded.id} has reached its hard limit`,
    );
  }

  #effectiveBudgets(actor: Phase7FixtureActor) {
    const budgets = this.#state.budgets.filter(
      (budget) =>
        (budget.scope === "company" && budget.scopeId === actor.companyId) ||
        (budget.scope === "actor" && budget.scopeId === actor.id),
    );
    if (budgets.length === 0) {
      throw new Phase7MockControlPlaneError(
        "fixture_state_invalid",
        `actor ${actor.id} has no fixture budget`,
      );
    }
    return budgets;
  }

  #consumeFault(
    operation: Phase7FaultRule["operation"],
    commandKind?: Phase7SemanticCommand["kind"],
  ): Phase7FaultRule | null {
    const fault = this.#state.faults.find(
      (candidate) =>
        candidate.operation === operation &&
        candidate.remaining > 0 &&
        (candidate.commandKind === undefined || candidate.commandKind === commandKind),
    );
    if (fault === undefined) return null;
    fault.remaining -= 1;
    return clone(fault);
  }

  #throwBeforeFault(fault: Phase7FaultRule | null, runId: string, operation: string): void {
    if (fault?.effect !== "retryable_error") return;
    this.#recordDecisionOnly(runId, operation, "faulted", fault.code, [`fault:${fault.id}`]);
    throw new Phase7MockControlPlaneError(fault.code, `scripted fault ${fault.id}`, true);
  }

  #throwAfterFault(fault: Phase7FaultRule | null, runId: string, operation: string): void {
    if (fault?.effect !== "lost_ack") return;
    this.#recordDecisionOnly(runId, operation, "faulted", fault.code, [`fault:${fault.id}`]);
    throw new Phase7MockControlPlaneError(fault.code, `scripted lost acknowledgement ${fault.id}`, true);
  }

  #assertRunBinding(run: Phase7FixtureRun, input: Phase7OpenFixtureRunInput): void {
    const expected = {
      companyId: run.companyId,
      actorId: run.actorId,
      taskId: run.taskId,
      sessionId: run.sessionId,
      backendKind: run.backendKind,
      sourceInstanceId: run.sourceInstanceId,
    };
    const received = {
      companyId: input.identity.companyId,
      actorId: input.identity.agentId,
      taskId: input.identity.issueId,
      sessionId: input.identity.sessionId,
      backendKind: input.backendKind,
      sourceInstanceId: input.sourceInstanceId ?? "phase7-mock",
    };
    if (canonicalJson(expected) !== canonicalJson(received)) {
      throw new Phase7MockControlPlaneError(
        "run_binding_conflict",
        "fixture run id is already bound to different context",
      );
    }
  }

  #authorizeCommand(run: Phase7FixtureRun, command: Phase7SemanticCommand): void {
    const requiredClaims = PHASE7_COMMAND_REQUIRED_CLAIMS[command.kind];
    const missingClaims = requiredClaims.filter((claim) => !run.capabilities.includes(claim));
    if (missingClaims.length > 0) {
      this.#deny(run.id, command.kind, "required_claim_missing", [`task:${run.taskId}`]);
      throw new Phase7MockControlPlaneError(
        "operation_not_authorized",
        "the fixture run does not hold the required command claim",
      );
    }

    const task = this.#commandTask(run, command);
    if (
      task.assigneeActorId !== run.actorId ||
      task.checkoutRunId !== run.id ||
      task.executionRunId !== run.id
    ) {
      this.#deny(run.id, command.kind, "run_does_not_own_task", [`task:${task.id}`]);
      throw new Phase7MockControlPlaneError(
        "task_ownership_violation",
        "the fixture run does not own the active task",
      );
    }

    if (command.kind === "decide_approval") {
      const actor = this.#actor(run.actorId);
      if (!["board", "approver", "security"].includes(actor.role.trim().toLowerCase())) {
        this.#deny(run.id, command.kind, "actor_role_not_authorized", [
          `actor:${actor.id}`,
        ]);
        throw new Phase7MockControlPlaneError(
          "operation_not_authorized",
          "the fixture actor role cannot decide approvals",
        );
      }
      const approval = this.#state.approvals.find(
        (candidate) => candidate.id === command.approvalId && candidate.companyId === run.companyId,
      );
      if (approval?.requestedByActorId === actor.id) {
        this.#deny(run.id, command.kind, "self_approval_forbidden", [
          `approval:${approval.id}`,
        ]);
        throw new Phase7MockControlPlaneError(
          "self_approval_forbidden",
          "the fixture actor cannot decide its own approval request",
        );
      }
    }
  }

  #commandTask(run: Phase7FixtureRun, command: Phase7SemanticCommand): Phase7FixtureTask {
    const task = this.#task(command.taskId ?? run.taskId);
    this.#assertCompany(run.companyId, task.companyId);
    if (task.id !== run.taskId) {
      this.#deny(run.id, command.kind, "active_task_scope_required", [`task:${task.id}`]);
      throw new Phase7MockControlPlaneError(
        "task_scope_violation",
        "semantic commands are scoped to the active fixture task",
      );
    }
    return task;
  }

  #transitionTask(
    run: Phase7FixtureRun,
    task: Phase7FixtureTask,
    next: Phase7FixtureTask["status"],
    operation: Phase7SemanticCommand["kind"],
  ): void {
    const allowed: Record<Phase7FixtureTask["status"], readonly Phase7FixtureTask["status"][]> = {
      backlog: ["todo", "cancelled"],
      todo: ["in_progress", "blocked", "cancelled"],
      in_progress: ["in_review", "blocked", "done", "cancelled"],
      in_review: ["in_progress", "done", "cancelled"],
      blocked: ["todo", "in_progress", "cancelled"],
      done: [],
      cancelled: [],
    };
    const releaseToTodo = operation === "release_task" && task.status === "in_progress" && next === "todo";
    const preserveReview =
      (operation === "request_human_input" || operation === "request_approval") &&
      task.status === "in_review" &&
      next === "in_review";
    if (!releaseToTodo && !preserveReview && !allowed[task.status].includes(next)) {
      this.#deny(run.id, operation, "task_transition_illegal", [`task:${task.id}`]);
      throw new Phase7MockControlPlaneError(
        "task_transition_illegal",
        `fixture task cannot transition from ${task.status} to ${next}`,
      );
    }
    task.status = next;
  }

  #assertCompany(expected: string, ...actual: string[]): void {
    if (actual.some((companyId) => companyId !== expected) || this.#state.company.id !== expected) {
      throw new Phase7MockControlPlaneError(
        "company_scope_violation",
        "fixture entity is outside the run company",
      );
    }
  }

  #assertRunWritable(run: Phase7FixtureRun): void {
    if (run.status === "budget_stopped") {
      throw new Phase7MockControlPlaneError(
        "budget_hard_stop",
        "fixture run was stopped by the budget hard limit",
      );
    }
    if (run.status !== "running") {
      throw new Phase7MockControlPlaneError(
        "run_not_writable",
        `fixture run is ${run.status}`,
      );
    }
  }

  #highestContiguous(run: Phase7FixtureRun, sourceInstanceId: string): number {
    const sequences = new Set(
      run.events
        .filter(
          (event): event is PrpEvent =>
            "sourceSeq" in event && event.sourceInstanceId === sourceInstanceId,
        )
        .map((event) => event.sourceSeq),
    );
    let cursor = 0;
    while (sequences.has(cursor + 1)) cursor += 1;
    return cursor;
  }

  #recordMutation(
    runId: string | null,
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    details: Phase7JsonValue,
    operation: string,
    outcome: Phase7DecisionRecord["outcome"],
    reason: string,
    entityRefs: string[],
  ): void {
    this.#state.revision += 1;
    const at = this.#now();
    const audit: Phase7AuditRecord = {
      id: this.#id("audit"),
      at,
      runId,
      actorId,
      action,
      entityType,
      entityId,
      details: clone(details),
    };
    this.#state.audit.push(audit);
    this.#state.decisions.push({
      id: this.#id("decision"),
      at,
      runId,
      operation,
      outcome,
      reason,
      stateRevision: this.#state.revision,
      entityRefs: sortedUnique(entityRefs),
    });
  }

  #recordDecisionOnly(
    runId: string | null,
    operation: string,
    outcome: Phase7DecisionRecord["outcome"],
    reason: string,
    entityRefs: string[],
  ): void {
    this.#state.revision += 1;
    this.#state.decisions.push({
      id: this.#id("decision"),
      at: this.#now(),
      runId,
      operation,
      outcome,
      reason,
      stateRevision: this.#state.revision,
      entityRefs: sortedUnique(entityRefs),
    });
  }

  #deny(runId: string | null, operation: string, reason: string, entityRefs: string[]): void {
    this.#recordDecisionOnly(runId, operation, "denied", reason, entityRefs);
  }

  #actor(id: string): Phase7FixtureActor {
    const actor = this.#state.actors.find((candidate) => candidate.id === id);
    if (actor === undefined) {
      throw new Phase7MockControlPlaneError("actor_missing", `fixture actor ${id} not found`);
    }
    return actor;
  }

  #task(id: string): Phase7FixtureTask {
    const task = this.#state.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
      throw new Phase7MockControlPlaneError("task_missing", `fixture task ${id} not found`);
    }
    return task;
  }

  #run(id: string): Phase7FixtureRun {
    const run = this.#state.runs.find((candidate) => candidate.id === id);
    if (run === undefined) {
      throw new Phase7MockControlPlaneError("run_missing", `fixture run ${id} not found`);
    }
    return run;
  }

  #activeRun(): Phase7FixtureRun {
    if (this.#state.activeRunId === null) {
      throw new Phase7MockControlPlaneError("run_missing", "no active fixture run");
    }
    return this.#run(this.#state.activeRunId);
  }

  #assertRunning(): void {
    if (this.#state.lifecycle !== "running") {
      throw new Phase7MockControlPlaneError(
        "mock_not_running",
        "Phase 7 mock control plane must be started first",
      );
    }
  }

  #nextCounter(kind: string): number {
    const next = (this.#state.counters[kind] ?? 0) + 1;
    this.#state.counters[kind] = next;
    return next;
  }

  #id(kind: string): string {
    return `fixture-${kind}-${String(this.#nextCounter(kind)).padStart(4, "0")}`;
  }

  #now(): string {
    const value = new Date(this.#state.clock.epochMs + this.#state.clock.tick * 1_000).toISOString();
    this.#state.clock.tick += 1;
    return value;
  }

  #validateState(): void {
    if (this.#state.company.id.trim().length === 0) {
      throw new Phase7MockControlPlaneError("fixture_state_invalid", "fixture company id is required");
    }
    const ids = new Set<string>();
    for (const [kind, values] of [
      ["actor", this.#state.actors],
      ["task", this.#state.tasks],
      ["run", this.#state.runs],
    ] as const) {
      for (const value of values) {
        const scoped = `${kind}:${value.id}`;
        if (ids.has(scoped)) {
          throw new Phase7MockControlPlaneError(
            "fixture_state_invalid",
            `duplicate fixture ${kind} id ${value.id}`,
          );
        }
        ids.add(scoped);
      }
    }
    for (const actor of this.#state.actors) this.#assertCompany(this.#state.company.id, actor.companyId);
    for (const task of this.#state.tasks) this.#assertCompany(this.#state.company.id, task.companyId);
  }
}

function isFixtureState(value: unknown): value is Phase7FixtureState {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === "paperclip.phase7.mock-state.v1"
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireText(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Phase7MockControlPlaneError("semantic_command_invalid", `${name} is required`);
  }
  return value;
}

function sanitizeWake(wake: Phase7WakeContext): Phase7WakeContext {
  return { reason: wake.reason, payload: sanitizeJson(wake.payload) };
}

function sanitizeJson(value: Phase7JsonValue): Phase7JsonValue {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /authorization|credential|api.?key|secret|token/i.test(key)
        ? "[REDACTED]"
        : sanitizeJson(child),
    ]),
  );
}

function toJsonValue(value: unknown): Phase7JsonValue {
  return JSON.parse(JSON.stringify(value)) as Phase7JsonValue;
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
  return JSON.stringify(value) ?? "undefined";
}

function assertNever(value: never): never {
  throw new Phase7MockControlPlaneError(
    "semantic_command_invalid",
    `unsupported semantic command ${canonicalJson(value)}`,
  );
}
