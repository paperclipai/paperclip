import type {
  PaperclipJsonSchema,
  PaperclipSemanticActionDescriptor,
  PaperclipSemanticActionId,
  PaperclipSemanticActionMode,
} from "./semantic-action-types.js";

const ALL_MODES = ["standard", "ask", "planning", "skill_test"] as const;
const WORK_MODES = ["standard", "planning", "skill_test"] as const;
const STANDARD_MODE = ["standard", "skill_test"] as const;

const text = (
  description: string,
  maxLength = 20_000,
): PaperclipJsonSchema => ({
  type: "string",
  description,
  minLength: 1,
  maxLength,
});

const nullableText = (
  description: string,
  maxLength = 20_000,
): PaperclipJsonSchema => ({
  type: ["string", "null"],
  description,
  maxLength,
});

const stringArray = (description: string): PaperclipJsonSchema => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
  maxItems: 200,
  uniqueItems: true,
});

const object = (
  properties: Readonly<Record<string, PaperclipJsonSchema>> = {},
  required: readonly string[] = [],
): PaperclipJsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const openObject: PaperclipJsonSchema = {
  type: "object",
  additionalProperties: true,
};
const idempotency = {
  idempotencyKey: text("Caller-stable retry key.", 240),
} as const;
const operationReceipt = object(
  {
    commandId: text("Stable command identifier.", 200),
    disposition: { enum: ["applied", "duplicate"] },
    stateRevision: { type: "integer", minimum: 0 },
    entityRefs: stringArray("Entities affected by the operation."),
    scheduledWakeIds: stringArray(
      "Wake identifiers scheduled by the operation.",
    ),
  },
  [
    "commandId",
    "disposition",
    "stateRevision",
    "entityRefs",
    "scheduledWakeIds",
  ],
);

interface DescriptorInput {
  readonly operationId: PaperclipSemanticActionId;
  readonly title: string;
  readonly description: string;
  readonly placement?: "always" | "optional";
  readonly effect?: "read" | "write" | "governance";
  readonly requiredClaims?: readonly string[];
  readonly allowedModes?: readonly PaperclipSemanticActionMode[];
  readonly allowedRoles?: readonly string[];
  readonly inputSchema?: PaperclipJsonSchema;
  readonly outputSchema?: PaperclipJsonSchema;
}

function descriptor(input: DescriptorInput): PaperclipSemanticActionDescriptor {
  return {
    schema: "paperclip.semantic-action.v1",
    operationId: input.operationId,
    version: 1,
    title: input.title,
    description: input.description,
    placement: input.placement ?? "always",
    effect: input.effect ?? "read",
    requiredClaims: input.requiredClaims ?? [],
    allowedModes: input.allowedModes ?? ALL_MODES,
    ...(input.allowedRoles === undefined
      ? {}
      : { allowedRoles: input.allowedRoles }),
    inputSchema: input.inputSchema ?? object(),
    outputSchema: input.outputSchema ?? openObject,
  };
}

