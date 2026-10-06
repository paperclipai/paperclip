import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { Db } from "@paperclipai/db";
import {
  MCP_CONNECTOR_CLOSE_CODES,
  MCP_CONNECTOR_HELLO_TIMEOUT_MS,
  MCP_CONNECTOR_MAX_FRAME_BYTES,
  MCP_CONNECTOR_PROTOCOL_VERSION,
  MCP_CONNECTOR_WS_PATH,
  parseMcpConnectorClientFrame,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { mcpConnectorHub, type McpConnectorHub, type McpConnectorSession } from "../services/mcp-connector-hub.js";
import { mcpConnectorService } from "../services/mcp-connectors.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void;
}

interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WsSocket) => void): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean; maxPayload: number }) => WsServer;
};

interface UpgradeRequest extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
}

const HEARTBEAT_INTERVAL_MS = 25_000;

function rejectUpgrade(socket: Duplex, statusLine: string) {
  if (socket.destroyed) return;
  try {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

function bearerToken(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.toLowerCase().startsWith("bearer ")) return null;
  const token = value.slice("bearer ".length).trim();
  return token || null;
}

function frameText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * Accept outbound connector sessions on `MCP_CONNECTOR_WS_PATH`.
 *
 * The connector authenticates with its long-lived credential in the upgrade
 * `Authorization` header. The session is bound to the connector's company at
 * authentication time; every relayed request re-checks that binding and the
 * revocation state in the hub. A heartbeat also re-validates the credential,
 * so a revoke or re-enroll on another replica closes this socket too.
 */
export function setupMcpConnectorWebSocketServer(
  server: HttpServer,
  db: Db,
  options: { hub?: McpConnectorHub; heartbeatIntervalMs?: number } = {},
) {
  const hub = options.hub ?? mcpConnectorHub;
  const connectors = mcpConnectorService(db, { hub });
  hub.setVerifier((input) => connectors.verify(input));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MCP_CONNECTOR_MAX_FRAME_BYTES });
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://paperclip.invalid");
    if (url.pathname !== MCP_CONNECTOR_WS_PATH) return;
    const owned = req as UpgradeRequest;
    if (owned.paperclipWebSocketHandled) return;
    owned.paperclipWebSocketHandled = true;
    socket.on("error", () => undefined);

    const credential = bearerToken(req.headers.authorization);
    if (!credential) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    void connectors.authenticate(credential).then((row) => {
      if (!row) {
        rejectUpgrade(socket, "401 Unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        acceptSession(ws, { connectorId: row.id, companyId: row.companyId, credential });
      });
    }).catch((err) => {
      logger.warn({ err }, "mcp connector upgrade authentication failed");
      rejectUpgrade(socket, "500 Internal Server Error");
    });
  });

  function acceptSession(ws: WsSocket, auth: { connectorId: string; companyId: string; credential: string }) {
    let session: McpConnectorSession | null = null;
    let alive = true;
    let closed = false;
    const helloTimer = setTimeout(() => {
      if (!session) ws.close(MCP_CONNECTOR_CLOSE_CODES.helloTimeout, "hello timeout");
    }, MCP_CONNECTOR_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        // close handler cleans up
      }
      // Re-validate the credential so a revoke/re-enroll handled elsewhere closes this session.
      void connectors.authenticate(auth.credential).then((row) => {
        if (closed) return;
        if (!row || row.companyId !== auth.companyId) {
          ws.close(MCP_CONNECTOR_CLOSE_CODES.revoked, "revoked");
          return;
        }
        void connectors.recordSeen(auth.connectorId);
      }).catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", (err) => {
      logger.debug({ errorName: err.name, connectorId: auth.connectorId }, "mcp connector socket error");
    });
    ws.on("close", () => {
      closed = true;
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      if (session) {
        hub.detach(session);
        void connectors.recordSeen(auth.connectorId).catch(() => undefined);
        logger.info({ connectorId: auth.connectorId, companyId: auth.companyId }, "mcp connector disconnected");
      }
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (isBinary) {
        ws.close(MCP_CONNECTOR_CLOSE_CODES.protocolError, "binary frames are not supported");
        return;
      }
      const frame = parseMcpConnectorClientFrame(frameText(data));
      if (!frame) {
        ws.close(MCP_CONNECTOR_CLOSE_CODES.protocolError, "invalid frame");
        return;
      }
      if (frame.type === "hello") {
        if (session) return;
        if (frame.protocolVersion !== MCP_CONNECTOR_PROTOCOL_VERSION) {
          ws.close(MCP_CONNECTOR_CLOSE_CODES.protocolError, "unsupported protocol version");
          return;
        }
        clearTimeout(helloTimer);
        // Recheck right before attaching: the credential may have been revoked during the handshake.
        void connectors.authenticate(auth.credential).then(async (row) => {
          if (closed) return;
          if (!row || row.companyId !== auth.companyId) {
            ws.close(MCP_CONNECTOR_CLOSE_CODES.revoked, "revoked");
            return;
          }
          await connectors.recordConnected(auth.connectorId, { version: frame.version, upstreams: frame.upstreams });
          if (closed) return;
          // Re-verify that the connector is still active and the credential has not been cleared during the write
          const stillValid = await connectors.authenticate(auth.credential);
          if (closed || !stillValid || stillValid.companyId !== auth.companyId) {
            ws.close(MCP_CONNECTOR_CLOSE_CODES.revoked, "revoked");
            return;
          }
          session = hub.attach({
            connectorId: auth.connectorId,
            companyId: auth.companyId,
            socket: ws,
            version: frame.version,
            upstreams: new Set(frame.upstreams),
            credential: auth.credential,
          });
          ws.send(JSON.stringify({
            type: "welcome",
            connectorId: auth.connectorId,
            companyId: auth.companyId,
            protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
          }));
          logger.info(
            { connectorId: auth.connectorId, companyId: auth.companyId, upstreamCount: frame.upstreams.length },
            "mcp connector connected",
          );
        }).catch((err) => {
          logger.warn({ err, connectorId: auth.connectorId }, "mcp connector hello failed");
          ws.close(1011, "hello failed");
        });
        return;
      }
      if (!session) {
        ws.close(MCP_CONNECTOR_CLOSE_CODES.protocolError, "hello required");
        return;
      }
      hub.handleFrame(session, frame);
    });
  }

  return {
    close: () => {
      hub.disconnectAll();
      hub.setVerifier(null);
      wss.close();
    },
  };
}
