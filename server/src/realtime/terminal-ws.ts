/**
 * Terminal WebSocket server.
 *
 * Spawns PTY sessions on the server and pipes stdin/stdout over WebSocket
 * to xterm.js in the browser. Each terminal session is tied to a working
 * directory (typically a workspace/worktree path).
 *
 * Protocol:
 *   Client → Server: raw terminal input (binary/text) OR JSON control messages
 *   Server → Client: raw PTY output (binary/text) OR JSON control messages
 *
 * Control messages (JSON with { type: ... }):
 *   → { type: "resize", cols: number, rows: number }
 *   ← { type: "exit", code: number }
 *   ← { type: "error", message: string }
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger as rootLogger } from "../middleware/logger.js";

const log = rootLogger.child({ service: "terminal-ws" });

// Dynamic require for node-pty (native module) and ws
const require = createRequire(import.meta.url);

let nodePty: typeof import("node-pty") | null = null;
try {
  nodePty = require("node-pty") as typeof import("node-pty");
  log.info("node-pty loaded successfully");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log.warn({ err: msg }, "node-pty not available — terminal feature disabled");
}

const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface WsSocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

interface TerminalSession {
  id: string;
  cwd: string;
  pty: import("node-pty").IPty;
  ws: WsSocket | null;
  createdAt: Date;
}

const sessions = new Map<string, TerminalSession>();
let sessionCounter = 0;

function generateSessionId(): string {
  return `term-${Date.now()}-${++sessionCounter}`;
}

export function createTerminalSession(cwd: string): string {
  if (!nodePty) throw new Error("node-pty is not available — native module may not be built for this platform");

  const expandedCwd = cwd === "~" || cwd.startsWith("~/")
    ? cwd.replace("~", process.env.HOME ?? "/tmp")
    : cwd;
  const resolvedCwd = resolve(expandedCwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(`cwd does not exist: ${resolvedCwd}`);
  }

  const id = generateSessionId();
  const shell = process.env.SHELL || "/bin/zsh";

  // Build env from process.env, filtering out undefined values
  // (node-pty requires Record<string, string>, not string | undefined)
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";

  log.info({ shell, cwd: resolvedCwd }, "terminal: spawning PTY");

  const pty = nodePty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: resolvedCwd,
    env,
  });

  const session: TerminalSession = { id, cwd: resolvedCwd, pty, ws: null, createdAt: new Date() };
  sessions.set(id, session);

  pty.onExit(({ exitCode }) => {
    log.info({ sessionId: id, exitCode }, "terminal: PTY exited");
    const s = sessions.get(id);
    if (s?.ws && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
    }
    sessions.delete(id);
  });

  log.info({ sessionId: id, cwd: resolvedCwd, shell }, "terminal: session created");
  return id;
}

export function listTerminalSessions(): Array<{ id: string; cwd: string; createdAt: string; connected: boolean }> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    cwd: s.cwd,
    createdAt: s.createdAt.toISOString(),
    connected: s.ws !== null && s.ws.readyState === 1,
  }));
}

export function killTerminalSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill();
  } catch {
    // Already dead
  }
  if (session.ws) {
    session.ws.close();
  }
  sessions.delete(id);
  log.info({ sessionId: id }, "terminal: session killed");
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

let wss: WsServer | null = null;

export function setupTerminalWebSocketServer(httpServer: HttpServer) {
  if (!nodePty) {
    log.info("terminal: node-pty not available, WebSocket server not started");
    return;
  }

  wss = new WebSocketServer({ noServer: true });

  // Hook into the HTTP server's upgrade event
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "";

    // Only handle /ws/terminal/:sessionId
    const match = url.match(/^\/ws\/terminal\/([^/?]+)/);
    if (!match) return; // Let other upgrade handlers (live-events) handle it

    const sessionId = match[1];
    const session = sessions.get(sessionId);

    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nSession not found");
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      attachWebSocket(session, ws);
    });
  });

  log.info("terminal: WebSocket server ready");
}

function attachWebSocket(session: TerminalSession, ws: WsSocket) {
  // Detach any previous connection
  if (session.ws) {
    session.ws.close();
  }
  session.ws = ws;

  log.info({ sessionId: session.id }, "terminal: WebSocket attached");

  // PTY output → WebSocket
  const dataDisposable = session.pty.onData((data) => {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  });

  // WebSocket → PTY input
  ws.on("message", (data) => {
    const str = typeof data === "string" ? data : data.toString("utf-8");

    // Check for control messages
    if (str.startsWith("{")) {
      try {
        const msg = JSON.parse(str) as { type: string; cols?: number; rows?: number };
        if (msg.type === "resize" && msg.cols && msg.rows) {
          session.pty.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        // Not JSON — treat as terminal input
      }
    }

    session.pty.write(str);
  });

  ws.on("close", () => {
    log.info({ sessionId: session.id }, "terminal: WebSocket disconnected");
    session.ws = null;
    dataDisposable.dispose();
  });

  ws.on("error", (err) => {
    log.warn({ sessionId: session.id, err: err.message }, "terminal: WebSocket error");
  });
}