const descriptors: readonly PaperclipSemanticActionDescriptor[] = [
  descriptor({
    operationId: "get_task_context",
    title: "Get active task context",
    description:
      "Read the active task, actor, wake context, ancestors, and budget summary.",
  }),
  descriptor({
    operationId: "get_task_history",
    title: "Get active task history",
    description: "Read bounded comments on the active task.",
    inputSchema: object({
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    }),
  }),
  descriptor({
    operationId: "list_documents",
    title: "List task documents",
    description: "List revisioned documents on the active task.",
  }),
  descriptor({
    operationId: "read_document",
    title: "Read task document",
    description: "Read the current revision of one active-task document.",
    inputSchema: object({ key: text("Stable issue-document key.", 120) }, [
      "key",
    ]),
  }),
  descriptor({
    operationId: "list_document_revisions",
    title: "List document revisions",
    description: "Read bounded revision history for one active-task document.",
    inputSchema: object(
      {
        key: text("Stable issue-document key.", 120),
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      ["key"],
    ),
  }),
  descriptor({
    operationId: "report_progress",
    title: "Report durable progress",
    description: "Append a durable progress comment to the active task.",
    effect: "write",
    inputSchema: object(
      { ...idempotency, body: text("Multiline progress update.") },
      ["idempotencyKey", "body"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "answer_status_question",
    title: "Answer status question",
    description:
      "Append an answer to a status-only wake without changing task disposition.",
    effect: "write",
    inputSchema: object(
      { ...idempotency, body: text("Concise status answer.") },
      ["idempotencyKey", "body"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "write_document",
    title: "Write revisioned document",
    description:
      "Create or update an active-task document with optimistic revision safety.",
    effect: "write",
    allowedModes: WORK_MODES,
    inputSchema: object(
      {
        ...idempotency,
        key: text("Stable issue-document key.", 120),
        title: text("Document title.", 300),
        body: text("Markdown document body.", 200_000),
        baseRevisionId: nullableText(
          "Current revision id, or null when creating.",
          240,
        ),
        changeSummary: nullableText("Optional revision summary."),
      },
      ["idempotencyKey", "key", "title", "body", "baseRevisionId"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "request_human_input",
    title: "Request structured human input",
    description: "Create a typed, durable interaction on the active task.",
    effect: "write",
    allowedModes: ALL_MODES,
    inputSchema: object(
      {
        ...idempotency,
        interactionKind: {
          enum: [
            "confirmation",
            "checkbox",
            "questions",
            "suggest_tasks",
            "item_verdicts",
          ],
        },
        title: text("Interaction card title.", 300),
        prompt: text("Question or decision prompt.", 10_000),
        payload: openObject,
        targetRevisionId: nullableText(
          "Optional bound document revision.",
          240,
        ),
        continuationPolicy: {
          enum: ["none", "wake_assignee", "wake_assignee_on_accept"],
        },
      },
      [
        "idempotencyKey",
        "interactionKind",
        "title",
        "prompt",
        "continuationPolicy",
      ],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "register_deliverable",
    title: "Register inspectable deliverable",
    description:
      "Register attachment metadata and its work product without returning bytes or credentials.",
    effect: "write",
    allowedModes: WORK_MODES,
    inputSchema: object(
      {
        ...idempotency,
        filename: text("Display filename.", 500),
        contentType: text("Media type.", 200),
        byteSize: { type: "integer", minimum: 0, maximum: 100_000_000 },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        contentRef: text("Opaque content reference.", 2_000),
        title: text("Work-product title.", 500),
      },
      [
        "idempotencyKey",
        "filename",
        "contentType",
        "byteSize",
        "sha256",
        "contentRef",
        "title",
      ],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "finish_task",
    title: "Finish active task",
    description: "Finish the active task with a durable summary.",
    effect: "write",
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      { ...idempotency, summary: text("Completion summary.") },
      ["idempotencyKey", "summary"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "block_task",
    title: "Block active task",
    description:
      "Block the active task with a durable reason and optional first-class dependencies.",
    effect: "write",
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        reason: text("Block reason."),
        blockedByTaskIds: stringArray("Task identifiers that block this task."),
      },
      ["idempotencyKey", "reason"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "request_review",
    title: "Request task review",
    description: "Move the active task to review with a durable summary.",
    effect: "write",
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      { ...idempotency, summary: text("Review handoff summary.") },
      ["idempotencyKey", "summary"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "list_agents",
    title: "List company agents",
    description: "List redacted actor profiles in the run company.",
    placement: "optional",
    requiredClaims: ["discovery:agents:read"],
  }),
  descriptor({
    operationId: "get_agent",
    title: "Get company agent",
    description: "Read one redacted actor profile in the run company.",
    placement: "optional",
    requiredClaims: ["discovery:agents:read"],
    inputSchema: object({ actorId: text("Actor identifier.", 200) }, [
      "actorId",
    ]),
  }),
  descriptor({
    operationId: "search_tasks",
    title: "Search company tasks",
    description: "Search tasks by text and status within the run company.",
    placement: "optional",
    requiredClaims: ["discovery:tasks:read"],
    inputSchema: object({
      query: { type: "string", maxLength: 500 },
      statuses: {
        type: "array",
        items: {
          enum: [
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "done",
            "blocked",
            "cancelled",
          ],
        },
        maxItems: 7,
        uniqueItems: true,
      },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    }),
  }),
  descriptor({
    operationId: "list_approvals",
    title: "List approvals",
    description: "List approvals in the run company.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:read"],
  }),
  descriptor({
    operationId: "get_approval",
    title: "Get approval",
    description: "Read one approval without protected data.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:read"],
    inputSchema: object({ approvalId: text("Approval identifier.", 200) }, [
      "approvalId",
    ]),
  }),
  descriptor({
    operationId: "get_approval_context",
    title: "Get approval context",
    description: "Read one approval, its comments, and linked tasks.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:read"],
    inputSchema: object({ approvalId: text("Approval identifier.", 200) }, [
      "approvalId",
    ]),
  }),
  descriptor({
    operationId: "get_workspace_runtime",
    title: "Get workspace runtime",
    description: "Read active-task workspace services.",
    placement: "optional",
    requiredClaims: ["workspace:read"],
  }),
  descriptor({
    operationId: "control_workspace_service",
    title: "Control workspace service",
    description: "Start or stop one active-task workspace service.",
    placement: "optional",
    effect: "write",
    requiredClaims: ["workspace:control"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        serviceId: text("Workspace service identifier.", 200),
        action: { enum: ["start", "stop"] },
      },
      ["idempotencyKey", "serviceId", "action"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "set_dependencies",
    title: "Set task dependencies",
    description: "Replace the active task's first-class blocker set.",
    placement: "optional",
    effect: "write",
    requiredClaims: ["dependencies:write"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        blockedByTaskIds: stringArray("Replacement blocker task identifiers."),
      },
      ["idempotencyKey", "blockedByTaskIds"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "create_task",
    title: "Create child task",
    description: "Create one child task under the active task.",
    placement: "optional",
    effect: "write",
    requiredClaims: ["delegation:tasks:create"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        title: text("Child task title.", 500),
        description: nullableText("Child task description."),
        assigneeActorId: nullableText("Optional actor assignee.", 200),
        priority: { enum: ["critical", "high", "medium", "low"] },
        blockedByTaskIds: stringArray("Initial blocker task identifiers."),
      },
      ["idempotencyKey", "title"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "request_approval",
    title: "Request approval",
    description: "Create a governed approval and waiting posture.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:request"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        approvalType: text("Stable approval type.", 200),
        payload: openObject,
      },
      ["idempotencyKey", "approvalType", "payload"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "decide_approval",
    title: "Decide approval",
    description: "Decide an approval as an explicitly authorized approver.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:decide"],
    allowedRoles: ["board", "approver", "security"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        approvalId: text("Approval identifier.", 200),
        decision: { enum: ["approved", "rejected", "cancelled"] },
        note: text("Decision note."),
      },
      ["idempotencyKey", "approvalId", "decision", "note"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "comment_on_approval",
    title: "Comment on approval",
    description: "Add a durable comment to an approval.",
    placement: "optional",
    effect: "governance",
    requiredClaims: ["governance:approvals:comment"],
    inputSchema: object(
      {
        ...idempotency,
        approvalId: text("Approval identifier.", 200),
        body: text("Approval comment."),
      },
      ["idempotencyKey", "approvalId", "body"],
    ),
    outputSchema: operationReceipt,
  }),
  descriptor({
    operationId: "schedule_wake",
    title: "Schedule bounded wake",
    description: "Schedule a bounded continuation wake.",
    placement: "optional",
    effect: "write",
    requiredClaims: ["control_plane:wakes"],
    allowedModes: STANDARD_MODE,
    inputSchema: object(
      {
        ...idempotency,
        reason: {
          enum: [
            "manual",
            "issue_commented",
            "interaction_resolved",
            "approval_resolved",
            "blockers_resolved",
            "scheduled_retry",
            "resume",
          ],
        },
        payload: openObject,
        delaySeconds: { type: "integer", minimum: 1, maximum: 86_400 },
      },
      ["idempotencyKey", "reason", "delaySeconds"],
    ),
    outputSchema: operationReceipt,
  }),
];

const byId = new Map(
  descriptors.map((item) => [item.operationId, deepFreeze(item)]),
);
if (byId.size !== descriptors.length)
  throw new Error("duplicate semantic action operation id");

/**
 * Canonical declarations only. Consumers must not treat membership as
 * permission to expose or invoke an action.
 */
export const PAPERCLIP_SEMANTIC_ACTION_CATALOG = Object.freeze([
  ...byId.values(),
]);

export function paperclipSemanticAction(
  operationId: string,
): PaperclipSemanticActionDescriptor | undefined {
  return byId.get(operationId as PaperclipSemanticActionId);
}

export function canonicalPaperclipSemanticActionCatalog(): string {
  return `${JSON.stringify(sortKeys(PAPERCLIP_SEMANTIC_ACTION_CATALOG), null, 2)}\n`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
