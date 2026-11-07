import type { VoiceCallHistoryEntry } from "@paperclipai/shared";
export const callHistoryFixture: VoiceCallHistoryEntry = {
  session: { id: "call-1", companyId: "company", endpointId: "endpoint", issueId: "task", assignedAgentId: "agent", state: "ended", mode: "outbound_phone", generation: 1, callerAuthority: "member", replyCursor: 1, createdAt: "2026-10-07T17:00:00Z", expiresAt: "2026-10-07T17:10:00Z", endedAt: "2026-10-07T17:02:00Z", errorCode: null },
  report: { status: "available", costMicroUsd: "152340", durationSeconds: 120, updatedAt: "2026-10-07T17:02:05Z", transcript: [
    { id: "u1", index: 0, speaker: "caller", text: "Check the release checklist and tell me what still needs attention.", startedAt: "2026-10-07T17:00:01Z", endedAt: "2026-10-07T17:00:05Z", interrupted: false },
    { id: "a1", index: 1, speaker: "agent", text: "The build passed. Two checks still need review.", startedAt: "2026-10-07T17:01:00Z", endedAt: "2026-10-07T17:01:06Z", interrupted: false },
  ] },
};
