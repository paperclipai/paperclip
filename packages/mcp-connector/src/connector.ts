import WebSocket from "ws";
import {
  MCP_CONNECTOR_CLOSE_CODES,
  MCP_CONNECTOR_ENROLL_PATH,
  MCP_CONNECTOR_MAX_FRAME_BYTES,
  MCP_CONNECTOR_MAX_IN_FLIGHT_REQUESTS,
  MCP_CONNECTOR_PROTOCOL_VERSION,
  MCP_CONNECTOR_ROTATE_PATH,
  MCP_CONNECTOR_WS_PATH,
  parseMcpConnectorServerFrame,
  type McpConnectorHelloFrame,
} from "@paperclipai/shared/mcp-connector-protocol";
import type { ConnectorConfig } from "./config.js";
import { readCredentials, writeCredentials, type StoredCredentials } from "./credentials.js";
import { relayRequest, type RelayOptions } from "./relay.js";

export const CONNECTOR_VERSION = "0.1.0";

export type ConnectorLogger = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

/** Structured stderr logging. Never logs headers, bodies, tokens or upstream URLs. */
export const defaultLogger: ConnectorLogger = (level, message, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
};

export class ConnectorFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorFatalError";
  }
}

export interface ConnectorOptions {
  config: ConnectorConfig;
  logger?: ConnectorLogger;
  fetch?: typeof fetch;
  relay?: RelayOptions;
  /** Reconnect backoff bounds (ms). Full jitter is applied. */
  backoff?: { baseMs: number; maxMs: number };
  random?: () => number;
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^attempt)]. */
export function reconnectDelay(attempt: number, bounds: { baseMs: number; maxMs: number }, random = Math.random): number {
  const ceiling = Math.min(bounds.maxMs, bounds.baseMs * 2 ** Math.min(attempt, 20));
  return Math.max(bounds.baseMs / 2, Math.floor(random() * ceiling));
}

