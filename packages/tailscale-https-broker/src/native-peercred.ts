/**
 * Linux SO_PEERCRED bridge.
 *
 * Node's public net.Socket API does not expose peer credentials. The package
 * build compiles a dependency-free N-API addon next to this module's emitted
 * JavaScript. The native call is synchronous and runs once per accepted local
 * socket, before the connection enters the admission pool.
 */
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { PeerCredentials } from "./types.js";

interface NativePeercredBinding {
  getPeerCredentials(fd: number): PeerCredentials;
}

interface SocketWithHandle extends Socket {
  _handle?: { fd?: unknown };
}

export function createNativePeerCredentialReader(): (socket: Socket) => PeerCredentials {
  if (process.platform !== "linux") {
    throw new Error("native SO_PEERCRED is supported only on Linux");
  }

  const require = createRequire(import.meta.url);
  const binding = require("./peercred-native.node") as NativePeercredBinding;

  return (socket: Socket): PeerCredentials => {
    const fd = (socket as SocketWithHandle)._handle?.fd;
    if (!Number.isInteger(fd) || (fd as number) < 0) {
      throw new Error("accepted socket has no valid file descriptor");
    }
    return binding.getPeerCredentials(fd as number);
  };
}
