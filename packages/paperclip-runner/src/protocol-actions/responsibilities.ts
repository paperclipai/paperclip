/** Canonical definitions for the area and responsibility tools (experimental, `enableResponsibilities`). */
const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const binding = "callResponsibilityTool";
const outputSchema = { type: "object", additionalProperties: true } as const;

function responsibilityAction<const Id extends string, const Schema, const Input>(input: {
  id: Id;
  title: string;
  description: string;
  order: number;
  write: boolean;
  schema: Schema;
  example: Input;
}) {
  const modes = input.write ? ["standard"] as const : ["standard", "ask", "planning", "skill_test"] as const;
  return {
    id: input.id,
    canonical: {
      operationId: input.id, surfaces: ["live"], placement: "optional_agent_tool", optionalGroup: "discovery",
      requiredClaims: [], taskModes: modes, sideEffectClass: input.write ? "company_write" : "read",
      idempotency: input.write ? "required" : "none", disabledByDefault: false,
      realBindingStatus: "live_codex", realServiceBinding: binding,
      prpEvidence: input.write
        ? "Authenticated responsibility routes with run-bound activity for the person the agent works for."
        : "Authenticated responsibility routes with the reader's task and project visibility.",
      prpBindingStatus: "bound", legacyAliases: [],
    },
    documentation: { title: input.title, description: input.description, note: null },
    examples: {
      call: { operationId: input.id, input: input.example },
      scenarioCall: null,
      success: { ok: true, operationId: input.id, result: {} },
    },
    live: {
      order: input.order,
      descriptor: {
        schema: "paperclip.semantic-tool.v1", operationId: input.id, version: 1,
        title: input.title, description: input.description, exposure: "optional",
        requiredClaims: [], allowedModes: modes, inputSchema: input.schema, outputSchema,
      },
    },
    scenario: null,
  } as const;
}

export const listResponsibilitiesAction = responsibilityAction({
  id: "list_responsibilities", title: "List responsibilities", order: 84, write: false,
  description: "List a person's areas and responsibilities: each area with its responsibilities (status, bar, health, the agent that runs it, and counts of filed projects, routines and tasks), responsibilities with no area, and uncovered work (company routines, projects and open tasks filed under no responsibility). Defaults to the person this run works for; never ask for their user ID. Use this before asking the person what they are responsible for. A turned-off error means the feature is off, not that the list is empty.",
  schema: { type: "object", additionalProperties: false, properties: {
    ownerUserId: { type: "string", minLength: 1, maxLength: 200, description: "Another person's user ID from list_people. Omit for the person this run works for." },
    areaId: { type: "string", pattern: uuidPattern, description: "Return only this area." },
    includeProposed: { type: "boolean", default: true, description: "Include responsibilities proposed but not yet confirmed." },
    includeLetGo: { type: "boolean", default: false, description: "Include responsibilities the person let go." },
    includeArchivedAreas: { type: "boolean", default: false, description: "Include archived areas." },
  } }, example: {},
});

export const getResponsibilityAction = responsibilityAction({
  id: "get_responsibility", title: "Read responsibility", order: 85, write: false,
  description: "Read one responsibility in full: its bar and health, area, the projects, tasks and routines under it (with link IDs for items filed directly, and items under it through a filed project), the skills of the agents doing its work, and its latest status report.",
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId"], properties: {
    responsibilityId: { type: "string", pattern: uuidPattern, description: "Responsibility ID from list_responsibilities or find_responsibilities_for." },
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001" },
});

export const findResponsibilitiesForAction = responsibilityAction({
  id: "find_responsibilities_for", title: "Find responsibilities for an item", order: 86, write: false,
  description: "List the proposed and active responsibilities a project, task or routine is filed under, directly or through its project. An empty list means it is uncovered.",
  schema: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: {
    kind: { type: "string", enum: ["project", "task", "routine"], description: "What the item is." },
    id: { type: "string", minLength: 1, maxLength: 200, description: "The item's ID. For a task, an identifier such as PAP-123 also works." },
  } }, example: { kind: "routine", id: "00000000-0000-4000-8000-000000000002" },
});
