/**
 * Peer-credential resolution for accepted socket connections.
 *
 * Node does not expose SO_PEERCRED through a public API. The broker's PRIMARY
 * access boundary is therefore the OS filesystem: the socket lives in a
 * broker-owned directory and is mode 0660 owned by the dedicated socket group, so
 * only the allowlisted Paperclip service identity can `connect()` at all (this
 * is exactly the dedicated-socket-group control in PAP-17050 verdict req #1).
 *
 * `createPeerResolver` returns the identity to bind leases to. If a native
 * SO_PEERCRED mechanism is wired via `soPeercred`, it is used and its result is
 * cross-checked against the allowlist. Otherwise the resolver falls back to the
 * configured, OS-enforced identity — but ONLY when the operator has asserted
 * the socket is protected by the dedicated group (`trustSocketPermissions`).
 * With neither, it fails closed (connection refused).
 */
import type { Socket } from "node:net";
import type { PeerCredentials } from "./types.js";

export interface PeerResolverConfig {
  /** The single OS identity the socket permissions restrict connections to. */
  serviceUid: number;
  serviceGid: number;
  /** Operator assertion that the socket is 0660 and dedicated-group-owned. */
  trustSocketPermissions: boolean;
  /** Optional native SO_PEERCRED reader; returns null if unavailable. */
  soPeercred?: (socket: Socket) => PeerCredentials | null;
}

export class PeerResolutionError extends Error {}

export function createPeerResolver(config: PeerResolverConfig) {
  return (socket: Socket): PeerCredentials => {
    const native = config.soPeercred?.(socket) ?? null;
    if (native) {
      // Defense in depth: even with a native reader, the OS-enforced identity
      // must match what we expect.
      if (native.uid !== config.serviceUid || native.gid !== config.serviceGid) {
        throw new PeerResolutionError("peer credentials do not match the service identity");
      }
      return native;
    }
    if (config.trustSocketPermissions) {
      return { uid: config.serviceUid, gid: config.serviceGid, pid: 0 };
    }
    throw new PeerResolutionError(
      "no peer-credential mechanism available and socket-permission trust not asserted",
    );
  };
}
