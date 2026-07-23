import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const PEER_ENTITY_MAX_LIMIT = 100;

export interface PeerEntityAccessResult {
  allowed: boolean;
  reason: "allowed" | "denied";
}

/**
 * Checks whether a consumer plugin is permitted to read a specific entity
 * type from a provider plugin.
 *
 * Access is allowed iff:
 *   - provider manifest has peerReads.allow with an entry for entityType
 *   - consumerPluginKey appears in that entry's consumers array
 *
 * All failures return reason "denied" — callers must not distinguish between
 * "not found" and "not authorized" in API responses (no information leakage).
 */
export function checkPeerEntityAccess(
  consumerPluginKey: string,
  providerManifest: PaperclipPluginManifestV1,
  entityType: string,
): PeerEntityAccessResult {
  const peerReads = providerManifest.peerReads;
  if (!peerReads || !peerReads.allow || peerReads.allow.length === 0) {
    return { allowed: false, reason: "denied" };
  }

  const entry = peerReads.allow.find((e) => e.entityType === entityType);
  if (!entry) {
    return { allowed: false, reason: "denied" };
  }

  if (!entry.consumers.includes(consumerPluginKey)) {
    return { allowed: false, reason: "denied" };
  }

  return { allowed: true, reason: "allowed" };
}
