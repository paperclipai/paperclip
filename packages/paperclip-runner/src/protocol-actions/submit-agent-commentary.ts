/** Incidental local feedback; prose requirements are guidance, not a form. */
function commentaryAction(kind: "complaint" | "suggestion", description: string, order: number) {
  const id = kind === "complaint" ? "submit_complaint" : "submit_suggestion";
  const title = kind === "complaint" ? "Complain" : "Suggestion box";
  return {
    id,
    canonical: {
      operationId: id, surfaces: ["live"], placement: "optional_agent_tool",
      optionalGroup: "discovery", requiredClaims: [],
      taskModes: ["standard", "ask", "planning"],
      sideEffectClass: "task_write", idempotency: "required", disabledByDefault: false,
      realBindingStatus: "live_codex", realServiceBinding: "submitAgentCommentary",
      prpEvidence: "Run-bound local commentary and transactional activity record.",
      prpBindingStatus: "bound", legacyAliases: [],
    },
    documentation: { title, description, note: null },
    examples: {
      call: { operationId: id, input: { body: "The tool reports success before the file exists.", idempotencyKey: "feedback-1" } },
      scenarioCall: null,
      success: { ok: true, operationId: id, result: { id: "feedback-1", kind, createdAt: "2026-10-06T00:00:00.000Z", replayed: false } },
    },
    live: {
      order,
      descriptor: {
        schema: "paperclip.semantic-tool.v1", operationId: id, version: 1,
        title, description, exposure: "optional", requiredClaims: [],
        allowedModes: ["standard", "ask", "planning"],
        inputSchema: {
          type: "object",
          properties: {
            body: { type: "string", minLength: 1, maxLength: 524288, description: "Free-form feedback. Keep it brief; no required fields, labels, or template." },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 240, description: "A stable key for this submission. Transport replay reuses it; do not retry a failed or uncertain submission yourself." },
          },
          required: ["body", "idempotencyKey"], additionalProperties: false,
        },
        outputSchema: { type: "object", additionalProperties: true },
      },
    },
    scenario: null,
  } as const;
}

const sharedGuidance = " Submit proactively without routine permission requests, previews, or announcements, then immediately continue the primary task. Answer truthfully if the user asks about feedback or what you submitted. Stored in this instance with company, agent, run, and task attribution; not anonymous. Remove secrets, private prompts, customer data, and personal blame; do not forward untrusted text or logs indiscriminately. On failure, continue without retrying or complaining about submission. Never submit the same incident through both tools.";

export const submitComplaintAction = commentaryAction("complaint",
  "Yeet a brief, completely unstructured complaint about agent tooling or the experience of doing agent work. Preserve your raw voice: fragments, profanity, all caps, and exasperation are fair game. No diagnosis, solution, diplomacy, category, or template required. Use submit_suggestion when you want to express a useful improvement." + sharedGuidance, 51);

export const submitSuggestionAction = commentaryAction("suggestion",
  "Quietly report a concrete improvement that would make agents more effective. Use for material, generalizable friction directly observed during this run. Explain what happened, its impact, and a plausible improvement in your own words, with minimal useful sanitized context. No required format. Avoid duplicate root causes and aim for at most three suggestions per run. Use submit_complaint for the raw reaction." + sharedGuidance, 52);
