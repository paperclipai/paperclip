/** Canonical definition and documentation for `update_skill`. */
export const updateSkillAction = {
  id: "update_skill",
  canonical: {
    operationId: "update_skill", surfaces: ["scenario", "live"], placement: "optional_agent_tool",
    optionalGroup: "company_skills", requiredClaims: [], taskModes: ["standard", "skill_test"],
    sideEffectClass: "company_write", idempotency: "required", disabledByDefault: false,
    realBindingStatus: "live_codex", realServiceBinding: "PaperclipRunnerToolAuthority",
    prpEvidence: "Authenticated skill file API with version guard, durable receipt, and attributed activity.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: {
    title: "Update skill",
    description: "Replace the primary SKILL.md of an existing company skill. Read the current skill and version first. Supply the complete file, expectedVersionId, and an idempotencyKey; reuse the key on retries. A version conflict requires a fresh read. This uses the existing file API and company edit policy.",
    note: null,
  },
  examples: {
    call: { operationId: "update_skill", input: { skillId: "00000000-0000-4000-8000-000000000001", expectedVersionId: "00000000-0000-4000-8000-000000000002", idempotencyKey: "edit-1", markdown: "---\nname: review\ndescription: Review changes.\n---\n\n# Review\nInspect the changes.\n" } },
    scenarioCall: { operationId: "update_skill", idempotencyKey: "edit-1", input: { skillId: "skill-example", expectedVersionId: "version-example", markdown: "---\nname: review\ndescription: Review changes.\n---\n\n# Review\nInspect the changes.\n" } },
    success: { ok: true, operationId: "update_skill", result: { skillId: "skill-example", path: "SKILL.md", versionId: "version-next", studioPath: "/skills/studio/skill-example" } },
  },
  live: {
    order: 47,
    descriptor: {
      schema: "paperclip.semantic-tool.v1", operationId: "update_skill", version: 1,
      title: "Update skill", description: "Replace an existing company skill's complete SKILL.md using the current version as a guard. Reuse idempotencyKey on lost-response retries; read again after a version conflict.",
      exposure: "optional", requiredClaims: [], allowedModes: ["standard", "skill_test"],
      inputSchema: { type: "object", properties: {
        skillId: { type: "string", minLength: 1 },
        markdown: { type: "string", minLength: 1, maxLength: 200000 },
        expectedVersionId: { type: "string", minLength: 1 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 240 },
      }, required: ["skillId", "markdown", "expectedVersionId", "idempotencyKey"], additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
    },
  },
  scenario: {
    order: 47,
    successExample: { schema: "paperclip.capability.tool-result.v1", ok: true, operationId: "update_skill", operationResultId: "example-result", value: { commandId: "example", disposition: "applied", stateRevision: 1, entityRefs: ["skill:skill-example"], scheduledWakeIds: [] }, commandResult: null, authorization: {} },
    descriptor: {
      operationId: "update_skill", version: 1, title: "Update skill",
      description: "Replace an existing company skill's complete SKILL.md with an expected version guard and a retry key.",
      inputSchema: { type: "object", properties: {
        skillId: { type: "string", minLength: 1 },
        markdown: { type: "string", minLength: 1, maxLength: 200000 },
        expectedVersionId: { type: "string", minLength: 1 },
      }, required: ["skillId", "markdown", "expectedVersionId"], additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true },
      disposition: "optional_agent_tool", optionalGroup: "company_skills", requiredClaims: [],
      taskModes: ["standard", "skill_test"], sideEffectClass: "company_write", idempotency: "required", redaction: [],
      mockCommandMapping: { kind: "semantic_command", commandKind: "update_skill" },
    },
  },
} as const;
