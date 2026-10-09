/**
 * Unix-socket transport for the broker. Enforces the resource-consumption and
 * protocol controls from PAP-17050 verdict requirement #5: length-prefixed
 * frames with a hard byte cap, per-connection read/write/idle deadlines, a
 * maximum concurrent-client bound, a per-UID client bound, reserved capacity
 * for the Paperclip service UID, and bounded single-frame responses. All
 * security decisions are delegated to the tested `BrokerCore`; this layer
 * frames bytes, resolves peer identity, and bounds transport resource usage.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { BrokerCore } from "./broker-core.js";
import { ProtocolError, decodeRequest, MAX_REQUEST_BYTES } from "./protocol.js";
import type { PeerCredentials } from "./types.js";

const LENGTH_PREFIX_BYTES = 4;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_MAX_CLIENTS = 32;
const DEFAULT_MAX_CLIENTS_PER_UID = 8;
const DEFAULT_RESERVED_SERVICE_CLIENTS = 4;

export interface SocketServerConfig {
  socketPath: string;
  core: BrokerCore;
  resolvePeer: (socket: Socket) => PeerCredentials;
  serviceUid: number;
  maxClients?: number;
  maxClientsPerUid?: number;
  reservedServiceClients?: number;
  connectionDeadlineMs?: number;
}

export interface ClientAdmissionConfig {
  maxClients: number;
  maxClientsPerUid: number;
  serviceUid: number;
  reservedServiceClients: number;
}

/**
 * Tracks admitted sockets by resolved UID. Non-service peers cannot consume
 * the service reservation, and no UID can monopolize the global pool.
 */
export class ClientAdmissionController {
  private active = 0;
  private readonly activeByUid = new Map<number, number>();

  constructor(private readonly config: ClientAdmissionConfig) {
    assertPositiveInteger(config.maxClients, "maxClients");
    assertPositiveInteger(config.maxClientsPerUid, "maxClientsPerUid");
    assertNonNegativeInteger(config.serviceUid, "serviceUid");
    assertNonNegativeInteger(config.reservedServiceClients, "reservedServiceClients");
    if (config.maxClientsPerUid > config.maxClients) {
      throw new Error("maxClientsPerUid must not exceed maxClients");
    }
    if (config.reservedServiceClients >= config.maxClients) {
      throw new Error("reservedServiceClients must be less than maxClients");
    }
  }

  tryAcquire(uid: number): boolean {
    if (!Number.isInteger(uid) || uid < 0) return false;
    const activeForUid = this.activeByUid.get(uid) ?? 0;
    if (activeForUid >= this.config.maxClientsPerUid || this.active >= this.config.maxClients) {
      return false;
    }
    const nonServiceLimit = this.config.maxClients - this.config.reservedServiceClients;
    if (uid !== this.config.serviceUid && this.active >= nonServiceLimit) {
      return false;
    }
    this.active += 1;
    this.activeByUid.set(uid, activeForUid + 1);
    return true;
  }

  release(uid: number): void {
    const activeForUid = this.activeByUid.get(uid) ?? 0;
    if (activeForUid <= 0) return;
    this.active -= 1;
    if (activeForUid === 1) {
      this.activeByUid.delete(uid);
    } else {
      this.activeByUid.set(uid, activeForUid - 1);
    }
  }
}

export function startSocketServer(config: SocketServerConfig): Server {
  const maxClients = config.maxClients ?? DEFAULT_MAX_CLIENTS;
  const admission = new ClientAdmissionController({
    maxClients,
    maxClientsPerUid: config.maxClientsPerUid ?? Math.min(DEFAULT_MAX_CLIENTS_PER_UID, maxClients),
    serviceUid: config.serviceUid,
    reservedServiceClients:
      config.reservedServiceClients ?? Math.min(DEFAULT_RESERVED_SERVICE_CLIENTS, maxClients - 1),
  });
  const deadlineMs = config.connectionDeadlineMs ?? 5_000;

  if (existsSync(config.socketPath)) {
    unlinkSync(config.socketPath);
  }

  const server = createServer((socket) => {
    let peer: PeerCredentials;
    try {
      peer = config.resolvePeer(socket);
    } catch {
      socket.destroy();
      return;
    }
    if (!admission.tryAcquire(peer.uid)) {
      socket.destroy();
      return;
    }

    let expected = -1;
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    let released = false;

    const timer = setTimeout(() => socket.destroy(), deadlineMs);
    timer.unref?.();

    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      admission.release(peer.uid);
    };

    // Keep the admission slot until the kernel reports the socket closed. An
    // error can precede `close`, so releasing here would briefly undercount
    // live descriptors during an error storm.
    socket.on("error", () => socket.destroy());
    socket.on("close", release);

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
      // Claim the connection before awaiting BrokerCore so trailing data cannot
      // dispatch the same frame more than once.
      done = true;
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

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
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
