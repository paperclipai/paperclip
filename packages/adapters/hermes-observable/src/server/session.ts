import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const conversation =
      readNonEmptyString(record.conversation);
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    const gatewaySessionKey =
      readNonEmptyString(record.gatewaySessionKey) ??
      readNonEmptyString(record.gateway_session_key);
    const lastResponseId =
      readNonEmptyString(record.lastResponseId) ??
      readNonEmptyString(record.responseId) ??
      readNonEmptyString(record.response_id);

    if (!conversation && !sessionId && !gatewaySessionKey && !lastResponseId) {
      return null;
    }

    return {
      ...(conversation ? { conversation } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(gatewaySessionKey ? { gatewaySessionKey } : {}),
      ...(lastResponseId ? { lastResponseId } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const conversation = readNonEmptyString(params.conversation);
    const sessionId = readNonEmptyString(params.sessionId);
    const gatewaySessionKey = readNonEmptyString(params.gatewaySessionKey);
    const lastResponseId = readNonEmptyString(params.lastResponseId);

    if (!conversation && !sessionId && !gatewaySessionKey && !lastResponseId) {
      return null;
    }

    return {
      ...(conversation ? { conversation } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(gatewaySessionKey ? { gatewaySessionKey } : {}),
      ...(lastResponseId ? { lastResponseId } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.conversation) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.lastResponseId)
    );
  },
};
