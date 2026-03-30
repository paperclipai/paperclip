export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOllamaModels } from "./models.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import type { OllamaMessage } from "./execute.js";

function isOllamaMessage(value: unknown): value is OllamaMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.role === "system" || rec.role === "user" || rec.role === "assistant") &&
    typeof rec.content === "string"
  );
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.messages)) return null;
    const messages = (record.messages as unknown[]).filter(isOllamaMessage);
    if (messages.length === 0) return null;
    return { messages };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    if (!Array.isArray(params.messages)) return null;
    const messages = (params.messages as unknown[]).filter(isOllamaMessage);
    if (messages.length === 0) return null;
    return { messages };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    if (!Array.isArray(params.messages)) return null;
    const userTurns = (params.messages as unknown[]).filter(
      (m) => isOllamaMessage(m) && m.role === "user",
    ).length;
    if (userTurns === 0) return null;
    return `${userTurns} prior turn${userTurns !== 1 ? "s" : ""}`;
  },
};
