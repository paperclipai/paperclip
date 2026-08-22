import type {
  Phase7JsonSchema,
  Phase7SemanticOperationId,
  Phase7SemanticToolDescriptor,
} from "./types.js";

const ALL_MODES = ["standard", "ask", "planning", "skill_test"] as const;
const WORK_MODES = ["standard", "planning", "skill_test"] as const;
const STANDARD_MODE = ["standard"] as const;

const text = (description: string, maxLength = 20_000): Phase7JsonSchema => ({
  type: "string",
  description,
  minLength: 1,
  maxLength,
});
const nullableText = (description: string): Phase7JsonSchema => ({
  type: ["string", "null"],
  description,
  maxLength: 20_000,
});
const stringArray = (description: string): Phase7JsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
  maxItems: 200,
  uniqueItems: true,
});
const object = (
  properties: Readonly<Record<string, Phase7JsonSchema>> = {},
  required: readonly string[] = [],
): Phase7JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const jsonObject: Phase7JsonSchema = { type: "object", additionalProperties: true };
const operationResult = object({
  commandId: text("Stable mock command identifier.", 200),
  disposition: { enum: ["applied", "duplicate"] },
  stateRevision: { type: "integer", minimum: 0 },
  entityRefs: stringArray("Mock entities affected by the operation."),
  scheduledWakeIds: stringArray("Wake identifiers scheduled by the operation."),
}, ["commandId", "disposition", "stateRevision", "entityRefs", "scheduledWakeIds"]);
const readResult: Phase7JsonSchema = { type: "object", additionalProperties: true };

interface DescriptorInput {
  operationId: Phase7SemanticOperationId;
  title: string;
  description: string;
  exposure?: "always" | "optional";
  requiredClaims?: readonly string[];
  allowedModes?: Phase7SemanticToolDescriptor["allowedModes"];
  allowedRoles?: readonly string[];
  disabledByDefault?: boolean;
  inputSchema?: Phase7JsonSchema;
  outputSchema?: Phase7JsonSchema;
}

function descriptor(input: DescriptorInput): Phase7SemanticToolDescriptor {
  return {
    schema: "paperclip.semantic-tool.v1",
    operationId: input.operationId,
    version: 1,
    title: input.title,
    description: input.description,
    exposure: input.exposure ?? "always",
    requiredClaims: input.requiredClaims ?? [],
    allowedModes: input.allowedModes ?? ALL_MODES,
    ...(input.allowedRoles === undefined ? {} : { allowedRoles: input.allowedRoles }),
    ...(input.disabledByDefault === true ? { disabledByDefault: true } : {}),
    inputSchema: input.inputSchema ?? object(),
    outputSchema: input.outputSchema ?? readResult,
  };
}

const idempotency = { idempotencyKey: text("Caller-stable retry key.", 240) } as const;

