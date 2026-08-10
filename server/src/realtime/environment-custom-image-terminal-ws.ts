import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  readCustomImageSetupSessionCompanyId,
  requireFutureCustomImageSetupExpiry,
} from "../services/environment-custom-image-setup-session-utils.js";
import { environmentCustomImageService } from "../services/environment-custom-images.js";
import {
  environmentCustomImageTerminalConnectionRegistry,
  environmentCustomImageTerminalSessionStore,
  validateCustomImageSetupSshPayload,
  type EnvironmentCustomImageTerminalConnectionRegistry,
  type EnvironmentCustomImageTerminalPayloadValidationResult,
  type EnvironmentCustomImageTerminalSessionRecord,
  type EnvironmentCustomImageTerminalSessionStore,
  type ParsedCustomImageSetupSshCommand,
} from "../services/environment-custom-image-terminal-sessions.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

interface TerminalWsSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface TerminalWsServer {
  clients: Set<TerminalWsSocket>;
  on(event: "connection", listener: (socket: TerminalWsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  close(callback?: (err?: Error) => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: TerminalWsSocket) => void,
  ): void;
  emit(event: "connection", ws: TerminalWsSocket, req: IncomingMessage): boolean;
}

interface SetupSessionSnapshot {
  id: string;
  environmentId: string;
  provider: string;
  status: string;
  expiresAt: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

interface CustomImageTerminalService {
  getSessionById(sessionId: string): Promise<SetupSessionSnapshot | null>;
  refreshSetupSession(input: {
    sessionId: string;
    includeConnectionPayload: true;
  }): Promise<{
    session: SetupSessionSnapshot;
    connectionPayload: unknown;
  }>;
}

export interface EnvironmentCustomImageSshShell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
}

export interface EnvironmentCustomImageSshConnector {
  connect(input: {
    ssh: ParsedCustomImageSetupSshCommand;
    term: string;
    cols: number;
    rows: number;
    verifyHostKeySha256: (hostKeySha256: string) => boolean;
  }): Promise<EnvironmentCustomImageSshShell>;
}

interface TerminalUpgradeContext {
  setupSessionId: string;
  terminalSessionId: string;
  initialCols: number;
  initialRows: number;
}

interface AuthenticatedTerminalContext {
  setupSessionId: string;
  terminalSession: EnvironmentCustomImageTerminalSessionRecord;
  ssh: ParsedCustomImageSetupSshCommand;
  initialCols: number;
  initialRows: number;
}

interface IncomingMessageWithTerminalContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  paperclipTerminalUpgradeContext?: TerminalUpgradeContext;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => TerminalWsServer;
};
const CUSTOM_IMAGE_TERMINAL_UTF8_ENV = {
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
};
const TERMINAL_AUTH_TIMEOUT_MS = 10_000;

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ errorName: err instanceof Error ? err.name : typeof err }, "failed to reject custom image terminal websocket upgrade");
    closeUpgradeSocket(socket);
  }
}

function parseTerminalPath(pathname: string): { setupSessionId: string } | null {
  const match = pathname.match(/^\/api\/environment-custom-image-setup-sessions\/([^/]+)\/terminal\/ws$/);
  if (!match) return null;

  try {
    const setupSessionId = decodeURIComponent(match[1] ?? "");
    return setupSessionId ? { setupSessionId } : null;
  } catch {
    return null;
  }
}

function parseTerminalDimension(value: string | null, fallback: number) {
  if (!value) return fallback;
  if (!/^\d{1,4}$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 9999 ? parsed : fallback;
}

function safeErrorName(err: unknown) {
  return err instanceof Error ? err.name : typeof err;
}

function errorStatus(err: unknown) {
  return typeof err === "object" && err !== null && "status" in err
    ? Number((err as { status?: unknown }).status)
    : 500;
}

function clientSafeErrorMessage(err: unknown, fallback: string) {
  const status = errorStatus(err);
  if ([400, 401, 403, 404, 409, 422].includes(status) && err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}

function safeUpgradePath(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl, "http://localhost");
    if (url.searchParams.has("token")) {
      url.searchParams.set("token", "[redacted]");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl.split("?")[0] || undefined;
  }
}

function terminalPayloadValidationError(
  failure: Extract<EnvironmentCustomImageTerminalPayloadValidationResult, { ok: false }>,
): Error {
  return failure.status === 409 ? conflict(failure.message) : unprocessable(failure.message);
}

function decodeClientMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}

