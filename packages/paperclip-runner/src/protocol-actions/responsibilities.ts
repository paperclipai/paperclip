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
      // Writes are idempotent by what they set; a create reuses a live one with the same title.
      idempotency: "none", disabledByDefault: false,
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
  description: "Read one responsibility in full: its bar and health, area, the projects, tasks and routines under it (with link IDs for items filed directly, and items under it through a filed project), its skills (filed by hand, with a link ID, and computed from the agents doing its work), and its latest status report.",
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId"], properties: {
    responsibilityId: { type: "string", pattern: uuidPattern, description: "Responsibility ID from list_responsibilities or find_responsibilities_for." },
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001" },
});

export const findResponsibilitiesForAction = responsibilityAction({
  id: "find_responsibilities_for", title: "Find responsibilities for an item", order: 86, write: false,
  description: "List the proposed and active responsibilities a project, task, routine or company skill is filed under, directly or (for a task or routine) through its project. An empty list means it is uncovered.",
  schema: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: {
    kind: { type: "string", enum: ["project", "task", "routine", "skill"], description: "What the item is." },
    id: { type: "string", minLength: 1, maxLength: 200, description: "The item's ID. For a task, an identifier such as PAP-123 also works." },
  } }, example: { kind: "routine", id: "00000000-0000-4000-8000-000000000002" },
});

const id = (description: string) => ({ type: "string", pattern: uuidPattern, description }) as const;
const nullableText = (description: string) => ({ type: ["string", "null"], maxLength: 10000, description }) as const;
const title = { type: "string", minLength: 1, maxLength: 200 } as const;
const items = {
  type: "array", minItems: 1, maxItems: 50,
  description: "What to file: each a project, task, routine or company skill by ID. A task can also be an identifier such as PAP-12.",
  items: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: {
    kind: { type: "string", enum: ["project", "task", "routine", "skill"] },
    id: { type: "string", minLength: 1, maxLength: 200 },
  } },
} as const;
const bar = {
  type: "object", additionalProperties: false, required: ["name"],
  description: "The metric that measures the bar. volume and percentage need target; range needs low and high; yes_no needs only name (the statement that should be true).",
  properties: {
    kind: { type: "string", enum: ["volume", "percentage", "yes_no", "range"], description: "Default: percentage when unit is %, otherwise volume." },
    name: { type: "string", minLength: 1, maxLength: 200, description: "What is measured, e.g. Investors contacted." },
    unit: { type: ["string", "null"], maxLength: 40 },
    target: { type: ["number", "null"] },
    low: { type: ["number", "null"] },
    high: { type: ["number", "null"] },
    direction: { type: "string", enum: ["at_least", "at_most"] },
    current: { type: ["number", "boolean", "null"], description: "The latest reading; true or false for yes_no." },
  },
} as const;
const actsFor = "When the person this run works for directed it (it is their own chat or task, or their message woke you), you act for them and may do what they could; each change is saved in their Dashboard history, where they can undo it. Otherwise the change is saved as a proposal for a person to confirm.";

export const createAreaAction = responsibilityAction({
  id: "create_area", title: "Create area", order: 87, write: true,
  description: `Create an area, a broad heading for responsibilities such as Fundraising. If a live area already has this title (any case), it is returned instead. ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["title"], properties: {
    title, description: nullableText("What the area covers."), sortOrder: { type: "integer" },
  } }, example: { title: "Fundraising" },
});

export const updateAreaAction = responsibilityAction({
  id: "update_area", title: "Update area", order: 88, write: true,
  description: `Rename, describe, reorder, archive or restore an area. Archiving keeps its responsibilities and can be undone. ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["areaId"], properties: {
    areaId: id("Area ID from list_responsibilities."), title, description: nullableText("What the area covers."),
    sortOrder: { type: "integer" }, status: { type: "string", enum: ["active", "archived"] },
  } }, example: { areaId: "00000000-0000-4000-8000-000000000003", title: "Raising money" },
});

export const deleteAreaAction = responsibilityAction({
  id: "delete_area", title: "Delete area", order: 89, write: true,
  description: "Delete an area permanently. This cannot be undone, so the first call posts a confirmation card for the person and returns awaiting_confirmation: tell them, then stop. When they accept, you are woken; call again with the same arguments to delete. Prefer update_area with status archived, which can be undone.",
  schema: { type: "object", additionalProperties: false, required: ["areaId"], properties: {
    areaId: id("Area ID from list_responsibilities."),
    moveResponsibilitiesTo: id("Another area for its responsibilities. Without one they are left with no area."),
    askAgain: { type: "boolean", description: "Post a new card after the person declined; only when they ask again." },
  } }, example: { areaId: "00000000-0000-4000-8000-000000000003" },
});

