/**
 * Peer-credential resolution for accepted socket connections.
 *
 * Node does not expose SO_PEERCRED through a public API. The broker's primary
 * access boundary is still the OS filesystem: the socket lives in a
 * broker-owned directory and is mode 0660 owned by the dedicated socket group.
 * Every member of that group can connect, so the shipped entrypoint wires a
 * small native SO_PEERCRED reader to distinguish those peers before transport
 * admission. BrokerCore applies the service UID/GID authorization policy after
 * a request is framed.
 *
 * `createPeerResolver` returns the identity to bind leases to. A native
 * SO_PEERCRED mechanism is required and its result is the authoritative peer
 * identity. Missing or invalid credentials fail closed.
 */
import type { Socket } from "node:net";
import type { PeerCredentials } from "./types.js";

export interface PeerResolverConfig {
  /** Native SO_PEERCRED reader; returns null only when credentials are unavailable. */
  soPeercred: (socket: Socket) => PeerCredentials | null;
}

export class PeerResolutionError extends Error {}

export function createPeerResolver(config: PeerResolverConfig) {
  return (socket: Socket): PeerCredentials => {
    const native = config.soPeercred(socket);
    if (native) {
      if (![native.uid, native.gid, native.pid].every((value) => Number.isInteger(value) && value >= 0)) {
        throw new PeerResolutionError("native peer credentials are invalid");
      }
      return native;
    }
    throw new PeerResolutionError("native peer credentials are unavailable");
  };
}
