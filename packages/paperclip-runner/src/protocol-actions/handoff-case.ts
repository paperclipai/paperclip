import { initialDocumentsSchema, workflowDocumentTextSchema } from "./case-data.js";
/** Canonical production case handoff; assignment authorization is branch-specific in the server. */
const description = "Transfer a case's primary task to the next agent and phase, reusing the same task ID, or record intent to finish an existing case with to: 'done'. Save findings first. Supply the observed case handoffVersion and task statusVersion when reusing existing work. A new case starts with a harness-created task unless explicitly bound. Supply workflow_document_text for case.create and when starting the first task of a passive case; it becomes the ordinary task document key workflow, title Workflow. For a new case bound to an existing task, this document is created only when that key does not already exist. Omit workflow_document_text on later handoffs of an existing primary task. Recommend workflow Markdown with both a fenced Mermaid stateDiagram-v2 diagram and prose defining each named transition: trigger or condition, required evidence or outputs, destination agent ID, human wait and resume behavior, and bounded correction, retry or escalation. State IDs should match phase names. The diagram is advisory and the server does not parse or enforce transitions. Optional initialDocuments seeds other ordinary task documents only for a newly created task; the workflow key is reserved and the combined seed text limit is 200000 characters. For an agent handoff, after callerMustYield is true, end the turn immediately: the harness starts the recipient after your execution settles. Do not finish the task or create a replacement task for another agent phase. For to: 'done', phase defaults to 'done', both observed versions are required, and no agent, new case, or task binding is accepted. A done receipt does not complete the task or yield execution: call finish_task normally with truthful completion evidence. The case closes only when normal task completion is accepted; review and approval gates still apply.";
const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const agentInputSchema = {
  type: "object", additionalProperties: false,
  required: ["idempotencyKey", "case", "toAgentId", "phase", "instructions"],
  properties: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240 },
    case: { oneOf: [
      { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: uuidPattern } } },
      { type: "object", additionalProperties: false, required: ["create"], properties: { create: {
        type: "object", additionalProperties: false, required: ["caseType", "title"], properties: {
          caseType: { type: "string", minLength: 1, maxLength: 120 }, title: { type: "string", minLength: 1, maxLength: 500 },
          summary: { type: "string", maxLength: 8000 }, fields: { type: "object", additionalProperties: true },
          projectId: { type: ["string", "null"], pattern: uuidPattern },
        },
      } } },
    ] },
    toAgentId: { type: "string", pattern: uuidPattern }, phase: { type: "string", minLength: 1, maxLength: 120 },
    instructions: { type: "string", minLength: 1, maxLength: 20000 },
    expectedHandoffVersion: { type: "integer", minimum: 0 }, expectedIssueStatusVersion: { type: "integer", minimum: 0 },
    bindIssueId: { type: "string", pattern: uuidPattern },
    workflow_document_text: workflowDocumentTextSchema,
    initialDocuments: initialDocumentsSchema,
  },
  allOf: [{
    if: {
      properties: { case: { type: "object", properties: { create: {} }, required: ["create"] } },
      required: ["case"],
    },
    then: { properties: { workflow_document_text: workflowDocumentTextSchema }, required: ["workflow_document_text"] },
  }],
} as const;
const doneInputSchema = {
  type: "object", additionalProperties: false,
  required: ["to", "idempotencyKey", "case", "instructions", "expectedHandoffVersion", "expectedIssueStatusVersion"],
  properties: {
    to: { type: "string", const: "done" },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240 },
    case: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: uuidPattern } } },
    phase: { type: "string", const: "done", default: "done" },
    instructions: { type: "string", minLength: 1, maxLength: 20000 },
    expectedHandoffVersion: { type: "integer", minimum: 0 },
    expectedIssueStatusVersion: { type: "integer", minimum: 0 },
  },
} as const;
const inputSchema = { type: "object", oneOf: [agentInputSchema, doneInputSchema] } as const;
export const handoffCaseAction = {
  id: "handoff_case",
  canonical: { operationId: "handoff_case", surfaces: ["live"], placement: "optional_agent_tool", optionalGroup: "cases",
    requiredClaims: [], taskModes: ["standard"], sideEffectClass: "company_write", idempotency: "required", disabledByDefault: false,
    realBindingStatus: "live_codex", realServiceBinding: "caseHandoffService.handoff", prpEvidence: "Durable case handoff, same-task assignment, wake receipt, and completion intent",
    prpBindingStatus: "bound", legacyAliases: [] },
  documentation: { title: "Handoff case", description, note: null },
  examples: {
    call: { operationId: "handoff_case", input: { idempotencyKey: "triage-to-implementation", case: { id: "00000000-0000-4000-8000-000000000001" },
      toAgentId: "00000000-0000-4000-8000-000000000002", phase: "implementation", instructions: "Implement the saved specification.", expectedHandoffVersion: 1, expectedIssueStatusVersion: 2 } },
    scenarioCall: null,
    success: { ok: true, operationId: "handoff_case", result: { handoffId: "handoff-id", caseId: "case-id", taskId: "task-id",
      taskIdentifier: "ABC-123", handoffVersion: 2, destinationKind: "agent", state: "awaiting_release", completedAt: null, callerMustYield: true, replayed: false } },
  },
  live: { order: 51, descriptor: { schema: "paperclip.semantic-tool.v1", operationId: "handoff_case", version: 1,
    title: "Handoff case", description, exposure: "optional", requiredClaims: [], allowedModes: ["standard"], inputSchema,
    outputSchema: { type: "object", additionalProperties: true } } },
  scenario: null,
} as const;
