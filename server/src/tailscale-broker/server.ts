/**
 * Unix-socket front end for the broker.
 *
 * The socket is a privilege boundary (threat-model verdict #1). Enforcement is
 * layered:
 *   1. Filesystem: a broker-owned, non-world-writable parent directory and a
 *      `0660` socket owned by the broker and the Paperclip service group. Only
 *      members of that group can open the socket. Startup refuses to run if the
 *      parent directory is missing, a symlink, or writable by others.
 *   2. Peer credentials: a {@link PeerCredentialReader} supplies the connecting
 *      peer's uid/gid so the broker can apply its uid/gid allowlist per request.
 *      Node has no public SO_PEERCRED API, so production uses a small N-API
 *      bridge and fails closed when the kernel credentials are unavailable.
 *   3. Protocol: one length-bounded request per connection, hard read deadline,
 *      and a cap on concurrent connections (verdict #5).
 */

import net from "node:net";
import { chmodSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Broker, PeerIdentity } from "./broker.js";
import { MAX_FRAME_BYTES, ProtocolError, decodeRequestFrame, encodeResponse } from "./protocol.js";

export interface PeerCredentialReader {
  read(socket: net.Socket): PeerIdentity | null;
}

export interface BrokerServerOptions {
  socketPath: string;
  broker: Broker;
  peerReader: PeerCredentialReader;
  maxConnections?: number;
  readTimeoutMs?: number;
  /** Injectable logger; defaults to console.error. */
  onError?: (message: string) => void;
  /** Production uses this to terminate when bind or socket setup fails. */
  onFatal?: (error: Error) => void;
}

interface NativePeercredBinding {
  getPeerCredentials(fd: number): PeerIdentity;
}

interface SocketWithHandle extends net.Socket {
  _handle?: { fd?: unknown };
}

/**
 * Refuse to start unless the socket's parent directory is a real directory
 * (not a symlink) and is not writable by group/other. This blocks socket
 * replacement / symlink attacks and writable-parent misconfiguration.
 */
export function assertSafeSocketParent(socketPath: string, stat: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number } ): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`broker socket parent directory is a symlink; refusing to start`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`broker socket parent is not a directory; refusing to start`);
  }
  // Reject group- or world-writable parents (unless sticky, which we do not rely on).
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`broker socket parent directory is group/world-writable (mode ${(stat.mode & 0o777).toString(8)}); refusing to start`);
  }
}

export function startBrokerServer(options: BrokerServerOptions): net.Server {
  const onError = options.onError ?? ((m) => console.error(m));
  const parent = path.dirname(options.socketPath);
  const parentStat = lstatSync(parent);
  assertSafeSocketParent(options.socketPath, parentStat);

  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = options.maxConnections ?? 32;

  server.on("connection", (socket) => {
    let peer: PeerIdentity | null = null;
    let received = 0;
    const chunks: Buffer[] = [];
    let finished = false;

    const finish = (payload: Buffer) => {
      if (finished) return;
      finished = true;
      socket.end(payload);
    };
    const fail = (code: string, message: string) => {
      finish(encodeResponse({ ok: false, code, message }));
    };

    try {
      peer = options.peerReader.read(socket);
    } catch (err) {
      onError(`could not read broker peer credentials: ${(err as Error).message}`);
    }

    const timer = setTimeout(() => fail("read_timeout", "request read deadline exceeded"), options.readTimeoutMs ?? 5_000);
    timer.unref?.();

    if (!peer) {
      clearTimeout(timer);
      fail("no_peer_credentials", "could not determine peer credentials");
      return;
    }

    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_FRAME_BYTES) {
        clearTimeout(timer);
        fail("frame_too_large", "request exceeded frame limit");
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return; // wait for full line
      clearTimeout(timer);
      void handleFrame(buf.subarray(0, nl + 1));
    });

    socket.on("error", () => {
      clearTimeout(timer);
    });

    const handleFrame = async (frame: Buffer) => {
      try {
        const request = decodeRequestFrame(frame);
        const response = await options.broker.handle(request, peer);
        finish(encodeResponse(response));
      } catch (err) {
        if (err instanceof ProtocolError) {
          fail(err.code, err.message);
        } else {
          onError(`broker request error: ${(err as Error).message}`);
          fail("internal_error", "request failed");
        }
      }
    };
  });

  server.on("error", (err) => {
    onError(`broker server error: ${err.message}`);
    if (!server.listening) options.onFatal?.(err);
  });
  server.listen(options.socketPath, () => {
    try {
      chmodSync(options.socketPath, 0o660);
    } catch (err) {
      const socketError = err as Error;
      onError(`could not chmod broker socket: ${socketError.message}`);
      server.close();
      options.onFatal?.(socketError);
    }
  });
  return server;
}

function loadNativePeercredBinding(): NativePeercredBinding {
  if (process.platform !== "linux") {
    throw new Error("native SO_PEERCRED is supported only on Linux");
  }
  const require = createRequire(import.meta.url);
  return require("./peercred-native.node") as NativePeercredBinding;
}

/** Read the authoritative uid, gid, and pid from Linux SO_PEERCRED. */
export function createNativePeerCredentialReader(
  loadBinding: () => NativePeercredBinding = loadNativePeercredBinding,
): PeerCredentialReader {
  const binding = loadBinding();
  return {
    read(socket): PeerIdentity | null {
      const fd = (socket as SocketWithHandle)._handle?.fd;
      if (!Number.isInteger(fd) || (fd as number) < 0) return null;
      const peer = binding.getPeerCredentials(fd as number);
      if (
        !Number.isSafeInteger(peer.uid) ||
        peer.uid < 0 ||
        !Number.isSafeInteger(peer.gid) ||
        peer.gid < 0 ||
        !Number.isSafeInteger(peer.pid) ||
        (peer.pid ?? -1) < 0
      ) {
        return null;
      }
      return peer;
    },
  };
}
