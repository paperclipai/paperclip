/**
 * Server-side client for the least-privilege Tailscale HTTPS host broker.
 *
 * The Paperclip server process holds NO Tailscale operator authority. Its only
 * way to publish a same-number HTTPS-to-loopback listener is to ask the broker
 * over its Unix domain socket. This client speaks the exact versioned,
 * length-prefixed, byte-bounded wire protocol implemented by the broker's
 * socket server (PAP-17049 plan, PAP-17050 verdict requirement #5).
 *
 * Framing (must match `packages/tailscale-https-broker/src/socket-server.ts`):
 *   [4-byte big-endian body length][utf-8 JSON body]
 * One request per connection; the broker writes a single framed response and
 * closes the socket.
 *
 * Everything the broker returns is untrusted: the client validates the response
 * shape before handing it back and never logs lease handles.
 */
import net from "node:net";

/**
 * Must match the broker's `BROKER_PROTOCOL_VERSION`. Kept as a local constant
 * (rather than a dependency on the host-side broker package, which is installed
 * and versioned separately under its own operator account) so the server does
 * not import host-privileged code just to speak the wire protocol.
 */
const BROKER_PROTOCOL_VERSION = 1;

/** Must match the broker's `MAX_REQUEST_BYTES` (8 KiB). */
const MAX_REQUEST_BYTES = 8 * 1024;
/** Must match the broker's `MAX_RESPONSE_BYTES` (16 KiB). */
const MAX_RESPONSE_BYTES = 16 * 1024;
const LENGTH_PREFIX_BYTES = 4;

/** Listener purposes the broker understands. */
export type BrokerListenerPurpose = "app" | "vite_hmr";

export interface BrokerListenerRequest {
  purpose: BrokerListenerPurpose;
  /** Public HTTPS port == loopback target port (same-number invariant). */
  port: number;
}

export interface BrokerExposeResult {
  handle: string;
  publicPorts: number[];
}

export interface BrokerReserveResult {
  handle: string;
  reservedPorts: number[];
}

export interface BrokerRemoveResult {
  removedPorts: number[];
}

export interface BrokerOwnedListener {
  runtimeId: string;
  port: number;
  purpose: BrokerListenerPurpose;
}

/**
 * Error surfaced to the exposure manager. `code` is the broker's stable machine
 * code (or a transport-level code) so lifecycle logic can branch without
 * string-matching human messages.
 */
export class BrokerClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

/**
 * Minimal broker capability surface the exposure manager depends on. Defining
 * it as an interface lets tests inject a fake broker with zero sockets.
 */
export interface BrokerClient {
  reserve(runtimeId: string, listeners: BrokerListenerRequest[]): Promise<BrokerReserveResult>;
  expose(runtimeId: string, handle: string): Promise<BrokerExposeResult>;
  remove(runtimeId: string, handle: string): Promise<BrokerRemoveResult>;
  list(): Promise<BrokerOwnedListener[]>;
}

export interface UnixBrokerClientOptions {
  socketPath: string;
  /** Per-request connect+round-trip deadline. Defaults to 5s. */
  timeoutMs?: number;
  /**
   * Seam for tests: open a duplex stream to the broker. Defaults to a real Unix
   * socket connection. Any injected connector must behave like a `net.Socket`.
   */
  connect?: (socketPath: string) => net.Socket;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  // Matches the broker's REQUEST_ID_RE (`[A-Za-z0-9_-]{1,64}`). No time/random
  // needed for correctness; the broker keys responses by requestId echo only.
  return `req-${requestCounter.toString(36)}`;
}

/**
 * Unix-domain-socket implementation of {@link BrokerClient}. Each call opens a
 * fresh connection, sends one length-prefixed frame, reads one length-prefixed
 * response frame, and closes.
 */