function sendJson(socket: TerminalWsSocket, frame: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

function closeClient(socket: TerminalWsSocket, code: number, reason: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.close(code, reason.slice(0, 120));
}

function readResizeDimensions(frame: Record<string, unknown>): { cols: number; rows: number } | null {
  const cols = typeof frame.cols === "number" && Number.isInteger(frame.cols) ? frame.cols : null;
  const rows = typeof frame.rows === "number" && Number.isInteger(frame.rows) ? frame.rows : null;
  if (
    cols !== null
    && rows !== null
    && cols > 0
    && rows > 0
    && cols <= 9999
    && rows <= 9999
  ) {
    return { cols, rows };
  }
  return null;
}

function parseJsonClientFrame(raw: unknown): Record<string, unknown> | null {
  const text = decodeClientMessage(raw);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function readAuthTokenFrame(raw: unknown): string | null {
  const frame = parseJsonClientFrame(raw);
  if (!frame || frame.type !== "auth" || typeof frame.token !== "string") return null;
  const token = frame.token.trim();
  return token || null;
}

function readPreAuthResizeFrame(raw: unknown): { cols: number; rows: number } | null {
  const frame = parseJsonClientFrame(raw);
  return frame?.type === "resize" ? readResizeDimensions(frame) : null;
}

function handleClientFrame(
  socket: TerminalWsSocket,
  shell: EnvironmentCustomImageSshShell | null,
  raw: unknown,
  onPendingResize?: (dimensions: { cols: number; rows: number }) => void,
) {
  const text = decodeClientMessage(raw);
  if (!text) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    shell?.write(text);
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const frame = parsed as Record<string, unknown>;
  if (frame.type === "input") {
    if (typeof frame.data === "string") {
      shell?.write(frame.data);
    }
    return;
  }
  if (frame.type === "resize") {
    const dimensions = readResizeDimensions(frame);
    if (dimensions) {
      if (shell) {
        shell.resize(dimensions.cols, dimensions.rows);
      } else {
        onPendingResize?.(dimensions);
      }
    }
    return;
  }

  sendJson(socket, { type: "error", message: "Unsupported terminal frame." });
}

async function validateTerminalUpgrade(input: {
  setupSessionId: string;
  terminalSessionId: string;
  token: string;
  now: Date;
  sessionStore: EnvironmentCustomImageTerminalSessionStore;
  customImages: CustomImageTerminalService;
}): Promise<EnvironmentCustomImageTerminalSessionRecord & { ssh: ParsedCustomImageSetupSshCommand }> {
  const terminalSession = input.sessionStore.get({
    id: input.terminalSessionId,
    token: input.token,
  }, input.now);
  if (!terminalSession || terminalSession.setupSessionId !== input.setupSessionId) {
    throw unprocessable("Invalid terminal session token.");
  }

  const storedSetupSession = await input.customImages.getSessionById(input.setupSessionId);
  if (!storedSetupSession) {
    input.sessionStore.delete(terminalSession.id);
    throw unprocessable("Invalid terminal setup session.");
  }
  const storedSetupCompanyId = readCustomImageSetupSessionCompanyId(storedSetupSession);
  if (
    storedSetupCompanyId !== terminalSession.companyId
    || storedSetupSession.environmentId !== terminalSession.environmentId
    || storedSetupSession.provider !== terminalSession.provider
  ) {
    input.sessionStore.delete(terminalSession.id);
    throw unprocessable("Invalid terminal setup session.");
  }

  const refreshed = await input.customImages.refreshSetupSession({
    sessionId: input.setupSessionId,
    includeConnectionPayload: true,
  });
  if (
    refreshed.session.id !== terminalSession.setupSessionId
    || readCustomImageSetupSessionCompanyId(refreshed.session) !== terminalSession.companyId
    || refreshed.session.environmentId !== terminalSession.environmentId
    || refreshed.session.provider !== terminalSession.provider
  ) {
    input.sessionStore.delete(terminalSession.id);
    throw unprocessable("Invalid terminal setup session.");
  }
  if (refreshed.session.status !== "waiting_for_user") {
    input.sessionStore.delete(terminalSession.id);
    throw conflict(`Cannot open terminal for setup status "${refreshed.session.status}".`);
  }
  const sessionExpiresAt = requireFutureCustomImageSetupExpiry(refreshed.session, input.now);

  const payloadValidation = validateCustomImageSetupSshPayload(refreshed.connectionPayload, input.now);
  if (!payloadValidation.ok) {
    input.sessionStore.delete(terminalSession.id);
    throw terminalPayloadValidationError(payloadValidation);
  }

  return { ...terminalSession, ssh: payloadValidation.ssh, sessionExpiresAt };
}

class Ssh2Shell implements EnvironmentCustomImageSshShell {
  constructor(
    private readonly client: {
      end(): void;
      destroy?(): void;
      on(event: "close", listener: () => void): void;
      on(event: "error", listener: (err: Error) => void): void;
    },
    private readonly stream: {
      write(data: string): void;
      end(): void;
      destroy?(): void;
      setWindow?(rows: number, cols: number, height: number, width: number): void;
      on(event: "data", listener: (data: Buffer | string) => void): void;
      on(event: "close", listener: () => void): void;
      on(event: "error", listener: (err: Error) => void): void;
    },
  ) {}

  write(data: string): void {
    this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream.setWindow?.(rows, cols, 0, 0);
  }

  close(): void {
    try {
      this.stream.end();
    } catch {
      this.stream.destroy?.();
    }
    try {
      this.client.end();
    } catch {
      this.client.destroy?.();
    }
  }

  onData(listener: (data: string) => void): void {
    this.stream.on("data", (data: Buffer | string) => {
      listener(typeof data === "string" ? data : data.toString("utf8"));
    });
  }

  onClose(listener: () => void): void {
    this.stream.on("close", listener);
    this.client.on("close", listener);
  }

  onError(listener: (err: Error) => void): void {
    this.stream.on("error", listener);
    this.client.on("error", listener);
  }
}

export function createSsh2EnvironmentCustomImageSshConnector(): EnvironmentCustomImageSshConnector {
  return {
    connect: async ({ ssh, term, cols, rows, verifyHostKeySha256 }) => {
      const { Client } = require("ssh2") as {
        Client: new () => {
          once(event: "ready", listener: () => void): void;
          once(event: "error", listener: (err: Error) => void): void;
          on(event: "close", listener: () => void): void;
          on(event: "error", listener: (err: Error) => void): void;
          connect(config: Record<string, unknown>): void;
          shell(
            window: { term: string; cols: number; rows: number },
            options: { env?: Record<string, string> },
            callback: (err: Error | undefined, stream: ConstructorParameters<typeof Ssh2Shell>[1]) => void,
          ): void;
          end(): void;
          destroy?(): void;
        };
      };

      return await new Promise<EnvironmentCustomImageSshShell>((resolve, reject) => {
        const client = new Client();
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          try {
            client.end();
          } catch {
            client.destroy?.();
          }
          reject(err);
        };

        client.once("ready", () => {
          client.shell({ term, cols, rows }, { env: CUSTOM_IMAGE_TERMINAL_UTF8_ENV }, (err, stream) => {
            if (err || !stream) {
              fail(err ?? new Error("SSH shell failed to open."));
              return;
            }
            if (settled) return;
            settled = true;
            resolve(new Ssh2Shell(client, stream));
          });
        });
        client.once("error", fail);
        client.connect({
          host: ssh.host,
          port: ssh.port,
          // Daytona-style providers put the ephemeral SSH credential in the username
          // and accept the "none" auth method; no password or key is expected here.
          username: ssh.username,
          hostHash: "sha256",
          hostVerifier: (hostKeySha256: string) => verifyHostKeySha256(hostKeySha256),
          readyTimeout: 20000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
        });
      });
    },
  };
}

export function setupEnvironmentCustomImageTerminalWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    pluginWorkerManager?: PluginWorkerManager;
    customImageService?: CustomImageTerminalService;
    sessionStore?: EnvironmentCustomImageTerminalSessionStore;
    connectionRegistry?: EnvironmentCustomImageTerminalConnectionRegistry;
    sshConnector?: EnvironmentCustomImageSshConnector;
  } = {},
) {
  const wss = new WebSocketServer({ noServer: true });
  const customImages = opts.customImageService ?? environmentCustomImageService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const sessionStore = opts.sessionStore ?? environmentCustomImageTerminalSessionStore;
  const connectionRegistry = opts.connectionRegistry ?? environmentCustomImageTerminalConnectionRegistry;
  const sshConnector = opts.sshConnector ?? createSsh2EnvironmentCustomImageSshConnector();

  wss.on("connection", (socket: TerminalWsSocket, req: IncomingMessage) => {
    const upgradeContext = (req as IncomingMessageWithTerminalContext).paperclipTerminalUpgradeContext;
    if (!upgradeContext) {
      socket.close(1008, "missing context");
      return;
    }

    let shell: EnvironmentCustomImageSshShell | null = null;
    let pendingResize: { cols: number; rows: number } | null = null;
    let preAuthResize: { cols: number; rows: number } | null = null;
    let cleanupRegistry: (() => void) | null = null;
    let authenticatedContext: AuthenticatedTerminalContext | null = null;
    let authenticating = false;
    let authenticated = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    let cleanedUp = false;

    const cleanup = (reason: string) => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (authTimer) clearTimeout(authTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      cleanupRegistry?.();
      cleanupRegistry = null;
      const terminalSessionId = authenticatedContext?.terminalSession.id ?? upgradeContext.terminalSessionId;
      if (authenticatedContext) {
        sessionStore.delete(authenticatedContext.terminalSession.id);
      }
      if (shell) {
        shell.close();
        shell = null;
      }
      logger.info({
        setupSessionId: upgradeContext.setupSessionId,
        terminalSessionId,
        reason,
      }, "custom image terminal websocket closed");
    };

    const closeTerminal = (reason: string, code = 1000, socketReason = "closed") => {
      sendJson(socket, { type: "closed", reason });
      closeClient(socket, code, socketReason);
      cleanup(reason);
    };

    const startAuthenticatedTerminal = (context: AuthenticatedTerminalContext) => {
      authenticatedContext = context;
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      if (preAuthResize) {
        pendingResize = preAuthResize;
        preAuthResize = null;
      }

      cleanupRegistry = connectionRegistry.add({
        setupSessionId: context.setupSessionId,
        close: (reason) => {
          closeTerminal(reason);
        },
      });

      const expiresInMs = Math.max(0, context.terminalSession.sessionExpiresAt.getTime() - Date.now());
      expiryTimer = setTimeout(() => {
        closeTerminal("expired", 1008, "expired");
      }, expiresInMs);

      void sshConnector.connect({
        ssh: context.ssh,
        term: "xterm-256color",
        cols: context.initialCols,
        rows: context.initialRows,
        verifyHostKeySha256: (hostKeySha256) => sessionStore.verifyOrPinHostKey({
          id: context.terminalSession.id,
          hostKeySha256,
        }),
      })
        .then((connectedShell) => {
          if (cleanedUp) {
            connectedShell.close();
            return;
          }
          shell = connectedShell;
          if (pendingResize) {
            shell.resize(pendingResize.cols, pendingResize.rows);
            pendingResize = null;
          }
          shell.onData((data) => {
            sendJson(socket, { type: "output", data });
          });
          shell.onClose(() => {
            if (cleanedUp) return;
            closeTerminal("ssh_closed");
          });
          shell.onError((err) => {
            if (cleanedUp) return;
            logger.warn({
              errorName: safeErrorName(err),
              setupSessionId: context.setupSessionId,
              terminalSessionId: context.terminalSession.id,
            }, "custom image terminal ssh stream failed");
            sendJson(socket, { type: "error", message: "SSH terminal connection failed." });
            closeClient(socket, 1011, "ssh error");
            cleanup("ssh_error");
          });
          sendJson(socket, {
            type: "ready",
            setupSessionId: context.setupSessionId,
            terminalSessionId: context.terminalSession.id,
          });
        })
        .catch((err) => {
          logger.warn({
            errorName: safeErrorName(err),
            setupSessionId: context.setupSessionId,
            terminalSessionId: context.terminalSession.id,
          }, "custom image terminal ssh connection failed");
          sendJson(socket, { type: "error", message: "SSH terminal connection failed." });
          closeClient(socket, 1011, "ssh error");
          cleanup("ssh_connect_error");
        });
    };

    authTimer = setTimeout(() => {
      sendJson(socket, { type: "error", message: "Terminal authentication timed out." });
      closeClient(socket, 1008, "terminal auth timeout");
      cleanup("auth_timeout");
    }, TERMINAL_AUTH_TIMEOUT_MS);

    socket.on("message", (data: unknown) => {
      if (!authenticated) {
        const resize = readPreAuthResizeFrame(data);
        if (resize) {
          preAuthResize = resize;
          return;
        }

        const token = readAuthTokenFrame(data);
        if (!token) {
          sendJson(socket, { type: "error", message: "Terminal authentication is required." });
          closeClient(socket, 1008, "terminal auth required");
          cleanup("auth_frame_invalid");
          return;
        }
        if (authenticating) return;
        authenticating = true;

        void validateTerminalUpgrade({
          setupSessionId: upgradeContext.setupSessionId,
          terminalSessionId: upgradeContext.terminalSessionId,
          token,
          now: new Date(),
          sessionStore,
          customImages,
        })
          .then((terminalSession) => {
            authenticating = false;
            if (cleanedUp || socket.readyState !== WebSocket.OPEN) {
              sessionStore.delete(terminalSession.id);
              return;
            }
            authenticated = true;
            startAuthenticatedTerminal({
              setupSessionId: upgradeContext.setupSessionId,
              terminalSession,
              ssh: terminalSession.ssh,
              initialCols: upgradeContext.initialCols,
              initialRows: upgradeContext.initialRows,
            });
          })
          .catch((err) => {
            authenticating = false;
            logger.warn({
              errorName: safeErrorName(err),
              setupSessionId: upgradeContext.setupSessionId,
              terminalSessionId: upgradeContext.terminalSessionId,
            }, "custom image terminal websocket authentication rejected");
            sendJson(socket, {
              type: "error",
              message: clientSafeErrorMessage(err, "Terminal authentication failed."),
            });
            closeClient(socket, errorStatus(err) >= 500 ? 1011 : 1008, "terminal auth rejected");
            cleanup("auth_rejected");
          });
        return;
      }

      handleClientFrame(socket, shell, data, (dimensions) => {
        pendingResize = dimensions;
      });
    });

    socket.on("close", () => {
      cleanup("client_closed");
    });

    socket.on("error", () => {
      cleanup("client_error");
    });
  });

  wss.on("close", () => {
    connectionRegistry.closeAll("server_shutdown");
  });

  if (typeof server.on !== "function") {
    return wss;
  }

  server.on("close", () => {
    connectionRegistry.closeAll("server_shutdown");
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  });

  server.on("upgrade", (req, socket, head) => {
    const reqWithContext = req as IncomingMessageWithTerminalContext;
    if (!req.url) return;

    const url = new URL(req.url, "http://localhost");
    const path = parseTerminalPath(url.pathname);
    if (!path) return;

    reqWithContext.paperclipWebSocketHandled = true;
    const logPath = safeUpgradePath(req.url);

    const onRawSocketError = (err: Error) => {
      logger.warn({ errorName: safeErrorName(err), path: logPath }, "custom image terminal websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    const terminalSessionId = url.searchParams.get("terminalSessionId")?.trim() ?? "";
    const initialCols = parseTerminalDimension(url.searchParams.get("cols"), 80);
    const initialRows = parseTerminalDimension(url.searchParams.get("rows"), 24);
    if (!terminalSessionId) {
      rejectUpgrade(socket, "400 Bad Request", "missing terminal session");
      return;
    }

    reqWithContext.paperclipTerminalUpgradeContext = {
      setupSessionId: path.setupSessionId,
      terminalSessionId,
      initialCols,
      initialRows,
    };

    cleanupRawSocketListeners();
    wss.handleUpgrade(req, socket, head, (ws: TerminalWsSocket) => {
      wss.emit("connection", ws, reqWithContext);
    });
  });

  return wss;
}
