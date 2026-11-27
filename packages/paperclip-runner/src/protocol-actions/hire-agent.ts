/** Canonical definition and documentation for `hire_agent`. */
export const hireAgentAction = {
  id: "hire_agent",
  canonical: {
    operationId: "hire_agent",
    surfaces: ["live"],
    placement: "optional_agent_tool",
    optionalGroup: "delegation_dependencies",
    requiredClaims: ["delegation:agents:create"],
    taskModes: ["standard", "skill_test"],
    sideEffectClass: "company_write",
    idempotency: "required",
    disabledByDefault: false,
    realBindingStatus: "live_codex",
    realServiceBinding: "PaperclipRunnerToolAuthority",
    prpEvidence: "Authenticated PRP tool input/result and agent-hire state diff with activity record.",
    prpBindingStatus: "bound",
    legacyAliases: [],
  },
  documentation: {
    title: "Hire a native agent",
    description: "Create a persistent native Runner teammate with an identity and persona. The teammate reports to the caller and inherits the caller's native runtime; provider, adapter, environment, and credential settings are selected by Paperclip and are never caller-supplied here.",
    note: "Use list_agents first when a suitable teammate may already exist.",
  },
  examples: {
    call: {
      operationId: "hire_agent",
      input: { name: "Reviewer", role: "qa" },
    },
    success: {
      ok: true,
      operationId: "hire_agent",
      result: {},
    },
  },
  live: {
    order: 15,
    descriptor: {
      schema: "paperclip.semantic-tool.v1",
      operationId: "hire_agent",
      version: 1,
      title: "Hire a native agent",
      description: "Create a persistent native Runner teammate with an identity and persona. The teammate reports to the caller and inherits the caller's native runtime; provider, adapter, environment, and credential settings are selected by Paperclip and are never caller-supplied here. Reuse a suitable teammate from list_agents when possible.",
      exposure: "optional",
      requiredClaims: ["delegation:agents:create"],
      allowedModes: ["standard", "skill_test"],
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          role: { type: "string", enum: ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"] },
          title: { type: ["string", "null"], maxLength: 300 },
          capabilities: { type: ["string", "null"], maxLength: 2000 },
          instructions: { type: ["string", "null"], maxLength: 20000 },
        },
        required: ["name"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", additionalProperties: true },
    },
  },
  scenario: null,
} as const;