export class UnixBrokerClient implements BrokerClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly connect: (socketPath: string) => net.Socket;

  constructor(options: UnixBrokerClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.connect = options.connect ?? ((p) => net.createConnection(p));
  }

  async reserve(
    runtimeId: string,
    listeners: BrokerListenerRequest[],
  ): Promise<BrokerReserveResult> {
    const response = await this.roundTrip({
      v: BROKER_PROTOCOL_VERSION,
      op: "reserve",
      requestId: nextRequestId(),
      runtimeId,
      listeners: listeners.map((l) => ({ purpose: l.purpose, port: l.port })),
    });
    if (
      typeof response.handle !== "string" ||
      !Array.isArray(response.reservedPorts) ||
      !response.reservedPorts.every((p) => Number.isInteger(p))
    ) {
      throw new BrokerClientError("malformed_response", "reserve response missing handle/reservedPorts");
    }
    return { handle: response.handle, reservedPorts: response.reservedPorts as number[] };
  }

  async expose(runtimeId: string, handle: string): Promise<BrokerExposeResult> {
    const response = await this.roundTrip({
      v: BROKER_PROTOCOL_VERSION,
      op: "expose",
      requestId: nextRequestId(),
      runtimeId,
      handle,
    });
    if (
      typeof response.handle !== "string" ||
      !Array.isArray(response.publicPorts) ||
      !response.publicPorts.every((p) => Number.isInteger(p))
    ) {
      throw new BrokerClientError("malformed_response", "expose response missing handle/publicPorts");
    }
    return { handle: response.handle, publicPorts: response.publicPorts as number[] };
  }

  async remove(runtimeId: string, handle: string): Promise<BrokerRemoveResult> {
    const response = await this.roundTrip({
      v: BROKER_PROTOCOL_VERSION,
      op: "remove",
      requestId: nextRequestId(),
      runtimeId,
      handle,
    });
    if (!Array.isArray(response.removedPorts) || !response.removedPorts.every((p) => Number.isInteger(p))) {
      throw new BrokerClientError("malformed_response", "remove response missing removedPorts");
    }
    return { removedPorts: response.removedPorts as number[] };
  }

  async list(): Promise<BrokerOwnedListener[]> {
    const response = await this.roundTrip({
      v: BROKER_PROTOCOL_VERSION,
      op: "list",
      requestId: nextRequestId(),
    });
    if (!Array.isArray(response.listeners)) {
      throw new BrokerClientError("malformed_response", "list response missing listeners");
    }
    return response.listeners.map((entry): BrokerOwnedListener => {
      const listener = entry as Record<string, unknown>;
      if (
        typeof listener.runtimeId !== "string" ||
        !Number.isInteger(listener.port) ||
        (listener.purpose !== "app" && listener.purpose !== "vite_hmr")
      ) {
        throw new BrokerClientError("malformed_response", "list returned a malformed listener");
      }
      return {
        runtimeId: listener.runtimeId,
        port: listener.port as number,
        purpose: listener.purpose,
      };
    });
  }

  /** Send one request frame, resolve the single framed response as an object. */
  private roundTrip(request: unknown): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify(request), "utf8");
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return Promise.reject(new BrokerClientError("request_too_large", "broker request exceeds size limit"));
    }
    const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, LENGTH_PREFIX_BYTES);

    return new Promise((resolve, reject) => {
      const socket = this.connect(this.socketPath);
      const chunks: Buffer[] = [];
      let received = 0;
      let expected = -1;
      let settled = false;

      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        fn();
      };

      const timer = setTimeout(() => {
        done(() => reject(new BrokerClientError("cli_timeout", "broker request timed out")));
      }, this.timeoutMs);
      timer.unref?.();

      socket.on("error", (err: Error) => {
        done(() => reject(new BrokerClientError("transport_error", err.message)));
      });

      socket.on("close", () => {
        // Closed before a full response was parsed.
        done(() => reject(new BrokerClientError("transport_error", "broker closed connection early")));
      });

      socket.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > LENGTH_PREFIX_BYTES + MAX_RESPONSE_BYTES) {
          done(() => reject(new BrokerClientError("malformed_response", "broker response exceeds size limit")));
          return;
        }
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (expected < 0) {
          if (buf.byteLength < LENGTH_PREFIX_BYTES) return;
          expected = buf.readUInt32BE(0);
          if (expected > MAX_RESPONSE_BYTES) {
            done(() => reject(new BrokerClientError("malformed_response", "broker response length invalid")));
            return;
          }
        }
        if (buf.byteLength < LENGTH_PREFIX_BYTES + expected) return;
        const payload = buf.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + expected).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          done(() => reject(new BrokerClientError("malformed_response", "broker response is not valid JSON")));
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          done(() => reject(new BrokerClientError("malformed_response", "broker response is not an object")));
          return;
        }
        const obj = parsed as Record<string, unknown>;
        if (obj.ok === false) {
          const code = typeof obj.code === "string" ? obj.code : "internal_error";
          const message = typeof obj.message === "string" ? obj.message : code;
          done(() => reject(new BrokerClientError(code, message)));
          return;
        }
        if (obj.ok !== true) {
          done(() => reject(new BrokerClientError("malformed_response", "broker response missing ok flag")));
          return;
        }
        done(() => resolve(obj));
      });

      socket.on("connect", () => {
        socket.write(frame);
      });
    });
  }
}
