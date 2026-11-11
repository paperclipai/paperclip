import type { AgentLifecycleState } from "./types/agent-lifecycle.js";

/** JSON responses for the operator-owned Dot invitation flow. Pairing capabilities are transient. */
export interface DotBinding {
  id: string;
  status: string;
  connected: boolean;
  subscriptionVerified: boolean;
  hasPendingChallenge: boolean;
  pairingExpiresAt: string | null;
  challengeExpiresAt: string | null;
}
export interface DotInvitation {
  agent: { id: string; name: string; status: string };
  approvalId: string | null;
  binding: DotBinding | null;
}
export interface DotConnection {
  enabled: boolean;
  resourceUrl: string | null;
  agentStatus: string;
  agentLifecycleState: AgentLifecycleState;
  canConfigureConnection: boolean;
  binding: DotBinding | null;
}
export interface DotPairing { bindingId: string; pairingCode: string; expiresAt: string }
