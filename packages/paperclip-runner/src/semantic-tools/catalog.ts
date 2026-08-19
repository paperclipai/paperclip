import {
  capabilityCanonicalOperationsForSurface,
  type CapabilityCanonicalOperation,
} from "../catalog/canonical-operations.js";
import type {
  CapabilityJsonSchema,
  CapabilitySemanticOperationId,
  CapabilitySemanticToolDescriptor,
} from "./types.js";

// ---------------------------------------------------------------------------
// This catalog no longer declares an independent operation list, exposure, or
// claim/mode policy. Exposure (`always`/`optional`), required claims, allowed
// task modes, allowed roles, and the disabled-by-default flag are single-sourced
// from `src/catalog/canonical-operations.ts` (PAP-17039). This module supplies
// only the live provider *presentation*: title, description, and the in-band
// provider input/output schemas the model sees.
// ---------------------------------------------------------------------------

const text = (description: string, maxLength = 20_000): CapabilityJsonSchema => ({
  type: "string",
  description,
  minLength: 1,
  maxLength,
});
const nullableText = (description: string): CapabilityJsonSchema => ({
  type: ["string", "null"],
  description,
  maxLength: 20_000,
});
const stringArray = (description: string): CapabilityJsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
  maxItems: 200,
  uniqueItems: true,
});
const object = (
  properties: Readonly<Record<string, CapabilityJsonSchema>> = {},
  required: readonly string[] = [],
): CapabilityJsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const jsonObject: CapabilityJsonSchema = { type: "object", additionalProperties: true };
const operationResult = object({
  commandId: text("Stable mock command identifier.", 200),
  disposition: { enum: ["applied", "duplicate"] },
  stateRevision: { type: "integer", minimum: 0 },
  entityRefs: stringArray("Mock entities affected by the operation."),
  scheduledWakeIds: stringArray("Wake identifiers scheduled by the operation."),
}, ["commandId", "disposition", "stateRevision", "entityRefs", "scheduledWakeIds"]);
const readResult: CapabilityJsonSchema = { type: "object", additionalProperties: true };

const idempotency = { idempotencyKey: text("Caller-stable retry key.", 240) } as const;

/** Per-operation live provider presentation, in golden declaration order. */
interface LivePresentation {
  readonly operationId: CapabilitySemanticOperationId;
  readonly title: string;
  readonly description: string;
  readonly inputSchema?: CapabilityJsonSchema;
  readonly outputSchema?: CapabilityJsonSchema;
}

