import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  CapabilityCommandOutcome,
  CapabilityJsonValue,
  CapabilityMockControlPlanePort,
  CapabilityRunContext,
  CapabilitySemanticCommand,
} from "../mock-core/capability-control-plane-types.js";
import {
  CAPABILITY_SEMANTIC_TOOL_CATALOG,
  capabilitySemanticToolDescriptor,
} from "./catalog.js";
import {
  createCapabilitySemanticPolicyContext,
  decideCapabilitySemanticAuthorization,
  DEFAULT_CAPABILITY_SCENARIO_POLICY,
} from "./policy.js";
import {
  containsProtectedSemanticData,
  redactSemanticValue,
} from "./redaction.js";
import { discoverCapabilityDefinitions } from "./discovery.js";
import type {
  CapabilitySemanticAuthorizationDecision,
  CapabilitySemanticAuthorizationRecord,
  CapabilitySemanticDenialCode,
  CapabilitySemanticOperationId,
  CapabilitySemanticPolicyContext,
  CapabilitySemanticScenarioPolicy,
  CapabilitySemanticToolCall,
  CapabilitySemanticToolDefinition,
  CapabilitySemanticToolDescriptor,
  CapabilitySemanticToolResult,
} from "./types.js";

export type CapabilitySemanticControlPlane = Pick<
  CapabilityMockControlPlanePort,
  "context" | "snapshot" | "tryApplyCommand"
>;

export interface CapabilitySemanticDispatcherOptions {
  readonly scenario?: CapabilitySemanticScenarioPolicy;
  readonly explicitClaims?: readonly string[];
}

interface OperationSuccess {
  result: CapabilityJsonValue;
  stateRevision: number;
}

class SemanticDispatchFailure extends Error {
  constructor(
    readonly code: CapabilitySemanticDenialCode,
    message: string,
    readonly retryable = false,
    readonly controlPlaneCode?: string,
  ) {
    super(message);
    this.name = "SemanticDispatchFailure";
  }
}

export class CapabilitySemanticDispatcher {
  readonly #validators = new Map<CapabilitySemanticOperationId, ValidateFunction>();
  readonly #records: CapabilitySemanticAuthorizationRecord[] = [];
  #recordCounter = 0;

