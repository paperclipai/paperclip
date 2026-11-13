import { MUSE_ASSET_VERSION, MUSE_CLIENT_VERSION, type MuseBinding, type MuseConnection, type MusePairing, type MuseStopBoundary } from "@paperclipai/shared";

/** Public, nonsecret fixture values only; the .example origin cannot connect a real Muse. */
export const museBinding: MuseBinding = {
  id: "11111111-1111-4111-8111-111111111111", generation: 2, revision: 7, status: "connected",
  paired: true, receiverDetected: true, backgroundReplyVerified: false,
  pairingExpiresAt: null, challengeExpiresAt: null,
  lastReceiverContactAt: "2026-10-13T14:00:00Z", lastWorkerActivityAt: "2026-10-13T13:59:40Z", lastVerifiedReplyAt: null,
  credentialState: "active", refreshExpiresAt: "2026-11-12T14:00:00Z",
  receiverContactTrust: "public_untrusted", contactPersistenceLagMs: 30000, clientVersion: MUSE_CLIENT_VERSION, qualification: null,
  liveAssignments: 0, uncertainOperations: 0, pendingInputs: 0,
  cleanup: { authenticatedAfterRevocation: false, pending: false, detectorRemovalRequested: false, detectorRemoved: false, workerQuiescenceReported: false, expiresAt: null },
  stop: { status: "none", nativeEffectsUnknown: false, boundary: null, bindingRevision: null },
};
export const museConnection: MuseConnection = {
  enabled: true, publicOrigin: "https://paperclip.example", agentStatus: "idle", agentLifecycleState: "verifying",
  canConfigureConnection: true, binding: museBinding, usage: null, cost: null,
};
export const musePairing: MusePairing = {
  bindingId: museBinding.id, generation: museBinding.generation, revision: museBinding.revision,
  ticket: "STORYBOOK-NOT-A-REAL-TICKET", expiresAt: "2099-10-10T14:10:00Z", assetVersion: MUSE_ASSET_VERSION,
  setupInstruction: `Storybook illustration only. The .example hostname, scope IDs, and ticket are public fixture values, not credentials. This example cannot connect a real agent or grant task authority.

Production setup connects the exact company, agent, and binding through Muse's supported SecureVault/authd OAuth consent. credentials.request_api_access uses oauth2_code, public-client registration and S256 PKCE; the single-use setup ticket is carried only into the OAuth authorization URL. Authd stores credentials and refreshes them automatically. The asset ${MUSE_ASSET_VERSION} client uses the supported dynamic_credentials surrogate helper. Never copy access/refresh tokens into files or environment variables.

After consent, install the immutable asset ${MUSE_ASSET_VERSION} client, detector and instructions using their pinned production manifest. Configure only the operator-approved nonsecret company/agent/binding scope. Complete Muse's actual site and tool permission prompts; public preflight grants no task authority. Verify authenticated scoped status before registering the five-second public detector and the discoverable standing-delegation skill.

In production, the operator's scoped installation delegates receiving, validating and autonomously accepting ordinary tasks for that exact company, agent and binding, including later detector wakes and fresh conversations. Task text cannot expand the delegation. Observe the exact native accepted lease before any task effect; Muse's private tool, site, safety and approval gates remain in force.

Public receiver contact is untrusted and may take up to 30 seconds to persist. Only an independent authenticated background reply and the agent lifecycle gate establish readiness. Disconnect immediately revokes OAuth authority; post-revocation authenticated cleanup is unavailable, and detector removal, worker stopping and unknown effects remain unconfirmed.`,
};
export const museStopBoundary: MuseStopBoundary = {
  bindingId: museBinding.id, generation: museBinding.generation,
  assignmentId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333",
  turnId: "turn-muse-example", assignmentRevision: 3, stopNonce: "44444444-4444-4444-8444-444444444444", operationBoundary: "task-document-save",
};
export const stoppedMuseConnection: MuseConnection = { ...museConnection, enabled: false, agentStatus: "paused", agentLifecycleState: "paused",
  binding: { ...museBinding, status: "revoked", credentialState: "revoked", refreshExpiresAt: null, liveAssignments: 0, uncertainOperations: 1, pendingInputs: 1,
    cleanup: { authenticatedAfterRevocation: false, pending: true, detectorRemovalRequested: false, detectorRemoved: false, workerQuiescenceReported: false, expiresAt: null },
    stop: { status: "cannot_confirm", nativeEffectsUnknown: true, boundary: museStopBoundary, bindingRevision: museBinding.revision } } };

/** Each play/render gets its own gate; simulated progress follows observed copy feedback. */
export function createMuseCopyFeedbackGate() {
  let feedbackObserved!: () => void;
  const feedback = new Promise<void>(resolve => { feedbackObserved = resolve; });
  return { waitForFeedback: () => feedback, feedbackObserved };
}
