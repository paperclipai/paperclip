/** Antigravity 1.5.2 encodes fixed-choice questions as permission callbacks.
 * Its `_ask_question_handler` sends `session/request_permission` with a
 * synthetic tool call `interaction_<8 hex>` (checked in the 1.5.2 server
 * source); every other permission callback is a real tool approval. */
const QUESTION_TOOL_CALL = /^interaction_[0-9a-f]{8}$/;
const MAX_RETIRED = 256;

export function createAntigravityQuestionBridge(ownsSession: (sessionId: unknown) => boolean) {
  const pending = new Map<string | number, { sessionId: string; optionIds: Set<string> }>();
  // Answered, cancelled or replaced questions. A later answer for one of them
  // is stale or duplicate and must never reach the native server.
  const retired = new Set<string | number>();
  const retire = (id: string | number) => {
    retired.add(id);
    if (retired.size > MAX_RETIRED) retired.delete(retired.values().next().value!);
  };
  return {
    clear() { for (const id of pending.keys()) retire(id); pending.clear(); },
    guard(direction: "inbound" | "outbound", value: unknown): void {
      const message = record(value);
      const id = message.id;
      if (direction === "inbound" && message.method === "session/request_permission") {
        const params = record(message.params);
        const tool = record(params.toolCall);
        if (typeof tool.toolCallId !== "string" || !QUESTION_TOOL_CALL.test(tool.toolCallId)) return;
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
        retired.delete(id);
        pending.set(id, { sessionId: params.sessionId, optionIds });
        // The installed ACPX form path owns durable input and delivery. Convert
        // before its permission policy can interpret a choice as an approval.
        message.method = "elicitation/create";
        message.params = form;
      } else if (direction === "outbound" && message.method === undefined
        && (typeof id === "string" || typeof id === "number") && retired.has(id)) {
        throw new Error("Antigravity answer is stale or duplicate");
      } else if (direction === "outbound" && message.method === undefined
        && (typeof id === "string" || typeof id === "number") && pending.has(id)) {
        const question = pending.get(id)!;
        if (!ownsSession(question.sessionId)) throw new Error("Antigravity answer belongs to a stale session");
        // Stop or a failed card: ACPX answers with an error, which the native
        // server treats as no selection. The question is settled either way.
        if (message.error !== undefined) { pending.delete(id); retire(id); return; }
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
        retire(id);
      }
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
