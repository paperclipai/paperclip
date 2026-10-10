import type { MuseBinding, MuseConnection, MusePairing, MuseStopBoundary } from "@paperclipai/shared";

/** Non-routable examples only. No private Muse identity or installation is used. */
export const museBinding: MuseBinding = {
  id: "11111111-1111-4111-8111-111111111111", generation: 2, revision: 7, status: "connected",
  paired: true, receiverDetected: true, backgroundReplyVerified: false,
  pairingExpiresAt: null, challengeExpiresAt: null,
  lastReceiverContactAt: "2026-10-10T14:00:00Z", lastWorkerActivityAt: "2026-10-10T13:59:40Z", lastVerifiedReplyAt: null,
  contactPersistenceLagMs: 10000, clientVersion: "1", qualification: null,
  liveAssignments: 0, uncertainOperations: 0, pendingInputs: 0,
  cleanup: { pending: false, detectorRemoved: false, workerQuiescenceReported: false, expiresAt: null },
  stop: { status: "none", nativeEffectsUnknown: false, boundary: null },
};
export const museConnection: MuseConnection = {
  enabled: true, publicOrigin: "https://paperclip.example", agentStatus: "idle", agentLifecycleState: "verifying",
  canConfigureConnection: true, binding: museBinding, usage: null, cost: null,
};
export const musePairing: MusePairing = {
  bindingId: museBinding.id, generation: museBinding.generation, revision: museBinding.revision,
  ticket: "STORYBOOK-NOT-A-REAL-TICKET", expiresAt: "2099-10-10T14:10:00Z", assetVersion: 1,
  setupInstruction: "Storybook setup example only. Connect company Paperclip and agent Maia at https://paperclip.example. One-use ticket: STORYBOOK-NOT-A-REAL-TICKET. Approve the hostname in Muse’s own permission UI. Install the versioned client and managed detector using the published manifest. This example cannot connect a real agent.",
};
export const museStopBoundary: MuseStopBoundary = {
  bindingId: museBinding.id, generation: museBinding.generation,
  assignmentId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333",
  turnId: "turn-muse-example", assignmentRevision: 3, stopNonce: "44444444-4444-4444-8444-444444444444", operationBoundary: "task-document-save",
};
export const stoppedMuseConnection: MuseConnection = { ...museConnection, enabled: false, agentStatus: "paused", agentLifecycleState: "paused",
  binding: { ...museBinding, status: "revoked", liveAssignments: 1, uncertainOperations: 1, pendingInputs: 1,
    cleanup: { pending: true, detectorRemoved: true, workerQuiescenceReported: false, expiresAt: "2026-10-11T14:00:00Z" },
    stop: { status: "cannot_confirm", nativeEffectsUnknown: true, boundary: museStopBoundary } } };
