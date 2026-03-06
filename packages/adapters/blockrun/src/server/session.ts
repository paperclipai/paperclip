import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

interface BlockRunSessionState {
  messages: Array<{ role: string; content: string }>;
  lastModel: string;
}

function isValidMessage(m: unknown): m is { role: string; content: string } {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as Record<string, unknown>).role === "string" &&
    typeof (m as Record<string, unknown>).content === "string"
  );
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

    const obj = raw as Record<string, unknown>;
    const messages = Array.isArray(obj.messages)
      ? (obj.messages as unknown[]).filter(isValidMessage)
      : [];
    const lastModel = typeof obj.lastModel === "string" ? obj.lastModel : "";

    return { messages, lastModel };
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;

    const messages = Array.isArray(params.messages)
      ? (params.messages as unknown[]).filter(isValidMessage)
      : [];
    const lastModel = typeof params.lastModel === "string" ? params.lastModel : "";

    return { messages, lastModel };
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    const lastModel = typeof params.lastModel === "string" ? params.lastModel : null;
    return lastModel || null;
  },
};