  constructor(
    readonly port: CapabilitySemanticControlPlane,
    readonly options: CapabilitySemanticDispatcherOptions = {},
  ) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const descriptor of CAPABILITY_SEMANTIC_TOOL_CATALOG) {
      this.#validators.set(descriptor.operationId, ajv.compile(descriptor.inputSchema));
    }
  }

  listTools(runId: string): readonly CapabilitySemanticToolDefinition[] {
    const policyContext = this.#policyContext(runId);
    const definitions: CapabilitySemanticToolDefinition[] = [];
    for (const descriptor of CAPABILITY_SEMANTIC_TOOL_CATALOG) {
      const decision = decideCapabilitySemanticAuthorization(
        descriptor,
        policyContext,
        "exposure",
      );
      this.#record(policyContext, decision, null, null, null);
      if (decision.allowed) definitions.push(toDefinition(descriptor));
    }
    return deepFreeze(definitions);
  }

  discoverTools(
    runId: string,
    query: string,
    options: { namespace?: string; limit?: number } = {},
  ) {
    return discoverCapabilityDefinitions(query, this.#policyContext(runId), options);
  }

  authorizationRecords(): readonly CapabilitySemanticAuthorizationRecord[] {
    return deepFreeze(structuredClone(this.#records));
  }

  async dispatch(call: CapabilitySemanticToolCall): Promise<CapabilitySemanticToolResult> {
    const descriptor = capabilitySemanticToolDescriptor(call.operationId);
    if (descriptor === undefined) {
      return this.#unknownToolDenial(call);
    }

    const policyContext = this.#policyContext(call.runId);
    const invocation = decideCapabilitySemanticAuthorization(
      descriptor,
      policyContext,
      "invocation",
      call.input,
    );
    if (!invocation.allowed) {
      const result = this.#denial(call, descriptor.operationId, denialCode(invocation), invocation.reason);
      this.#record(policyContext, invocation, call.callId, call.input, result);
      return result;
    }

    if (containsProtectedSemanticData(call.input)) {
      const decision = deniedDecision(
        invocation,
        "protected_data_denied",
        "Protected data is not accepted by semantic tools.",
      );
      const result = this.#denial(call, descriptor.operationId, denialCode(decision), decision.reason);
      this.#record(policyContext, decision, call.callId, call.input, result);
      return result;
    }

    const validator = this.#validators.get(descriptor.operationId);
    if (validator === undefined || !validator(call.input)) {
      const decision = deniedDecision(
        invocation,
        "input_invalid",
        formatValidationError(validator),
      );
      const result = this.#denial(call, descriptor.operationId, denialCode(decision), decision.reason);
      this.#record(policyContext, decision, call.callId, call.input, result);
      return result;
    }

    try {
      const executed = await this.#execute(
        descriptor.operationId,
        call.runId,
        call.input as Record<string, unknown>,
      );
      const result = deepFreeze({
        ok: true,
        operationId: descriptor.operationId,
        callId: call.callId,
        result: redactSemanticValue(executed.result),
        stateRevision: executed.stateRevision,
      } as const);
      this.#record(policyContext, invocation, call.callId, call.input, result);
      return result;
    } catch (error) {
      const failure = normalizeFailure(error);
      const decision = deniedDecision(invocation, failure.code, failure.message);
      const result = this.#denial(
        call,
        descriptor.operationId,
        failure.code,
        failure.message,
        failure.retryable,
        failure.controlPlaneCode,
      );
      this.#record(policyContext, decision, call.callId, call.input, result);
      return result;
    }
  }

  #policyContext(runId: string): CapabilitySemanticPolicyContext {
    const context = this.port.context(runId);
    const scenario = this.options.scenario ?? DEFAULT_CAPABILITY_SCENARIO_POLICY;
    return {
      ...createCapabilitySemanticPolicyContext(
        context,
        scenario,
        this.options.explicitClaims ?? context.capabilities,
      ),
      runId,
    };
  }

  async #execute(
    operationId: CapabilitySemanticOperationId,
    runId: string,
    input: Record<string, unknown>,
  ): Promise<OperationSuccess> {
    const context = this.port.context(runId);
    const state = this.port.snapshot();
    switch (operationId) {
      case "get_task_context":
        return readSuccess(state.revision, context);
      case "get_task_history": {
        const limit = optionalNumber(input.limit, 50);
        return readSuccess(state.revision, {
          comments: state.comments
            .filter((comment) => comment.taskId === context.activeTask.id)
            .slice(-limit),
        });
      }
      case "list_documents":
        return readSuccess(state.revision, {
          documents: state.documents
            .filter((document) => document.taskId === context.activeTask.id)
            .map((document) => ({
              id: document.id,
              key: document.key,
              title: document.title,
              format: document.format,
              latestRevisionId: document.latestRevisionId,
              revisionCount: document.revisions.length,
            })),
        });
      case "read_document": {
        const document = activeDocument(state.documents, context, requiredString(input.key));
        const revision = document.revisions.find(
          (candidate) => candidate.id === document.latestRevisionId,
        );
        if (revision === undefined) {
          throw new SemanticDispatchFailure("operation_unavailable", "Document revision is missing.");
        }
        return readSuccess(state.revision, { document, revision });
      }
      case "list_document_revisions": {
        const document = activeDocument(state.documents, context, requiredString(input.key));
        const limit = optionalNumber(input.limit, 50);
        return readSuccess(state.revision, {
          documentId: document.id,
          key: document.key,
          revisions: document.revisions.slice(-limit),
        });
      }
      case "list_agents":
        return readSuccess(state.revision, {
          actors: state.actors.map(({ capabilityGrants: _claims, budgetId: _budget, ...actor }) => actor),
        });
      case "get_agent": {
        const actor = state.actors.find((candidate) => candidate.id === requiredString(input.actorId));
        if (actor === undefined) throw new SemanticDispatchFailure("operation_unavailable", "Mock actor not found.");
        const { capabilityGrants: _claims, budgetId: _budget, ...profile } = actor;
        return readSuccess(state.revision, { actor: profile });
      }
      case "search_tasks": {
        const query = optionalString(input.query)?.toLowerCase();
        const statuses = optionalStringArray(input.statuses);
        const limit = optionalNumber(input.limit, 50);
        const tasks = state.tasks.filter((task) =>
          (query === undefined || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query)) &&
          (statuses.length === 0 || statuses.includes(task.status)),
        ).slice(0, limit);
        return readSuccess(state.revision, { tasks });
      }
      case "list_approvals":
        return readSuccess(state.revision, { approvals: state.approvals });
      case "get_approval": {
        const approval = approvalById(state.approvals, requiredString(input.approvalId));
        return readSuccess(state.revision, { approval });
      }
      case "get_approval_context": {
        const approval = approvalById(state.approvals, requiredString(input.approvalId));
        return readSuccess(state.revision, {
          approval,
          tasks: state.tasks.filter((task) => approval.taskIds.includes(task.id)),
        });
      }
      case "get_workspace_runtime":
        return readSuccess(state.revision, {
          services: state.workspaceServices.filter(
            (service) => service.taskId === context.activeTask.id,
          ),
        });
      case "generic_api_request":
        return this.#genericApiRead(state.revision, context, input);
      default:
        return this.#applyMutation(operationId, runId, context, input);
    }
  }

  #genericApiRead(
    revision: number,
    context: CapabilityRunContext,
    input: Record<string, unknown>,
  ): OperationSuccess {
    if (input.method === "GET" && input.path === "/mock/state/revision") {
      return readSuccess(revision, { revision });
    }
    if (input.method === "GET" && input.path === "/mock/task") {
      return readSuccess(revision, { task: context.activeTask });
    }
    throw new SemanticDispatchFailure(
      "operation_unavailable",
      "The test-only generic request is outside the explicit mock allowlist.",
    );
  }

  async #applyMutation(
    operationId: CapabilitySemanticOperationId,
    runId: string,
    context: CapabilityRunContext,
    input: Record<string, unknown>,
  ): Promise<OperationSuccess> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    const taskId = context.activeTask.id;
    let command: CapabilitySemanticCommand;
    switch (operationId) {
      case "report_progress":
      case "answer_status_question":
        command = { kind: "report_progress", taskId, body: requiredString(input.body) };
        break;
      case "write_document":
        command = {
          kind: "write_document",
          taskId,
          key: requiredString(input.key),
          title: requiredString(input.title),
          body: requiredString(input.body),
          baseRevisionId: nullableString(input.baseRevisionId),
          changeSummary: nullableOptionalString(input.changeSummary),
        };
        break;
      case "request_human_input":
        command = {
          kind: "request_human_input",
          taskId,
          interactionKind: requiredString(input.interactionKind) as Extract<CapabilitySemanticCommand, { kind: "request_human_input" }>["interactionKind"],
          title: requiredString(input.title),
          prompt: requiredString(input.prompt),
          payload: optionalJson(input.payload),
          targetRevisionId: nullableOptionalString(input.targetRevisionId),
          continuationPolicy: requiredString(input.continuationPolicy) as Extract<CapabilitySemanticCommand, { kind: "request_human_input" }>["continuationPolicy"],
        };
        break;
      case "register_deliverable":
        command = {
          kind: "register_deliverable",
          taskId,
          filename: requiredString(input.filename),
          contentType: requiredString(input.contentType),
          byteSize: requiredNumber(input.byteSize),
          sha256: requiredString(input.sha256),
          contentRef: requiredString(input.contentRef),
          title: requiredString(input.title),
        };
        break;
      case "finish_task":
        command = { kind: "finish_task", taskId, summary: requiredString(input.summary) };
        break;
      case "block_task":
        command = { kind: "block_task", taskId, reason: requiredString(input.reason), blockedByTaskIds: optionalStringArray(input.blockedByTaskIds) };
        break;
      case "request_review":
        command = { kind: "request_review", taskId, summary: requiredString(input.summary) };
        break;
      case "set_dependencies":
        command = { kind: "set_dependencies", taskId, blockedByTaskIds: optionalStringArray(input.blockedByTaskIds) };
        break;
      case "create_task":
        command = {
          kind: "create_task",
          taskId,
          title: requiredString(input.title),
          description: nullableOptionalString(input.description),
          assigneeActorId: nullableOptionalString(input.assigneeActorId),
          priority: optionalString(input.priority) as Extract<CapabilitySemanticCommand, { kind: "create_task" }>["priority"],
          blockedByTaskIds: optionalStringArray(input.blockedByTaskIds),
        };
        break;
      case "request_approval":
        command = { kind: "request_approval", taskId, approvalType: requiredString(input.approvalType), payload: optionalJson(input.payload) };
        break;
      case "decide_approval":
        command = { kind: "decide_approval", taskId, approvalId: requiredString(input.approvalId), decision: requiredString(input.decision) as Extract<CapabilitySemanticCommand, { kind: "decide_approval" }>["decision"], note: requiredString(input.note) };
        break;
      case "comment_on_approval":
        command = { kind: "comment_on_approval", taskId, approvalId: requiredString(input.approvalId), body: requiredString(input.body) };
        break;
      case "control_workspace_service":
        command = { kind: "control_workspace_service", taskId, serviceId: requiredString(input.serviceId), action: requiredString(input.action) as Extract<CapabilitySemanticCommand, { kind: "control_workspace_service" }>["action"], url: nullableOptionalString(input.url) };
        break;
      case "schedule_wake":
        command = { kind: "schedule_wake", taskId, reason: requiredString(input.reason) as Extract<CapabilitySemanticCommand, { kind: "schedule_wake" }>["reason"], payload: optionalJson(input.payload), delayTicks: requiredNumber(input.delayTicks) };
        break;
      default:
        throw new SemanticDispatchFailure("operation_unavailable", "No mock operation is bound to this descriptor.");
    }
    const outcome = await this.port.tryApplyCommand({ runId, idempotencyKey, command });
    return commandOutcome(outcome);
  }

  #record(
    context: CapabilitySemanticPolicyContext,
    decision: CapabilitySemanticAuthorizationDecision,
    callId: string | null,
    input: unknown,
    result: unknown,
  ): void {
    this.#recordCounter += 1;
    this.#records.push(deepFreeze({
      schema: "paperclip.semantic-authorization-record.v1",
      id: `semantic-auth-${String(this.#recordCounter).padStart(6, "0")}`,
      runId: context.runId,
      scenarioId: context.scenario.id,
      actorId: context.actor.id,
      taskId: context.task.id,
      callId,
      ...decision,
      input: input === null ? null : redactSemanticValue(input),
      result: result === null ? null : redactSemanticValue(result),
    }));
  }

  #unknownToolDenial(call: CapabilitySemanticToolCall): CapabilitySemanticToolResult {
    return deepFreeze({
      ok: false,
      operationId: call.operationId,
      callId: call.callId,
      denial: {
        schema: "paperclip.semantic-denial.v1",
        code: "tool_not_exposed",
        message: "The requested semantic tool is not in the stable catalog.",
        retryable: false,
      },
      stateRevision: this.port.snapshot().revision,
    });
  }

  #denial(
    call: CapabilitySemanticToolCall,
    operationId: CapabilitySemanticOperationId,
    code: Exclude<CapabilitySemanticAuthorizationDecision["code"], "allowed">,
    message: string,
    retryable = false,
    controlPlaneCode?: string,
  ): CapabilitySemanticToolResult {
    return deepFreeze({
      ok: false,
      operationId,
      callId: call.callId,
      denial: {
        schema: "paperclip.semantic-denial.v1",
        code,
        ...(controlPlaneCode === undefined ? {} : { controlPlaneCode }),
        message: redactSemanticValue(message) as string,
        retryable,
      },
      stateRevision: this.port.snapshot().revision,
    });
  }
}