const descriptors: readonly Phase7SemanticToolDescriptor[] = [
  descriptor({
    operationId: "get_task_context",
    title: "Get active task context",
    description: "Read the active mock task, actor, wake, ancestors, budget, and interaction results.",
  }),
  descriptor({
    operationId: "get_task_history",
    title: "Get active task history",
    description: "Read bounded comments on the active mock task.",
    inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }),
  }),
  descriptor({ operationId: "list_documents", title: "List task documents", description: "List revisioned documents on the active mock task." }),
  descriptor({
    operationId: "read_document",
    title: "Read task document",
    description: "Read the current revision of one active-task document.",
    inputSchema: object({ key: text("Stable issue-document key.", 120) }, ["key"]),
  }),
  descriptor({
    operationId: "list_document_revisions",
    title: "List document revisions",
    description: "Read bounded revision history for one active-task document.",
    inputSchema: object({ key: text("Stable issue-document key.", 120), limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, ["key"]),
  }),
  descriptor({
    operationId: "report_progress",
    title: "Report durable progress",
    description: "Append a durable progress comment to the active mock task.",
    inputSchema: object({ ...idempotency, body: text("Multiline progress update.") }, ["idempotencyKey", "body"]),
    outputSchema: operationResult,
  }),
  descriptor({
    operationId: "answer_status_question",
    title: "Answer status question",
    description: "Append the answer to a status-only wake without changing task disposition.",
    inputSchema: object({ ...idempotency, body: text("Concise status answer.") }, ["idempotencyKey", "body"]),
    outputSchema: operationResult,
  }),
  descriptor({
    operationId: "write_document",
    title: "Write revisioned document",
    description: "Create or update an active-task document with optimistic revision safety.",
    allowedModes: WORK_MODES,
    inputSchema: object({
      ...idempotency,
      key: text("Stable issue-document key.", 120),
      title: text("Document title.", 300),
      body: text("Markdown document body.", 200_000),
      baseRevisionId: nullableText("Current revision id, or null when creating."),
      changeSummary: nullableText("Optional revision summary."),
    }, ["idempotencyKey", "key", "title", "body", "baseRevisionId"]),
    outputSchema: operationResult,
  }),
  descriptor({
    operationId: "request_human_input",
    title: "Request structured human input",
    description: "Create a typed, durable interaction on the active mock task.",
    allowedModes: WORK_MODES,
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
  }),
  descriptor({
    operationId: "register_deliverable",
    title: "Register inspectable deliverable",
    description: "Register mock attachment metadata and its artifact work product without credentials or bytes in the tool result.",
    allowedModes: WORK_MODES,
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
  }),
  descriptor({ operationId: "finish_task", title: "Finish active task", description: "Finish the active mock task with a durable summary.", allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, summary: text("Completion summary.") }, ["idempotencyKey", "summary"]), outputSchema: operationResult }),
  descriptor({ operationId: "block_task", title: "Block active task", description: "Block the active mock task with a durable reason and optional first-class dependencies.", allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, reason: text("Block reason."), blockedByTaskIds: stringArray("Internal mock task ids that block this task.") }, ["idempotencyKey", "reason"]), outputSchema: operationResult }),
  descriptor({ operationId: "request_review", title: "Request task review", description: "Move the active mock task to review with a durable summary.", allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, summary: text("Review handoff summary.") }, ["idempotencyKey", "summary"]), outputSchema: operationResult }),

  descriptor({ operationId: "list_agents", title: "List company agents", description: "List redacted mock actor profiles.", exposure: "optional", requiredClaims: ["discovery:agents:read"] }),
  descriptor({ operationId: "get_agent", title: "Get company agent", description: "Read one redacted mock actor profile.", exposure: "optional", requiredClaims: ["discovery:agents:read"], inputSchema: object({ actorId: text("Mock actor id.", 200) }, ["actorId"]) }),
  descriptor({ operationId: "search_tasks", title: "Search company tasks", description: "Search mock tasks by text and status within the run company.", exposure: "optional", requiredClaims: ["discovery:tasks:read"], inputSchema: object({ query: { type: "string", maxLength: 500 }, statuses: { type: "array", items: { enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] }, maxItems: 7, uniqueItems: true }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 } }) }),
  descriptor({ operationId: "list_approvals", title: "List approvals", description: "List mock approvals in the run company.", exposure: "optional", requiredClaims: ["governance:approvals:read"] }),
  descriptor({ operationId: "get_approval", title: "Get approval", description: "Read one mock approval without protected data.", exposure: "optional", requiredClaims: ["governance:approvals:read"], inputSchema: object({ approvalId: text("Mock approval id.", 200) }, ["approvalId"]) }),
  descriptor({ operationId: "get_approval_context", title: "Get approval context", description: "Read one approval, its comments, and linked mock tasks.", exposure: "optional", requiredClaims: ["governance:approvals:read"], inputSchema: object({ approvalId: text("Mock approval id.", 200) }, ["approvalId"]) }),
  descriptor({ operationId: "get_workspace_runtime", title: "Get workspace runtime", description: "Read active-task mock workspace services.", exposure: "optional", requiredClaims: ["workspace:read"] }),
  descriptor({ operationId: "control_workspace_service", title: "Control workspace service", description: "Start, stop, or fault one active-task mock workspace service.", exposure: "optional", requiredClaims: ["workspace:control"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, serviceId: text("Mock workspace service id.", 200), action: { enum: ["start", "stop", "fail"] }, url: nullableText("Optional mock service URL.") }, ["idempotencyKey", "serviceId", "action"]), outputSchema: operationResult }),
  descriptor({ operationId: "set_dependencies", title: "Set task dependencies", description: "Replace the active task's first-class blocker set.", exposure: "optional", requiredClaims: ["dependencies:write"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, blockedByTaskIds: stringArray("Replacement blocker task ids.") }, ["idempotencyKey", "blockedByTaskIds"]), outputSchema: operationResult }),
  descriptor({ operationId: "create_task", title: "Create child task", description: "Create one child mock task under the active task.", exposure: "optional", requiredClaims: ["delegation:tasks:create"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, title: text("Child task title.", 500), description: nullableText("Child task description."), assigneeActorId: nullableText("Optional mock actor assignee."), priority: { enum: ["critical", "high", "medium", "low"] }, blockedByTaskIds: stringArray("Initial blocker task ids.") }, ["idempotencyKey", "title"]), outputSchema: operationResult }),
  descriptor({ operationId: "request_approval", title: "Request approval", description: "Create a governed mock approval and waiting posture.", exposure: "optional", requiredClaims: ["governance:approvals:request"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, approvalType: text("Stable approval type.", 200), payload: jsonObject }, ["idempotencyKey", "approvalType", "payload"]), outputSchema: operationResult }),
  descriptor({ operationId: "decide_approval", title: "Decide approval", description: "Decide a mock approval as an explicitly authorized approver.", exposure: "optional", requiredClaims: ["governance:approvals:decide"], allowedRoles: ["board", "approver", "security"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, approvalId: text("Mock approval id.", 200), decision: { enum: ["approved", "rejected", "cancelled"] }, note: text("Decision note.") }, ["idempotencyKey", "approvalId", "decision", "note"]), outputSchema: operationResult }),
  descriptor({ operationId: "comment_on_approval", title: "Comment on approval", description: "Add a durable comment to a mock approval.", exposure: "optional", requiredClaims: ["governance:approvals:comment"], inputSchema: object({ ...idempotency, approvalId: text("Mock approval id.", 200), body: text("Approval comment.") }, ["idempotencyKey", "approvalId", "body"]), outputSchema: operationResult }),
  descriptor({ operationId: "schedule_wake", title: "Schedule bounded wake", description: "Schedule a deterministic mock continuation wake.", exposure: "optional", requiredClaims: ["control_plane:wakes"], allowedModes: STANDARD_MODE, inputSchema: object({ ...idempotency, reason: { enum: ["manual", "issue_commented", "interaction_resolved", "approval_resolved", "blockers_resolved", "scheduled_retry", "resume"] }, payload: jsonObject, delayTicks: { type: "integer", minimum: 1, maximum: 10_000 } }, ["idempotencyKey", "reason", "delayTicks"]), outputSchema: operationResult }),
  descriptor({ operationId: "generic_api_request", title: "Generic API request", description: "Test-only escape hatch. Disabled unless the scenario and explicit claim both enable it.", exposure: "optional", requiredClaims: ["test:generic_api_request"], disabledByDefault: true, allowedModes: ["skill_test"], inputSchema: object({ method: { enum: ["GET", "POST", "PATCH"] }, path: { type: "string", pattern: "^/mock/", maxLength: 500 }, body: jsonObject }, ["method", "path"]) }),
];

const byId = new Map(descriptors.map((item) => [item.operationId, item]));
if (byId.size !== descriptors.length) throw new Error("duplicate Phase 7 semantic operation id");

export const PHASE7_SEMANTIC_TOOL_CATALOG = deepFreeze(descriptors);

export function phase7SemanticToolDescriptor(
  operationId: string,
): Phase7SemanticToolDescriptor | undefined {
  return byId.get(operationId as Phase7SemanticOperationId);
}

export function canonicalPhase7SemanticCatalog(): string {
  return canonicalJson(PHASE7_SEMANTIC_TOOL_CATALOG);
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
