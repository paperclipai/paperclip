import type { IssueChatTranscriptEntry } from "./issue-chat-messages";

export const CURSOR_CLOUD_SESSION_URL_PREFIX = "https://cursor.com/agents/";

export function isCursorCloudAdapter(adapterType: string | null | undefined): boolean {
  return adapterType === "cursor_cloud";
}

export function buildCursorCloudSessionUrl(cursorAgentId: string): string {
  return `${CURSOR_CLOUD_SESSION_URL_PREFIX}${encodeURIComponent(cursorAgentId.trim())}`;
}

export function extractCursorAgentIdFromResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson) return null;
  const cursorAgentId = resultJson.cursorAgentId;
  return typeof cursorAgentId === "string" && cursorAgentId.trim()
    ? cursorAgentId.trim()
    : null;
}

export function extractCursorAgentIdFromTranscript(
  transcript: readonly Pick<IssueChatTranscriptEntry, "kind" | "sessionId">[],
): string | null {
  for (const entry of transcript) {
    if (entry.kind === "init" && typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      return entry.sessionId.trim();
    }
  }
  return null;
}

export function resolveCursorAgentIdForRun(input: {
  adapterType?: string | null;
  resultJson?: Record<string, unknown> | null;
  transcript?: readonly Pick<IssueChatTranscriptEntry, "kind" | "sessionId">[];
}): string | null {
  if (!isCursorCloudAdapter(input.adapterType)) return null;
  return (
    extractCursorAgentIdFromResultJson(input.resultJson)
    ?? extractCursorAgentIdFromTranscript(input.transcript ?? [])
  );
}
