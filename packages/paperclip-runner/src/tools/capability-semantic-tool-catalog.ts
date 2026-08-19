import {
  capabilityCanonicalOperationsForSurface,
  type CapabilityCanonicalOperation,
} from "../catalog/canonical-operations.js";
import type {
  CapabilityJsonSchema,
  CapabilityMockCommandMapping,
  CapabilityOptionalCatalogGroup,
  CapabilityRedactionRule,
  CapabilitySemanticToolDescriptor,
} from "./capability-semantic-tool-types.js";

// ---------------------------------------------------------------------------
// This catalog no longer declares an independent operation list. Placement,
// required claims, task modes, allowed roles, side-effect class, idempotency,
// and optional-group membership are single-sourced from
// `src/catalog/canonical-operations.ts` (PAP-17039). This module supplies only
// the scenario-surface *presentation*: title, description, input schema, the
// abstract mock-command mapping, and any redaction rules.
// ---------------------------------------------------------------------------

const RESULT_SCHEMA = objectSchema({
  schema: stringSchema({ enum: ["paperclip.capability.tool-result.v1"] }),
  ok: { type: "boolean" },
  operationId: stringSchema({ minLength: 1 }),
  operationResultId: stringSchema({ minLength: 1 }),
  value: {},
  commandResult: {},
  authorization: {},
}, ["schema", "ok", "operationId", "operationResultId", "value", "commandResult", "authorization"]);
const SECRET_REDACTION: CapabilityRedactionRule[] = [
  {
    path: "$.value",
    replacement: "[SECRET_VALUE]",
    appliesTo: ["output", "error", "authorization_record"],
  },
];
const AUTH_REDACTION: CapabilityRedactionRule[] = [
  {
    path: "$.headers.authorization",
    replacement: "[REDACTED]",
    appliesTo: ["input", "output", "error", "authorization_record"],
  },
  {
    path: "$.headers.cookie",
    replacement: "[REDACTED]",
    appliesTo: ["input", "output", "error", "authorization_record"],
  },
];

function stringSchema(options: Partial<CapabilityJsonSchema> = {}): CapabilityJsonSchema {
  return { type: "string", ...options };
}

function arraySchema(items: CapabilityJsonSchema): CapabilityJsonSchema {
  return { type: "array", items };
}

function objectSchema(
  properties: Record<string, CapabilityJsonSchema>,
  required: string[] = [],
): CapabilityJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Per-operation scenario presentation, keyed by canonical operation id. */
interface ScenarioPresentation {
  /** Bespoke title; optional tools default to a title derived from the id. */
  readonly title?: string;
  /** Bespoke description; optional tools default to a group-scoped sentence. */
  readonly description?: string;
  readonly inputSchema: CapabilityJsonSchema;
  readonly mockCommandMapping: CapabilityMockCommandMapping;
  readonly redaction?: CapabilityRedactionRule[];
}

