/**
 * Peer authorization and lease-handle ownership (PAP-17050 verdict req #1).
 *
 * SO_PEERCRED authenticates an OS principal; a caller-supplied runtime ID does
 * NOT prove ownership. Authorization therefore has two layers:
 *   1. An exact UID/GID allowlist checked with peer credentials on EVERY
 *      accepted connection (complete mediation).
 *   2. Ownership defined as a broker-issued, unguessable lease handle returned
 *      by `expose` and required by `remove`, bound to peer identity, runtime
 *      UUID, ports, and generation. `list` never returns handles.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { LeaseRecord, PeerCredentials } from "./types.js";

export interface PeerPolicy {
  /** Exact set of allowed peer UIDs (the Paperclip service identity). */
  allowedUids: ReadonlySet<number>;
  /** Exact set of allowed peer GIDs (the dedicated broker socket group). */
  allowedGids: ReadonlySet<number>;
}

export class AuthorizationError extends Error {
  constructor(
    readonly code:
      | "unauthorized_peer"
      | "invalid_handle"
      | "listener_ownership_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Complete-mediation check run on every accepted connection before any request
 * is even decoded. Throws AuthorizationError("unauthorized_peer") on any
 * mismatch. Supplemental-group-only membership does not satisfy the GID check
 * because peer.gid is the process's primary GID from SO_PEERCRED.
 */
export function authorizePeer(peer: PeerCredentials, policy: PeerPolicy): void {
  if (!Number.isInteger(peer.uid) || !Number.isInteger(peer.gid)) {
    throw new AuthorizationError("unauthorized_peer", "missing peer credentials");
  }
  if (!policy.allowedUids.has(peer.uid)) {
    throw new AuthorizationError("unauthorized_peer", `uid ${peer.uid} not allowlisted`);
  }
  if (!policy.allowedGids.has(peer.gid)) {
    throw new AuthorizationError("unauthorized_peer", `gid ${peer.gid} not allowlisted`);
  }
}

/** Generate an unguessable lease handle (256 bits, url-safe). */
export function generateLeaseHandle(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time handle comparison to avoid timing oracles. */
export function handlesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the lease a `remove` request is authorized to act on. Requires an
 * exact handle match AND that the requesting peer + runtime UUID match the
 * lease bound at expose time. Runtime A can never remove runtime B's listener.
 */
export function authorizeRemoval(
  leases: readonly LeaseRecord[],
  request: { runtimeId: string; handle: string },
  peer: PeerCredentials,
): LeaseRecord {
  const lease = leases.find((entry) => handlesEqual(entry.handle, request.handle));
  if (!lease) {
    throw new AuthorizationError("invalid_handle", "unknown or stale lease handle");
  }
  if (lease.runtimeId !== request.runtimeId) {
    throw new AuthorizationError("listener_ownership_mismatch", "runtime id does not match lease");
  }
  if (lease.peerUid !== peer.uid || lease.peerGid !== peer.gid) {
    throw new AuthorizationError("listener_ownership_mismatch", "peer identity does not match lease");
  }
  return lease;
}