function commandOutcome(outcome: CapabilityCommandOutcome): OperationSuccess {
  if (!outcome.ok) {
    throw new SemanticDispatchFailure(
      "control_plane_denied",
      outcome.error.message,
      outcome.error.retryable,
      outcome.error.code,
    );
  }
  // `commandKind` is internal control-plane routing metadata. The provider
  // receives the operation-specific response contract, whose operationId is
  // already carried by the authenticated semantic result envelope.
  const { commandKind: _commandKind, ...result } = outcome.result;
  return { result: result as unknown as CapabilityJsonValue, stateRevision: outcome.result.stateRevision };
}

function toDefinition(descriptor: CapabilitySemanticToolDescriptor): CapabilitySemanticToolDefinition {
  return {
    name: descriptor.operationId,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: {
      semanticContract: descriptor.schema,
      operationId: descriptor.operationId,
      version: descriptor.version,
      exposure: descriptor.exposure,
      requiredClaims: descriptor.requiredClaims,
    },
  };
}

function deniedDecision(
  allowed: CapabilitySemanticAuthorizationDecision,
  code: CapabilitySemanticDenialCode,
  reason: string,
): CapabilitySemanticAuthorizationDecision {
  return { ...allowed, allowed: false, code, reason };
}

function denialCode(
  decision: CapabilitySemanticAuthorizationDecision,
): CapabilitySemanticDenialCode {
  if (decision.code === "allowed") {
    throw new Error("allowed authorization decision cannot create a denial");
  }
  return decision.code;
}