const PRESENTATION: Readonly<Record<string, ScenarioPresentation>> = {
  // --- always tools (bespoke titles/descriptions) ---
  get_task_context: {
    title: "Get task context",
    description: "Read the active task, ancestors, wake context, linked results, and budget summary.",
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "context_read", projection: "active_task" },
  },
  get_task_history: {
    title: "Get task history",
    description: "Read comments and audit-visible history for the active task only.",
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1 } }),
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_history" },
  },
  list_documents: {
    title: "List task documents",
    description: "List document metadata attached to the active task.",
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_documents" },
  },
  read_document: {
    title: "Read task document",
    description: "Read one document on the active task by stable key.",
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1 }) }, ["key"]),
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_document" },
  },
  list_document_revisions: {
    title: "List document revisions",
    description: "Inspect revision history for one active-task document.",
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1 }) }, ["key"]),
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_document_revisions" },
  },
  report_progress: {
    title: "Report progress",
    description: "Append a durable progress update to the active task.",
    inputSchema: objectSchema({ body: stringSchema({ minLength: 1 }) }, ["body"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "report_progress" },
  },
  answer_status_question: {
    title: "Answer status question",
    description: "Post an answer to a status question without changing task state.",
    inputSchema: objectSchema({ body: stringSchema({ minLength: 1 }) }, ["body"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "report_progress" },
  },
  finish_task: {
    title: "Finish task",
    description: "Finish the active task with a durable completion summary.",
    inputSchema: objectSchema({ summary: stringSchema({ minLength: 1 }) }, ["summary"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "finish_task" },
  },
  block_task: {
    title: "Block task",
    description: "Block the active task with a reason and optional first-class dependencies.",
    inputSchema: objectSchema({
      reason: stringSchema({ minLength: 1 }),
      blockedByTaskIds: arraySchema(stringSchema({ minLength: 1 })),
    }, ["reason"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "block_task" },
  },
  request_review: {
    title: "Request task review",
    description: "Move the active task to review with a durable summary.",
    inputSchema: objectSchema({ summary: stringSchema({ minLength: 1 }) }, ["summary"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "request_review" },
  },
  write_document: {
    title: "Write task document",
    description: "Create or revision-safely update an active-task document.",
    inputSchema: objectSchema({
      key: stringSchema({ minLength: 1 }),
      title: stringSchema({ minLength: 1 }),
      body: stringSchema(),
      baseRevisionId: { oneOf: [stringSchema({ minLength: 1 }), { type: "null" }] },
      changeSummary: stringSchema(),
    }, ["key", "title", "body", "baseRevisionId"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "write_document" },
  },
  request_human_input: {
    title: "Request human input",
    description: "Create a typed confirmation, checkbox, question, task suggestion, or item-verdict request.",
    inputSchema: objectSchema({
      interactionKind: stringSchema({ enum: ["confirmation", "checkbox", "questions", "suggest_tasks", "item_verdicts"] }),
      title: stringSchema({ minLength: 1 }),
      prompt: stringSchema({ minLength: 1 }),
      payload: {},
      targetRevisionId: { oneOf: [stringSchema({ minLength: 1 }), { type: "null" }] },
      continuationPolicy: stringSchema({ enum: ["none", "wake_assignee", "wake_assignee_on_accept"] }),
    }, ["interactionKind", "title", "prompt", "continuationPolicy"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "request_human_input" },
  },
  register_deliverable: {
    title: "Register deliverable",
    description: "Register an inspectable artifact and its work product on the active task.",
    inputSchema: objectSchema({
      filename: stringSchema({ minLength: 1 }),
      contentType: stringSchema({ minLength: 1 }),
      byteSize: { type: "integer", minimum: 0 },
      sha256: stringSchema({ minLength: 1 }),
      contentRef: stringSchema({ minLength: 1 }),
      title: stringSchema({ minLength: 1 }),
    }, ["filename", "contentType", "byteSize", "sha256", "contentRef", "title"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "register_deliverable" },
  },
  inspect_operation_result: {
    title: "Inspect operation result",
    description: "Read a prior semantic operation result from this run.",
    inputSchema: objectSchema({ operationResultId: stringSchema({ minLength: 1 }) }, ["operationResultId"]),
    mockCommandMapping: { kind: "operation_result" },
  },

  // --- optional tools (title/description derived from id + group) ---
  search_tasks: {
    inputSchema: objectSchema({ query: stringSchema(), status: stringSchema() }),
    mockCommandMapping: { kind: "snapshot_read", projection: "company_tasks" },
  },
  list_agents: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "snapshot_read", projection: "company_actors" },
  },
  list_projects: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "discovery.projects" },
  },
  list_goals: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "discovery.goals" },
  },
  create_task: {
    inputSchema: objectSchema({
      title: stringSchema({ minLength: 1 }),
      description: stringSchema(),
      assigneeActorId: stringSchema(),
      priority: stringSchema(),
      blockedByTaskIds: arraySchema(stringSchema()),
    }, ["title"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "create_task" },
  },
  set_dependencies: {
    inputSchema: objectSchema({ blockedByTaskIds: arraySchema(stringSchema({ minLength: 1 })) }, ["blockedByTaskIds"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "set_dependencies" },
  },
  list_approvals: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "snapshot_read", projection: "company_approvals" },
  },
  request_approval: {
    inputSchema: objectSchema({ approvalType: stringSchema({ minLength: 1 }), payload: {} }, ["approvalType", "payload"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "request_approval" },
  },
  decide_approval: {
    inputSchema: objectSchema({
      approvalId: stringSchema({ minLength: 1 }),
      decision: stringSchema({ enum: ["approved", "rejected", "cancelled"] }),
      note: stringSchema({ minLength: 1 }),
    }, ["approvalId", "decision", "note"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "decide_approval" },
  },
  comment_on_approval: {
    inputSchema: objectSchema({ approvalId: stringSchema({ minLength: 1 }), body: stringSchema({ minLength: 1 }) }, ["approvalId", "body"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "comment_on_approval" },
  },
  list_cases: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "cases.list" },
  },
  upsert_case: {
    inputSchema: objectSchema({ key: stringSchema({ minLength: 1 }), body: stringSchema() }, ["key", "body"]),
    mockCommandMapping: { kind: "mock_extension", extension: "cases.upsert" },
  },
  get_workspace_runtime: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "snapshot_read", projection: "active_task_workspace" },
  },
  control_workspace_service: {
    inputSchema: objectSchema({
      serviceId: stringSchema({ minLength: 1 }),
      action: stringSchema({ enum: ["start", "stop", "fail"] }),
      url: stringSchema(),
    }, ["serviceId", "action"]),
    mockCommandMapping: { kind: "semantic_command", commandKind: "control_workspace_service" },
  },
  list_routines: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "routines.list" },
  },
  manage_routine: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "routines.manage" },
  },
  list_company_skills: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "company_skills.list" },
  },
  sync_company_skills: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "company_skills.sync" },
  },
  list_secret_metadata: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "secrets.metadata" },
  },
  read_secret_value: {
    inputSchema: objectSchema({ name: stringSchema({ minLength: 1 }) }, ["name"]),
    mockCommandMapping: { kind: "mock_extension", extension: "secrets.value" },
    redaction: [...SECRET_REDACTION],
  },
  export_company: {
    inputSchema: objectSchema({}),
    mockCommandMapping: { kind: "mock_extension", extension: "portability.export" },
  },
  administer_company: {
    inputSchema: objectSchema({ action: stringSchema({ minLength: 1 }), payload: {} }, ["action"]),
    mockCommandMapping: { kind: "mock_extension", extension: "company.admin" },
  },
  generic_api_request: {
    inputSchema: objectSchema({
      method: stringSchema({ minLength: 1 }),
      path: stringSchema({ minLength: 1 }),
      headers: { type: "object", additionalProperties: stringSchema() },
      body: {},
    }, ["method", "path"]),
    mockCommandMapping: { kind: "mock_extension", extension: "test.generic_api" },
    redaction: [...AUTH_REDACTION],
  },
};

