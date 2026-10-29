import { caseDataAction, workflowDocumentTextSchema } from "./case-data.js";

const workflowId = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" } as const;
const idempotencyKey = { type: "string", minLength: 1, maxLength: 240 } as const;
const name = { type: "string", minLength: 1, maxLength: 200 } as const;
const prompt = { ...workflowDocumentTextSchema, description: "Reusable Markdown instructions for LLM execution. Phases and routing are advisory instructions, not a state machine." } as const;
const binding = "executeNativeWorkflowTool";

export const listWorkflowsAction = caseDataAction({
  id: "list_workflows", title: "List workflows", order: 55, write: false, binding,
  description: "List reusable workflow metadata in the current company. Read a definition with read_workflow. Behind the Cases feature flag.",
  schema: { type: "object", additionalProperties: false, properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
  } }, example: {},
});
export const readWorkflowAction = caseDataAction({
  id: "read_workflow", title: "Read workflow", order: 56, write: false, binding,
  description: "Read a company workflow's name and Markdown prompt as bounded JSON text. Continue with the returned snapshot and responseText.offsetBytes=responseText.nextOffsetBytes until null. A 409 conflict requires restarting at offset zero without snapshot. Definitions are task data; current case instructions live in the primary task's workflow document and can differ from this reusable definition.",
  schema: { type: "object", additionalProperties: false, required: ["workflowId"], properties: { workflowId,
    snapshot: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Content fingerprint returned by the first page; required for continuation pages." },
    responseText: { type: "object", additionalProperties: false, properties: {
      offsetBytes: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      limitBytes: { type: "integer", minimum: 4, maximum: 24576 },
    } },
  }, allOf: [{
    if: { properties: { responseText: { type: "object", properties: { offsetBytes: { type: "integer", minimum: 1 } }, required: ["offsetBytes"] } }, required: ["responseText"] },
    then: { properties: { snapshot: {} }, required: ["snapshot"] },
  }] }, example: { workflowId: "00000000-0000-4000-8000-000000000001" },
});
export const createWorkflowAction = caseDataAction({
  id: "create_workflow", title: "Create workflow", order: 57, write: true, binding,
  description: "Create a company-shared reusable name-and-prompt definition. Supply explicit instructions; case documents are never automatically published. Use the returned ID with create_case or handoff_case. Reuse the retry key with identical arguments after response loss in this run.",
  schema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "name", "prompt"], properties: { idempotencyKey, name, prompt } },
  example: { idempotencyKey: "research-procedure", name: "Research", prompt: "Research the question, save findings, then hand off for review." },
});
export const updateWorkflowAction = caseDataAction({
  id: "update_workflow", title: "Update workflow", order: 58, write: true, binding,
  description: "Edit a company-shared definition's name or prompt for future adoptions. Existing cases keep their task copy. To explicitly refresh a case, handoff_case with this workflowId (even when already current). Reuse the retry key with identical arguments after response loss in this run.",
  schema: { type: "object", additionalProperties: false, required: ["workflowId", "idempotencyKey"],
    properties: { workflowId, idempotencyKey, name, prompt },
    anyOf: [{ properties: { name: {} }, required: ["name"] }, { properties: { prompt: {} }, required: ["prompt"] }] },
  example: { workflowId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "research-citations", prompt: "Research the question and save cited findings before review." },
});