function wsUrl(paperclipUrl: string): string {
  const url = new URL(MCP_CONNECTOR_WS_PATH, `${paperclipUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class McpConnectorClient {
  private readonly config: ConnectorConfig;
  private readonly log: ConnectorLogger;
  private readonly doFetch: typeof fetch;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly random: () => number;
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, AbortController>();
  private credentials: StoredCredentials | null = null;
  private onFatal: ((error: Error) => void) | null = null;
  private onWelcome: (() => void) | null = null;

  constructor(private readonly options: ConnectorOptions) {
    this.config = options.config;
    this.log = options.logger ?? defaultLogger;
    this.doFetch = options.fetch ?? fetch;
    this.backoff = options.backoff ?? { baseMs: 1_000, maxMs: 60_000 };
    this.random = options.random ?? Math.random;
  }

  get connectorId(): string | null {
    return this.credentials?.connectorId ?? null;
  }

  /**
   * Load stored credentials, or exchange the one-time enrollment token for a
   * long-lived credential and store it (mode 0600).
   */
  async ensureCredentials(): Promise<StoredCredentials> {
    const stored = readCredentials(this.config.credentialsFile);
    if (stored && stored.paperclipUrl === this.config.paperclipUrl) {
      if (this.config.enrollmentToken) {
        this.log("info", "stored credentials found; ignoring enrollment token", { connectorId: stored.connectorId });
      }
      this.credentials = stored;
      return stored;
    }
    if (!this.config.enrollmentToken) {
      throw new ConnectorFatalError(
        "No stored credentials for this Paperclip URL. Set PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN from Tools & Access to enroll.",
      );
    }
    const response = await this.doFetch(new URL(MCP_CONNECTOR_ENROLL_PATH, `${this.config.paperclipUrl}/`), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: this.config.enrollmentToken, version: CONNECTOR_VERSION }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorFatalError(
        `Enrollment failed with HTTP ${response.status}. The token may be expired, already used or revoked; create a new one in Tools & Access.`,
      );
    }
    const result = await response.json() as { connectorId?: unknown; companyId?: unknown; credential?: unknown };
    if (typeof result.connectorId !== "string" || typeof result.companyId !== "string" || typeof result.credential !== "string") {
      throw new ConnectorFatalError("Enrollment returned an invalid response");
    }
    const credentials: StoredCredentials = {
      paperclipUrl: this.config.paperclipUrl,
      connectorId: result.connectorId,
      companyId: result.companyId,
      credential: result.credential,
    };
    writeCredentials(this.config.credentialsFile, credentials);
    this.credentials = credentials;
    this.log("info", "enrolled", { connectorId: credentials.connectorId, companyId: credentials.companyId });
    return credentials;
  }

  /** Replace the long-lived credential. The old one stops working when Paperclip answers. */
  async rotateCredential(): Promise<void> {
    const current = this.credentials ?? await this.ensureCredentials();
    const response = await this.doFetch(new URL(MCP_CONNECTOR_ROTATE_PATH, `${this.config.paperclipUrl}/`), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${current.credential}` },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorFatalError(`Credential rotation failed with HTTP ${response.status}`);
    }
    const result = await response.json() as { credential?: unknown };
    if (typeof result.credential !== "string") throw new ConnectorFatalError("Rotation returned an invalid response");
    const next = { ...current, credential: result.credential };
    writeCredentials(this.config.credentialsFile, next);
    this.credentials = next;
    this.log("info", "credential rotated", { connectorId: current.connectorId });
  }

  /**
   * Connect and keep reconnecting until `stop()` or a fatal condition
   * (revoked / credential rejected). Resolves on stop, rejects on fatal.
   */
  run(hooks: { onWelcome?: () => void } = {}): Promise<void> {
    this.onWelcome = hooks.onWelcome ?? null;
    return new Promise<void>((resolve, reject) => {
      this.onFatal = (error) => {
        // Reject, not resolve: a fatal stop must surface to the caller.
        this.stoppedResolve = null;
        this.stop();
        reject(error);
      };
      this.stoppedResolve = resolve;
      void this.ensureCredentials().then(() => this.connect(), (error) => this.onFatal?.(error));
    });
  }

  private stoppedResolve: (() => void) | null = null;

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.socket?.close(1000, "connector stopping");
    this.socket = null;
    this.stoppedResolve?.();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = reconnectDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.log("warn", "disconnected; reconnecting", { delayMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private connect() {
    if (this.stopped || !this.credentials) return;
    const socket = new WebSocket(wsUrl(this.config.paperclipUrl), {
      headers: { authorization: `Bearer ${this.credentials.credential}` },
      maxPayload: MCP_CONNECTOR_MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    let welcomed = false;

    socket.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      socket.terminate();
      if (status === 401 || status === 403) {
        this.onFatal?.(new ConnectorFatalError("Paperclip rejected the connector credential. It was revoked or re-enrolled; enroll again with a new token."));
      }
    });
    socket.on("open", () => {
      const hello: McpConnectorHelloFrame = {
        type: "hello",
        protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
        version: CONNECTOR_VERSION,
        upstreams: [...this.config.upstreams.keys()].sort(),
      };
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseMcpConnectorServerFrame(data.toString());
      if (!frame) {
        this.log("warn", "ignored malformed frame from Paperclip");
        return;
      }
      if (frame.type === "welcome") {
        welcomed = true;
        this.attempt = 0;
        this.log("info", "connected", { connectorId: frame.connectorId, upstreams: [...this.config.upstreams.keys()] });
        this.onWelcome?.();
        return;
      }
      if (frame.type === "cancel") {
        this.inFlight.get(frame.id)?.abort();
        this.inFlight.delete(frame.id);
        return;
      }
      if (this.inFlight.size >= MCP_CONNECTOR_MAX_IN_FLIGHT_REQUESTS) {
        socket.send(JSON.stringify({ type: "error", id: frame.id, code: "busy", message: "Too many requests in flight" }));
        return;
      }
      const controller = new AbortController();
      this.inFlight.set(frame.id, controller);
      void relayRequest(frame, this.config.upstreams, controller.signal, this.options.relay).then((result) => {
        if (!this.inFlight.delete(frame.id)) return; // cancelled
        if (result.type === "error") {
          this.log("warn", "request failed", { upstream: frame.upstream, code: result.code });
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
      });
    });
    socket.on("close", (code) => {
      for (const controller of this.inFlight.values()) controller.abort();
      this.inFlight.clear();
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      if (code === MCP_CONNECTOR_CLOSE_CODES.revoked) {
        this.onFatal?.(new ConnectorFatalError("Paperclip revoked this connector or reset its credential. Enroll again with a new token."));
        return;
      }
      if (code === MCP_CONNECTOR_CLOSE_CODES.replaced) {
        this.log("warn", "another connector process with the same credential took over this session");
      }
      if (!welcomed && code === MCP_CONNECTOR_CLOSE_CODES.protocolError) {
        this.log("error", "Paperclip refused the connector protocol; check versions");
      }
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.log("warn", "socket error", { error: error.message });
    });
  }
}
