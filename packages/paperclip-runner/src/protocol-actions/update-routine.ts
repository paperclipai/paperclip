const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const description = "Change a routine: its title, instructions, agent, project, status (active, paused, archived) or priority; set its schedule in plain terms (no cron), or null to turn its schedule off; and file it under a responsibility. You may change your own routines, and those the person who directed your run (their own chat or task, or their message woke you) is responsible for; on a routine you do not run, changing its agent, turning it on or changing its schedule needs that person to be allowed to assign work. The routine and its schedule change together as one routine revision the person can restore from the routine's history; filing is saved separately in their Dashboard history (see filedUnder.undo).";

export const updateRoutineInputSchema = {
  type: "object", additionalProperties: false, required: ["routineId"],
  properties: {
    routineId: { type: "string", pattern: uuidPattern, description: "Routine ID from list_routines." },
    title: { type: "string", minLength: 1, maxLength: 200 },
    instructions: { type: ["string", "null"], maxLength: 200000, description: "What each run should do, written out in full." },
    assigneeAgentId: { type: ["string", "null"], pattern: uuidPattern, description: "The agent that runs it." },
    projectId: { type: ["string", "null"], pattern: uuidPattern },
    status: { type: "string", enum: ["active", "paused", "archived"] },
    priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
    schedule: {
      type: ["object", "null"], additionalProperties: false, required: ["frequency", "time"],
      description: "When it runs, in the person's local time. null turns its schedule off.",
      properties: {
        frequency: { type: "string", enum: ["daily", "weekdays", "weekly", "monthly"] },
        dayOfWeek: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], description: "For weekly." },
        dayOfMonth: { type: "integer", minimum: 1, maximum: 28, description: "For monthly." },
        time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "24-hour HH:MM." },
        timezone: { type: "string", minLength: 1, maxLength: 100, description: "IANA zone such as Europe/Berlin. Default: the routine's current schedule zone, else the person's own time zone." },
      },
    },
    fileUnder: { type: "string", pattern: uuidPattern, description: "A responsibility ID to file the routine under." },
  },
} as const;

/** Canonical definition and documentation for `update_routine`. */
export const updateRoutineAction = {
  id: "update_routine",
  canonical: {
    operationId: "update_routine", surfaces: ["live"], placement: "optional_agent_tool", optionalGroup: "routines",
    requiredClaims: [], taskModes: ["standard"], sideEffectClass: "company_write", idempotency: "none",
    disabledByDefault: false, realBindingStatus: "live_codex", realServiceBinding: "callRoutineTool",
    prpEvidence: "Authenticated routine routes with routine revisions and run-bound activity for the person the agent works for.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: { title: "Update routine", description, note: null },
  examples: {
    call: { operationId: "update_routine", input: { routineId: "00000000-0000-4000-8000-000000000002", schedule: { frequency: "weekly", dayOfWeek: "monday", time: "09:00" } } },
    scenarioCall: null,
    success: { ok: true, operationId: "update_routine", result: {} },
  },
  live: { order: 96, descriptor: {
    schema: "paperclip.semantic-tool.v1", operationId: "update_routine", version: 1,
    title: "Update routine", description, exposure: "optional", requiredClaims: [],
    allowedModes: ["standard"], inputSchema: updateRoutineInputSchema, outputSchema: { type: "object", additionalProperties: true },
  } },
  scenario: null,
} as const;
