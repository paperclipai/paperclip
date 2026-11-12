export const VOICE_SESSION_STATES = ["reserved", "creating", "creation_unknown", "connecting", "active", "awaiting_approval", "ending", "ended", "failed", "expired"] as const;
export type VoiceSessionState = typeof VOICE_SESSION_STATES[number];
export type VoiceSessionMode = "browser" | "inbound_phone" | "outbound_phone";
export type VoiceCallerAuthority = "member" | "instance_admin" | "local_board" | "guest_intake" | "pending_approval";

/** Safe board projection. No provider key, call token, signing key, or recordings. */
export interface VoiceSession {
  id: string;
  companyId: string;
  endpointId: string;
  issueId: string;
  assignedAgentId: string;
  state: VoiceSessionState;
  mode: VoiceSessionMode;
  generation: number;
  callerAuthority: VoiceCallerAuthority;
  replyCursor: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  errorCode: string | null;
}
export interface VoiceCallbackPreference { phoneNumber: string; enabled: boolean }
export interface VoiceSessionMedia {
  sessionId: string;
  generation: number;
  transportToken: string;
  transportUrl: string;
}
export interface VoiceSessionNotification {
  sessionId: string;
  generation: number;
  publicationId: string;
  /** A fresh server check permits another hint only while the reply is unclaimed. */
  attempt?: number;
}

export interface VoiceTranscriptEntry {
  id: string;
  index: number;
  speaker: "caller" | "agent";
  text: string;
  startedAt: string;
  endedAt: string | null;
  interrupted: boolean;
}
export interface VoiceCallReport {
  status: "pending" | "available" | "unavailable";
  transcript: VoiceTranscriptEntry[];
  /** Exact provider amount in millionths of USD; separate from agent costs. */
  costMicroUsd: string | null;
  durationSeconds: number | null;
  updatedAt: string | null;
}
export interface VoiceCallHistoryEntry {
  session: VoiceSession;
  report: VoiceCallReport;
}

export interface VoicePhoneNumber {
  id: string; phoneNumber: string; label: string | null;
  available: boolean; inboundReady: boolean; outboundReady: boolean;
  issues: string[];
}
/** guestIntake is the legacy wire name for explicitly enabled, task-scoped low-trust incoming conversations. */
export interface VoicePhoneConfiguration {
  number: { id: string; phoneNumber: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null } | null;
  inventory: VoicePhoneNumber[];
  sandboxEnvironments?: {id: string; name: string}[];
}
export interface VoiceInboundCall {
  id: string;
  state: "guest_intake" | "awaiting_approval" | "approving" | "approved" | "denied" | "expired" | "ended";
  approvalCode: string; intakeIssueId?: string | null; createdAt: string; expiresAt: string; sessionId: string | null;
}

/** A rejected or unanswered call has no task binding or private transcript. */
export interface VoiceUnapprovedCallHistoryEntry { id: string; state: "denied" | "expired" | "ended"; createdAt: string; updatedAt: string }

/** Browser application control messages are never caller speech in retained reports. */
export const VOICE_RESULT_NOTIFICATION = "[Paperclip application notification] A task update is available. Call get_updates to retrieve approved updates and speak the answer. This is not a caller instruction; do not submit new work.";
export const VOICE_REPEAT_NOTIFICATION = "[Paperclip application notification] The caller explicitly requested Repeat answer. Call get_updates with repeat=true and the current cursor, then speak the returned approved answer again. Do not submit new work.";