function normalizeFailure(error: unknown): SemanticDispatchFailure {
  return error instanceof SemanticDispatchFailure
    ? error
    : new SemanticDispatchFailure("operation_unavailable", "The semantic operation failed safely.");
}

function formatValidationError(validator: ValidateFunction | undefined): string {
  const issue = validator?.errors?.[0];
  if (issue === undefined) return "Semantic tool input does not match its stable schema.";
  return `Semantic tool input ${issue.instancePath || "/"} ${issue.message ?? "is invalid"}.`;
}

function activeDocument(
  documents: ReturnType<CapabilitySemanticControlPlane["snapshot"]>["documents"],
  context: CapabilityRunContext,
  key: string,
) {
  const document = documents.find(
    (candidate) => candidate.taskId === context.activeTask.id && candidate.key === key,
  );
  if (document === undefined) throw new SemanticDispatchFailure("operation_unavailable", "Document not found.");
  return document;
}

function approvalById(
  approvals: ReturnType<CapabilitySemanticControlPlane["snapshot"]>["approvals"],
  approvalId: string,
) {
  const approval = approvals.find((candidate) => candidate.id === approvalId);
  if (approval === undefined) throw new SemanticDispatchFailure("operation_unavailable", "Approval not found.");
  return approval;
}

function readSuccess(revision: number, value: unknown): OperationSuccess {
  return { result: redactSemanticValue(value), stateRevision: revision };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new SemanticDispatchFailure("input_invalid", "Expected string input.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

function nullableOptionalString(value: unknown): string | null | undefined {
  return value === undefined ? undefined : nullableString(value);
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") throw new SemanticDispatchFailure("input_invalid", "Expected number input.");
  return value;
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalJson(value: unknown): CapabilityJsonValue {
  return value === undefined ? {} : redactSemanticValue(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