const PRESENTATION: readonly LivePresentation[] = [
  { operationId: "get_task_context", title: "Get active task context", description: "Read the active mock task, actor, wake, ancestors, budget, and interaction results." },
  { operationId: "get_task_history", title: "Get active task history", description: "Read bounded comments on the active mock task.", inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }) },
  { operationId: "list_documents", title: "List task documents", description: "List revisioned documents on the active mock task." },
  { operationId: "read_document", title: "Read task document", description: "Read the current revision of one active-task document.", inputSchema: object({ key: text("Stable issue-document key.", 120) }, ["key"]) },
  { operationId: "list_document_revisions", title: "List document revisions", description: "Read bounded revision history for one active-task document.", inputSchema: object({ key: text("Stable issue-document key.", 120), limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, ["key"]) },
  { operationId: "report_progress", title: "Report durable progress", description: "Append a durable progress comment to the active mock task.", inputSchema: object({ ...idempotency, body: text("Multiline progress update.") }, ["idempotencyKey", "body"]), outputSchema: operationResult },
  { operationId: "answer_status_question", title: "Answer status question", description: "Append the answer to a status-only wake without changing task disposition.", inputSchema: object({ ...idempotency, body: text("Concise status answer.") }, ["idempotencyKey", "body"]), outputSchema: operationResult },
  {
    operationId: "write_document", title: "Write revisioned document", description: "Create or update an active-task document with optimistic revision safety.",
    inputSchema: object({
      ...idempotency,
      key: text("Stable issue-document key.", 120),
      title: text("Document title.", 300),
      body: text("Markdown document body.", 200_000),
      baseRevisionId: nullableText("Current revision id, or null when creating."),
      changeSummary: nullableText("Optional revision summary."),
    }, ["idempotencyKey", "key", "title", "body", "baseRevisionId"]),
    outputSchema: operationResult,
  },
  {
    operationId: "request_human_input", title: "Request structured human input", description: "Create a typed, durable interaction on the active mock task.",
    inputSchema: object({
      ...idempotency,
      interactionKind: { enum: ["confirmation", "checkbox", "questions", "suggest_tasks", "item_verdicts"] },
      title: text("Interaction card title.", 300),
      prompt: text("Question or decision prompt.", 10_000),
      payload: jsonObject,
      targetRevisionId: nullableText("Optional bound document revision."),
      continuationPolicy: { enum: ["none", "wake_assignee", "wake_assignee_on_accept"] },
    }, ["idempotencyKey", "interactionKind", "title", "prompt", "continuationPolicy"]),
    outputSchema: operationResult,
  },
  {
    operationId: "register_deliverable", title: "Register inspectable deliverable", description: "Register mock attachment metadata and its artifact work product without credentials or bytes in the tool result.",
    inputSchema: object({
      ...idempotency,
      filename: text("Display filename.", 500),
      contentType: text("Media type.", 200),
      byteSize: { type: "integer", minimum: 0, maximum: 100_000_000 },
      sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      contentRef: text("Opaque package-local content reference.", 2_000),
      title: text("Work-product title.", 500),
    }, ["idempotencyKey", "filename", "contentType", "byteSize", "sha256", "contentRef", "title"]),
    outputSchema: operationResult,
  },
  { operationId: "finish_task", title: "Finish active task", description: "Finish the active mock task with a durable summary.", inputSchema: object({ ...idempotency, summary: text("Completion summary.") }, ["idempotencyKey", "summary"]), outputSchema: operationResult },
  { operationId: "block_task", title: "Block active task", description: "Block the active mock task with a durable reason and optional first-class dependencies.", inputSchema: object({ ...idempotency, reason: text("Block reason."), blockedByTaskIds: stringArray("Internal mock task ids that block this task.") }, ["idempotencyKey", "reason"]), outputSchema: operationResult },
  { operationId: "request_review", title: "Request task review", description: "Move the active mock task to review with a durable summary.", inputSchema: object({ ...idempotency, summary: text("Review handoff summary.") }, ["idempotencyKey", "summary"]), outputSchema: operationResult },
  { operationId: "list_agents", title: "List company agents", description: "List redacted mock actor profiles." },
  { operationId: "get_agent", title: "Get company agent", description: "Read one redacted mock actor profile.", inputSchema: object({ actorId: text("Mock actor id.", 200) }, ["actorId"]) },
  { operationId: "search_tasks", title: "Search company tasks", description: "Search mock tasks by text and status within the run company.", inputSchema: object({ query: { type: "string", maxLength: 500 }, statuses: { type: "array", items: { enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] }, maxItems: 7, uniqueItems: true }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }) },
  { operationId: "list_approvals", title: "List approvals", description: "List mock approvals in the run company." },
  { operationId: "get_approval", title: "Get approval", description: "Read one mock approval without protected data.", inputSchema: object({ approvalId: text("Mock approval id.", 200) }, ["approvalId"]) },
  { operationId: "get_approval_context", title: "Get approval context", description: "Read one approval, its comments, and linked mock tasks.", inputSchema: object({ approvalId: text("Mock approval id.", 200) }, ["approvalId"]) },
  { operationId: "get_workspace_runtime", title: "Get workspace runtime", description: "Read active-task mock workspace services." },
  { operationId: "control_workspace_service", title: "Control workspace service", description: "Start, stop, or fault one active-task mock workspace service.", inputSchema: object({ ...idempotency, serviceId: text("Mock workspace service id.", 200), action: { enum: ["start", "stop", "fail"] }, url: nullableText("Optional mock service URL.") }, ["idempotencyKey", "serviceId", "action"]), outputSchema: operationResult },
  { operationId: "set_dependencies", title: "Set task dependencies", description: "Replace the active task's first-class blocker set.", inputSchema: object({ ...idempotency, blockedByTaskIds: stringArray("Replacement blocker task ids.") }, ["idempotencyKey", "blockedByTaskIds"]), outputSchema: operationResult },
  { operationId: "create_task", title: "Create child task", description: "Create one child mock task under the active task.", inputSchema: object({ ...idempotency, title: text("Child task title.", 500), description: nullableText("Child task description."), assigneeActorId: nullableText("Optional mock actor assignee."), priority: { enum: ["critical", "high", "medium", "low"] }, blockedByTaskIds: stringArray("Initial blocker task ids.") }, ["idempotencyKey", "title"]), outputSchema: operationResult },
  { operationId: "request_approval", title: "Request approval", description: "Create a governed mock approval and waiting posture.", inputSchema: object({ ...idempotency, approvalType: text("Stable approval type.", 200), payload: jsonObject }, ["idempotencyKey", "approvalType", "payload"]), outputSchema: operationResult },
  { operationId: "decide_approval", title: "Decide approval", description: "Decide a mock approval as an explicitly authorized approver.", inputSchema: object({ ...idempotency, approvalId: text("Mock approval id.", 200), decision: { enum: ["approved", "rejected", "cancelled"] }, note: text("Decision note.") }, ["idempotencyKey", "approvalId", "decision", "note"]), outputSchema: operationResult },
  { operationId: "comment_on_approval", title: "Comment on approval", description: "Add a durable comment to a mock approval.", inputSchema: object({ ...idempotency, approvalId: text("Mock approval id.", 200), body: text("Approval comment.") }, ["idempotencyKey", "approvalId", "body"]), outputSchema: operationResult },
  { operationId: "schedule_wake", title: "Schedule bounded wake", description: "Schedule a deterministic mock continuation wake.", inputSchema: object({ ...idempotency, reason: { enum: ["manual", "issue_commented", "interaction_resolved", "approval_resolved", "blockers_resolved", "scheduled_retry", "resume"] }, payload: jsonObject, delayTicks: { type: "integer", minimum: 1, maximum: 10_000 } }, ["idempotencyKey", "reason", "delayTicks"]), outputSchema: operationResult },
  { operationId: "generic_api_request", title: "Generic API request", description: "Test-only escape hatch. Disabled unless the scenario and explicit claim both enable it.", inputSchema: object({ method: { enum: ["GET", "POST", "PATCH"] }, path: { type: "string", pattern: "^/mock/", maxLength: 500 }, body: jsonObject }, ["method", "path"]) },
];

