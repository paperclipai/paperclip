import type {
  CapabilityCommandEnvelope,
  CapabilityJsonValue,
  CapabilityMockControlPlanePort,
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
}

export class CapabilitySemanticToolRuntime {
  readonly #adapter: CapabilityMockControlPlanePort;
  readonly #runId: string;
  readonly #scenarioGrants: string[];
  readonly #policy: CapabilityScenarioToolPolicy | undefined;
  readonly #resolveSecretValue: CapabilitySemanticToolRuntimeOptions["resolveSecretValue"];
  readonly #authorization = new CapabilityToolAuthorizationEngine();
  readonly #operationResults = new Map<string, CapabilityJsonValue>();
  #resultSequence = 0;

  constructor(options: CapabilitySemanticToolRuntimeOptions) {
    this.#adapter = options.adapter;
    this.#runId = options.runId;
    this.#scenarioGrants = [...new Set(options.scenarioGrants ?? [])].sort();
    this.#policy = options.policy === undefined ? undefined : structuredClone(options.policy);
    this.#resolveSecretValue = options.resolveSecretValue;
  }

  visibleTools(): CapabilityVisibleToolSet {
    return this.#authorization.computeVisibleTools(this.#context());
  }

  authorizationRecords(): readonly CapabilityAuthorizationRecord[] {
    return this.#authorization.records();
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
      const execution = await this.#execute(descriptor, invocation);
      const finalAuthorization = this.#authorization.attachStateChange(
        authorization.sequence,
        beforeRevision,
        this.#adapter.snapshot().revision,
        execution.entityRefs,
      );
      const resultId = execution.commandResult?.commandId ?? `tool-result-${++this.#resultSequence}`;
      const observableValue = redactForBoundary(descriptor, execution.value, "output");
      const observableCommandResult = execution.commandResult === null
        ? null
        : redactForBoundary(descriptor, toJsonValue(execution.commandResult), "output") as CapabilityToolSuccess["commandResult"];
      const success: CapabilityToolSuccess = {
        schema: "paperclip.capability.tool-result.v1",
        ok: true,
        operationId: invocation.operationId,
        operationResultId: resultId,
        value: observableValue,
        commandResult: observableCommandResult,
        authorization: finalAuthorization,
      };
      this.#operationResults.set(resultId, structuredClone(observableValue));
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
        const result = this.#operationResults.get(id);
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
  ): Promise<{ value: CapabilityJsonValue; commandResult: null; entityRefs: string[] }> {
    switch (descriptor.mockCommandMapping.kind === "mock_extension"
      ? descriptor.mockCommandMapping.extension
      : "") {
      case "discovery.projects":
      case "discovery.goals":
      case "cases.list":
      case "routines.list":
      case "company_skills.list":
        return { value: [], commandResult: null, entityRefs: [] };
      case "secrets.metadata":
        return { value: [], commandResult: null, entityRefs: [] };
      case "secrets.value": {
        const name = requireString(input.name);
        const value = await this.#resolveSecretValue?.(name);
        if (value === null || value === undefined) throw new Error("secret is not available");
        return { value: { name, value }, commandResult: null, entityRefs: [] };
      }
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
