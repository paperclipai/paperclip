const description = "Send a Markdown message directly to your own persistent chat with this task's responsible human. The destination is automatic. Use for requested digests and proactive task updates; report_progress writes to this task and comment_on_task writes to a chosen task. This sends no message to other agents, starts no chat run, and changes no task status. Reuse idempotencyKey on retries.";
const inputSchema = {
  type: "object", properties: {
    body: { type: "string", minLength: 1, maxLength: 20000, description: "The message the human should see." },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 240, description: "Stable key for this message within the source task, including across run retries." },
  }, required: ["body", "idempotencyKey"], additionalProperties: false,
} as const;

export const sendChatMessageAction = {
  id: "send_chat_message",
  canonical: {
    operationId: "send_chat_message", surfaces: ["live"], placement: "always_agent_tool", optionalGroup: null,
    requiredClaims: [], taskModes: ["standard"], sideEffectClass: "task_write", idempotency: "required",
    disabledByDefault: false, realBindingStatus: "live_codex", realServiceBinding: "sendAgentChatMessage",
    prpEvidence: "Attributed chat comment and transactional delivery receipt without execution or task disposition changes.",
    prpBindingStatus: "bound", legacyAliases: [],
  },
  documentation: { title: "Send message to your chat", description, note: null },
  examples: {
    call: { operationId: "send_chat_message", input: { body: "Three PRs need review.", idempotencyKey: "morning-digest" } },
    scenarioCall: null,
    success: { ok: true, operationId: "send_chat_message", result: { commentId: "comment-1", conversationId: "chat-1", sourceTaskId: "task-1", chatUrl: "/PC/chats/kodi", replayed: false } },
  },
  live: { order: 51, descriptor: {
    schema: "paperclip.semantic-tool.v1", operationId: "send_chat_message", version: 1,
    title: "Send message to your chat", description, exposure: "always", requiredClaims: [],
    allowedModes: ["standard"], inputSchema, outputSchema: { type: "object", additionalProperties: true },
  } },
  scenario: null,
} as const;
