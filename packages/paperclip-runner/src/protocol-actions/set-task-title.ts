/** Canonical title tool. The active task is resolved from the authenticated run. */
const description = "Set a concise, descriptive title for the active task. When its titleNeedsGeneration is true, call this early with onlyIfProvisional: true to replace the initial prompt slice without overwriting a user's title. Use false only for an intentional rename. This changes no task status, ownership, or description.";
const inputSchema = {
  type: "object",
  properties: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240, description: "Reuse this key on retries." },
    title: { type: "string", minLength: 1, maxLength: 240, description: "Short title describing the requested outcome." },
    onlyIfProvisional: { type: "boolean", description: "True for automatic initial naming; preserves any title already chosen by a user or agent." },
  },
  required: ["idempotencyKey", "title", "onlyIfProvisional"],
  additionalProperties: false,
} as const;

export const setTaskTitleAction = {
  id: "set_task_title",
  canonical: {
    operationId: "set_task_title", surfaces: ["live"], placement: "optional_agent_tool",
    optionalGroup: "discovery", requiredClaims: [],
    taskModes: ["standard", "ask", "planning", "skill_test"],
    sideEffectClass: "task_write", idempotency: "required", disabledByDefault: false,
    realBindingStatus: "live_codex", realServiceBinding: "setIssueTitle",
    prpEvidence: "Run-bound title update and transactional activity record.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: { title: "Set task title", description, note: null },
  examples: {
    call: { operationId: "set_task_title", input: { idempotencyKey: "initial-title", title: "Fix sign-in redirect", onlyIfProvisional: true } },
    scenarioCall: null,
    success: { ok: true, operationId: "set_task_title", result: { id: "task-1", title: "Fix sign-in redirect", titleNeedsGeneration: false, changed: true } },
  },
  live: {
    order: 50,
    descriptor: {
      schema: "paperclip.semantic-tool.v1", operationId: "set_task_title", version: 1,
      title: "Set task title", description, exposure: "optional", requiredClaims: [],
      allowedModes: ["standard", "ask", "planning", "skill_test"], inputSchema,
      outputSchema: { type: "object", additionalProperties: true },
    },
  },
  scenario: null,
} as const;