function titleFor(operationId: string): string {
  return operationId.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function descriptionFor(title: string, group: CapabilityOptionalCatalogGroup): string {
  return `${title} through the Capability ${group.replaceAll("_", " ")} capability set.`;
}

function toDescriptor(operation: CapabilityCanonicalOperation): CapabilitySemanticToolDescriptor {
  const presentation = PRESENTATION[operation.operationId];
  if (presentation === undefined) {
    throw new Error(`Missing scenario presentation for operation ${operation.operationId}.`);
  }
  const title = presentation.title ?? titleFor(operation.operationId);
  const description = presentation.description
    ?? descriptionFor(title, operation.optionalGroup ?? "discovery");
  return Object.freeze({
    operationId: operation.operationId,
    version: 1,
    title,
    description,
    inputSchema: presentation.inputSchema,
    outputSchema: RESULT_SCHEMA,
    disposition: operation.placement,
    optionalGroup: operation.optionalGroup,
    requiredClaims: [...operation.requiredClaims],
    ...(operation.allowedRoles === undefined ? {} : { allowedRoles: [...operation.allowedRoles] }),
    taskModes: [...operation.taskModes],
    sideEffectClass: operation.sideEffectClass,
    idempotency: operation.idempotency,
    redaction: presentation.redaction ?? [],
    mockCommandMapping: presentation.mockCommandMapping,
  });
}

const SCENARIO_OPERATIONS = capabilityCanonicalOperationsForSurface("scenario");
const canonicalById = new Map(SCENARIO_OPERATIONS.map((operation) => [operation.operationId, operation]));

// Bidirectional parity: every presented operation is a canonical scenario-surface
// operation, and every canonical scenario-surface operation has a presentation.
for (const key of Object.keys(PRESENTATION)) {
  if (!canonicalById.has(key)) {
    throw new Error(`Scenario presentation ${key} is not a canonical scenario-surface operation.`);
  }
}
for (const operation of SCENARIO_OPERATIONS) {
  if (PRESENTATION[operation.operationId] === undefined) {
    throw new Error(`Canonical scenario operation ${operation.operationId} has no scenario presentation.`);
  }
}

// Declaration order follows the presentation map so the exported surface stays
// stable; the operation set itself is single-sourced from the canonical list.
export const CAPABILITY_SEMANTIC_TOOL_CATALOG: readonly CapabilitySemanticToolDescriptor[] = Object.freeze(
  Object.keys(PRESENTATION).map((operationId) => toDescriptor(canonicalById.get(operationId)!)),
);

export const CAPABILITY_OPTIONAL_TOOL_CATALOGS: Readonly<
  Record<CapabilityOptionalCatalogGroup, readonly CapabilitySemanticToolDescriptor[]>
> = Object.freeze({
  discovery: toolsInGroup("discovery"),
  delegation_dependencies: toolsInGroup("delegation_dependencies"),
  governance: toolsInGroup("governance"),
  cases: toolsInGroup("cases"),
  workspace_runtime: toolsInGroup("workspace_runtime"),
  routines: toolsInGroup("routines"),
  company_skills: toolsInGroup("company_skills"),
  secrets: toolsInGroup("secrets"),
  portability_admin: toolsInGroup("portability_admin"),
  test_escape_hatch: toolsInGroup("test_escape_hatch"),
});

export function capabilitySemanticTool(operationId: string): CapabilitySemanticToolDescriptor | undefined {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.find((tool) => tool.operationId === operationId);
}

function toolsInGroup(group: CapabilityOptionalCatalogGroup): readonly CapabilitySemanticToolDescriptor[] {
  return Object.freeze(
    CAPABILITY_SEMANTIC_TOOL_CATALOG.filter((tool) => tool.optionalGroup === group),
  );
}
