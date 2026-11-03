import { z } from "zod";
import type { AgentLifecycleState } from "./types/agent-lifecycle.js";
import type { MuseStopBoundary } from "./muse-protocol.js";

/** Only transient pairing responses contain the ticket/setup instruction. */
export interface MuseBinding {
  id: string; generation: number; revision: number;
  status: "pairing" | "connected" | "ready" | "revoked";
  paired: boolean; receiverDetected: boolean; backgroundReplyVerified: boolean;
  pairingExpiresAt: string | null; challengeExpiresAt: string | null;
  lastReceiverContactAt: string | null; lastWorkerActivityAt: string | null; lastVerifiedReplyAt: string | null;
  credentialState: "pending" | "active" | "expired" | "revoked"; refreshExpiresAt: string | null;
  receiverContactTrust: "public_untrusted"; contactPersistenceLagMs: number; clientVersion: string | null;
  qualification: { id: string; expiresAt: string } | null;
  liveAssignments: number; uncertainOperations: number; pendingInputs: number;
  cleanup: { detectorEvidence?: MuseDetectorCleanupEvidence | null; attestationEligible?: boolean; hookScript?: string; authenticatedAfterRevocation?: boolean; pending: boolean; detectorRemovalRequested?: boolean; detectorRemoved: boolean; workerQuiescenceReported: boolean; expiresAt: string | null };
  stop: { status: "none" | "cannot_confirm" | "worker_reported" | "operator_attested"; nativeEffectsUnknown: boolean; boundary: MuseStopBoundary | null; bindingRevision: number | null };
}
export interface MuseInvitation { agent: { id: string; name: string; status: string }; approvalId: string | null; binding: MuseBinding | null }
export interface MuseConnection {
  enabled: boolean; publicOrigin: string | null; agentStatus: string; agentLifecycleState: AgentLifecycleState;
  canConfigureConnection: boolean; binding: MuseBinding | null; usage: null; cost: null;
}
export interface MusePairing {
  bindingId: string; generation: number; revision: number; ticket: string; expiresAt: string;
  setupInstruction: string; assetVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}
export interface MuseVerifyResult { bindingId: string; generation: number; revision: number; expiresAt: string; status: "pending" }
export interface MuseInvitationInput { name: string; role: string }
export interface MusePairingInput { replaceBindingId?: string; expectedRevision?: number }
export interface MuseVerifyInput { bindingId: string; generation: number; expectedRevision: number }
export interface MuseRevokeInput extends MuseVerifyInput {}
export const museDetectorCleanupAttestationSchema = z.object({
  bindingId: z.uuid(), generation: z.number().int().positive(), expectedRevision: z.number().int().positive(),
  qualificationId: z.uuid().nullable(), hookScript: z.string().min(1).max(160), detectorRemoved: z.literal(true),
  observation: z.object({ method: z.literal("hooks.list"), includeDisabled: z.literal(true), hookId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), outcome: z.literal("exact_hook_absent"),
    observedAt: z.iso.datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export type MuseDetectorCleanupAttestationInput = z.infer<typeof museDetectorCleanupAttestationSchema>;
export interface MuseDetectorCleanupEvidence {
  bindingId: string; generation: number; qualificationId: string | null; hookScript: string;
  source: "authenticated_worker_report" | "operator_runtime_attestation";
  recordedAt: string; observedAt: string; operatorId: string | null; hookId: string | null;
}
export interface MuseAttestStopInput { boundary: MuseStopBoundary; expectedRevision: number; workerStopped: true }

export interface MuseQualificationBeginResult { qualificationId: string; startedAt: string; expiresAt: string; revision: number }
export interface MuseQualificationEvidence {
  qualificationId: string; startedAt: string; expiresAt: string; stoppedAt: string | null; deadlineEnforcedAt: string | null;
  detectorCleanup?: MuseDetectorCleanupEvidence | null;
  authorityRevoked: boolean; persistenceLagMs: number; cadenceEvidenceComplete: boolean;
  contacts: Array<{ trust: "public_untrusted"; replicaId: string; bucketAt: string; firstAt: string; lastAt: string; contacts: number; gapsAtMostSevenSeconds: number; maxGapMs: number; timestamps: string[]; incomplete: boolean }>;
  assignments: Array<{ id: string; runId: string; issueId: string | null; status: string; offeredAt: string; claimedAt: string | null; nativeAcceptedAt: string | null; acceptedResultAt: string | null; finalizedAt: string | null }>;
  idleWindows: Array<{ startedAt: string; endedAt: string }>;
}