export const createResponsibilityAction = responsibilityAction({
  id: "create_responsibility", title: "Create responsibility", order: 90, write: true,
  description: `Create a responsibility for a person; a title alone is enough, the bar can come later. Defaults to the person this run works for and to active. A live responsibility of that person with the same title is returned instead of a copy. File it under an area by areaId or areaTitle (an area with that title is reused or created), and file work under it with fileItems. ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["title"], properties: {
    title, ownerUserId: { type: "string", minLength: 1, maxLength: 200, description: "Another person's user ID from list_people. Omit for the person this run works for." },
    areaId: id("Area ID. Send areaId or areaTitle, not both."), areaTitle: { ...title, description: "Area by title; created when no live area has it." },
    description: nullableText("More about it."), standard: nullableText("The bar as one sentence: what must be true."),
    bar, runByAgentId: id("The agent that runs the work and keeps the metric current."),
    evidence: nullableText("Why you created it, shown to the person on a proposal."),
    status: { type: "string", enum: ["active", "proposed"], description: "Default active. Use proposed to let the person confirm it." },
    fileItems: { ...items, minItems: 0 },
  } }, example: { title: "Keep investors updated", areaTitle: "Fundraising" },
});

export const updateResponsibilityAction = responsibilityAction({
  id: "update_responsibility", title: "Update responsibility", order: 91, write: true,
  description: `Change a responsibility: its title, description, bar sentence (standard), metric (bar; null clears it), area (areaId, null for none, or areaTitle), the agent that runs it, order, health override and note, or status (active, proposed, let_go to stop it, dismissed for a proposal). ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId"], properties: {
    responsibilityId: id("Responsibility ID from list_responsibilities."),
    title, description: nullableText("More about it."), standard: nullableText("The bar as one sentence."),
    bar: { ...bar, type: ["object", "null"] },
    areaId: { type: ["string", "null"], pattern: uuidPattern, description: "Move it to this area; null for no area." },
    areaTitle: { ...title, description: "Move it to the area with this title; created when no live area has it." },
    runByAgentId: { type: ["string", "null"], pattern: uuidPattern, description: "The agent that runs it; null for none." },
    sortOrder: { type: "integer" },
    healthOverride: { type: ["string", "null"], enum: ["behind", "at_risk", "on_track", null], description: "Override the computed health; null clears it." },
    healthNote: nullableText("Why the health is overridden."),
    status: { type: "string", enum: ["active", "proposed", "let_go", "dismissed"] },
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001", areaTitle: "Customers" },
});

export const deleteResponsibilityAction = responsibilityAction({
  id: "delete_responsibility", title: "Delete responsibility", order: 92, write: true,
  description: "Delete a responsibility permanently, with its bar and metric history. This cannot be undone, so the first call posts a confirmation card for the person and returns awaiting_confirmation: tell them, then stop. When they accept, you are woken; call again with the same arguments to delete. To stop a responsibility without losing it, use update_responsibility with status let_go.",
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId"], properties: {
    responsibilityId: id("Responsibility ID from list_responsibilities."),
    askAgain: { type: "boolean", description: "Post a new card after the person declined; only when they ask again." },
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001" },
});

export const fileUnderResponsibilityAction = responsibilityAction({
  id: "file_under_responsibility", title: "File work under responsibility", order: 93, write: true,
  description: `File projects, tasks, routines and company skills under a responsibility in one step. With moveFrom it is a move: the items also leave that responsibility, or with all, every other responsibility of the same person. An item can sit under several responsibilities; filing one already there changes nothing. ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId", "items"], properties: {
    responsibilityId: id("Responsibility ID to file under."), items,
    moveFrom: { type: "string", description: "A responsibility ID to move the items from, or all." },
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001", items: [{ kind: "routine", id: "00000000-0000-4000-8000-000000000002" }] },
});

export const removeFromResponsibilityAction = responsibilityAction({
  id: "remove_from_responsibility", title: "Remove work from responsibility", order: 94, write: true,
  description: `Unfile projects, tasks, routines and skills from a responsibility by what they are; no link IDs needed. The items themselves are not changed. ${actsFor}`,
  schema: { type: "object", additionalProperties: false, required: ["responsibilityId", "items"], properties: {
    responsibilityId: id("Responsibility ID."), items,
  } }, example: { responsibilityId: "00000000-0000-4000-8000-000000000001", items: [{ kind: "task", id: "PAP-12" }] },
});