const canonicalById = new Map(
  capabilityCanonicalOperationsForSurface("live").map((operation) => [operation.operationId, operation]),
);

function toDescriptor(
  presentation: LivePresentation,
  operation: CapabilityCanonicalOperation,
): CapabilitySemanticToolDescriptor {
  return {
    schema: "paperclip.semantic-tool.v1",
    operationId: presentation.operationId,
    version: 1,
    title: presentation.title,
    description: presentation.description,
    exposure: operation.placement === "always_agent_tool" ? "always" : "optional",
    requiredClaims: [...operation.requiredClaims],
    allowedModes: [...operation.taskModes] as CapabilitySemanticToolDescriptor["allowedModes"],
    ...(operation.allowedRoles === undefined ? {} : { allowedRoles: [...operation.allowedRoles] }),
    ...(operation.disabledByDefault ? { disabledByDefault: true } : {}),
    inputSchema: presentation.inputSchema ?? object(),
    outputSchema: presentation.outputSchema ?? readResult,
  };
}

// Bidirectional parity: presentation set === canonical live-surface set.
const presentedIds = new Set(PRESENTATION.map((entry) => entry.operationId));
if (presentedIds.size !== PRESENTATION.length) throw new Error("duplicate Capability semantic operation id");
for (const entry of PRESENTATION) {
  if (!canonicalById.has(entry.operationId)) {
    throw new Error(`Live presentation ${entry.operationId} is not a canonical live-surface operation.`);
  }
}
for (const operationId of canonicalById.keys()) {
  if (!presentedIds.has(operationId as CapabilitySemanticOperationId)) {
    throw new Error(`Canonical live operation ${operationId} has no live presentation.`);
  }
}

const descriptors: readonly CapabilitySemanticToolDescriptor[] = PRESENTATION.map((presentation) =>
  toDescriptor(presentation, canonicalById.get(presentation.operationId)!),
);

const byId = new Map(descriptors.map((item) => [item.operationId, item]));

export const CAPABILITY_SEMANTIC_TOOL_CATALOG = deepFreeze(descriptors);

export function capabilitySemanticToolDescriptor(
  operationId: string,
): CapabilitySemanticToolDescriptor | undefined {
  return byId.get(operationId as CapabilitySemanticOperationId);
}

export function canonicalCapabilitySemanticCatalog(): string {
  return canonicalJson(CAPABILITY_SEMANTIC_TOOL_CATALOG);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
