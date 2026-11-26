const description = "Change a company skill's catalog details outside SKILL.md: its tagline (one line) and categories; send tagline, categories or both. Its name and description are SKILL.md frontmatter; change those with update_skill. Uses the skill page's edit policy.";

/** Canonical definition and documentation for `update_skill_details`. */
export const updateSkillDetailsAction = {
  id: "update_skill_details",
  canonical: {
    operationId: "update_skill_details", surfaces: ["live"], placement: "optional_agent_tool",
    optionalGroup: "company_skills", requiredClaims: [], taskModes: ["standard"],
    sideEffectClass: "company_write", idempotency: "none", disabledByDefault: false,
    realBindingStatus: "live_codex", realServiceBinding: "PaperclipRunnerToolAuthority",
    prpEvidence: "Authenticated company skill update API with the company skill edit policy and attributed activity.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: { title: "Update skill details", description, note: null },
  examples: {
    call: { operationId: "update_skill_details", input: { skillId: "00000000-0000-4000-8000-000000000001", tagline: "Reviews pull requests", categories: ["engineering"] } },
    scenarioCall: null,
    success: { ok: true, operationId: "update_skill_details", result: {} },
  },
  live: { order: 97, descriptor: {
    schema: "paperclip.semantic-tool.v1", operationId: "update_skill_details", version: 1,
    title: "Update skill details", description, exposure: "optional", requiredClaims: [], allowedModes: ["standard"],
    inputSchema: { type: "object", additionalProperties: false, required: ["skillId"], properties: {
      skillId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" },
      tagline: { type: ["string", "null"], maxLength: 120, description: "One line shown with the skill; null clears it." },
      categories: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 }, description: "Replaces its categories." },
    } },
    outputSchema: { type: "object", additionalProperties: true },
  } },
  scenario: null,
} as const;
