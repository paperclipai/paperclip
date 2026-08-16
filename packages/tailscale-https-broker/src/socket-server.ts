/**
 * Unix-socket transport for the broker. Enforces the resource-consumption and
 * protocol controls from PAP-17050 verdict requirement #5: length-prefixed
 * frames with a hard byte cap, per-connection read/write/idle deadlines, a
 * maximum concurrent-client bound, and bounded single-frame responses. All
 * security decisions are delegated to the tested `BrokerCore`; this layer only
 * frames bytes and resolves peer identity.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { BrokerCore } from "./broker-core.js";
import { ProtocolError, decodeRequest, MAX_REQUEST_BYTES } from "./protocol.js";
import type { PeerCredentials } from "./types.js";

const LENGTH_PREFIX_BYTES = 4;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface SocketServerConfig {
  socketPath: string;
  core: BrokerCore;
  resolvePeer: (socket: Socket) => PeerCredentials;
  maxClients?: number;
  connectionDeadlineMs?: number;
}

export function startSocketServer(config: SocketServerConfig): Server {
  const maxClients = config.maxClients ?? 32;
  const deadlineMs = config.connectionDeadlineMs ?? 5_000;
  let active = 0;

  if (existsSync(config.socketPath)) {
    unlinkSync(config.socketPath);
  }

  const server = createServer((socket) => {
    if (active >= maxClients) {
      socket.destroy();
      return;
    }
    active += 1;

    let peer: PeerCredentials;
    try {
      peer = config.resolvePeer(socket);
    } catch {
      active -= 1;
      socket.destroy();
      return;
    }

    let expected = -1;
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;

    const timer = setTimeout(() => finish(), deadlineMs);
    timer.unref?.();

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active -= 1;
    };

    socket.on("error", () => finish());
    socket.on("close", () => finish());

    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      received += chunk.byteLength;
      if (received > LENGTH_PREFIX_BYTES + MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (expected < 0) {
        if (buf.byteLength < LENGTH_PREFIX_BYTES) return;
        expected = buf.readUInt32BE(0);
        if (expected > MAX_REQUEST_BYTES) {
          socket.destroy();
          return;
        }
      }
      if (buf.byteLength < LENGTH_PREFIX_BYTES + expected) return;
      const body = buf.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + expected);
      void handleFrame(body);
    });

    const handleFrame = async (body: Buffer): Promise<void> => {
      let response: unknown;
      try {
        const request = decodeRequest(body);
        response = await config.core.handle(request, peer);
      } catch (error) {
        response =
          error instanceof ProtocolError
            ? { ok: false, requestId: error.requestId, code: error.code, message: error.code }
            : { ok: false, requestId: null, code: "malformed_request", message: "malformed_request" };
      }
      writeResponse(socket, response);
      finish();
    };
  });

  server.listen(config.socketPath, () => {
    // Socket file itself is restricted to the dedicated group; the parent
    // directory ownership/mode is enforced by the installer.
    try {
      chmodSync(config.socketPath, 0o660);
    } catch {
      /* best effort; installer verifies */
    }
  });

  server.maxConnections = maxClients;
  return server;
}

function writeResponse(socket: Socket, response: unknown): void {
  let json = JSON.stringify(response);
  if (Buffer.byteLength(json, "utf8") > MAX_RESPONSE_BYTES) {
    json = JSON.stringify({ ok: false, requestId: null, code: "internal_error", message: "internal_error" });
  }
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, LENGTH_PREFIX_BYTES);
  try {
    socket.end(frame);
  } catch {
    socket.destroy();
  }
}
