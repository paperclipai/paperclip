/** Antigravity 1.4.3 encodes fixed-choice questions as permission callbacks. */
export function createAntigravityQuestionBridge(ownsSession: (sessionId: unknown) => boolean) {
  const pending = new Map<string | number, { sessionId: string; optionIds: Set<string> }>();
  return {
    clear() { pending.clear(); },
    guard(direction: "inbound" | "outbound", value: unknown): void {
      const message = record(value);
      const id = message.id;
      if (direction === "inbound" && message.method === "session/request_permission") {
        const params = record(message.params);
        const tool = record(params.toolCall);
        if (typeof tool.toolCallId !== "string" || !tool.toolCallId.startsWith("interaction_")) return;
        if ((typeof id !== "string" && typeof id !== "number") || pending.has(id) || pending.size >= 16
          || !ownsSession(params.sessionId) || typeof params.sessionId !== "string"
          || typeof tool.title !== "string" || !tool.title.trim()
          || !Array.isArray(params.options) || params.options.length < 1 || params.options.length > 128) {
          throw new Error("Antigravity question has invalid identity or incomplete choices");
        }
        const optionIds = new Set<string>();
        const choices = params.options.map(value => {
          const option = record(value);
          if (typeof option.optionId !== "string" || !option.optionId || option.optionId.length > 1024
            || typeof option.name !== "string" || !option.name.trim() || optionIds.has(option.optionId)) {
            throw new Error("Antigravity question has invalid or duplicate choice identities");
          }
          optionIds.add(option.optionId);
          // kind is deliberately ignored: deny/block can be an answer choice.
          return { const: option.optionId, title: option.name };
        });
        const form = {
          sessionId: params.sessionId, mode: "form", message: tool.title,
          requestedSchema: {
            type: "object", title: tool.title, required: ["answer"], additionalProperties: false,
            properties: { answer: { type: "string", title: "Answer", oneOf: choices } },
          },
        };
        if (Buffer.byteLength(JSON.stringify(form)) > 196 * 1024) throw new Error("Antigravity question exceeds its complete-content limit");
        pending.set(id, { sessionId: params.sessionId, optionIds });
        // The installed ACPX form path owns durable input and delivery. Convert
        // before its permission policy can interpret a choice as an approval.
        message.method = "elicitation/create";
        message.params = form;
      } else if (direction === "outbound" && message.method === undefined
        && (typeof id === "string" || typeof id === "number") && pending.has(id)) {
        const question = pending.get(id)!;
        if (!ownsSession(question.sessionId)) throw new Error("Antigravity answer belongs to a stale session");
        if (message.error !== undefined) { pending.delete(id); return; }
        const result = record(message.result);
        if (result.action === "accept") {
          const content = record(result.content);
          if (Object.keys(content).length !== 1 || typeof content.answer !== "string" || !question.optionIds.has(content.answer)) {
            throw new Error("Antigravity answer must select exactly one offered choice");
          }
          message.result = { outcome: { outcome: "selected", optionId: content.answer } };
        } else if (result.action === "decline" || result.action === "cancel") {
          message.result = { outcome: { outcome: "cancelled" } };
        } else throw new Error("Antigravity question response is invalid");
        pending.delete(id);
      }
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
