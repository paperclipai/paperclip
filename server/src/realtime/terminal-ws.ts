import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";

/**
 * Interactive PTY-over-WebSocket for the embedded jade terminal.
 *
 * jade.computer renders an xterm panel on the workspace screen pointed at
 * `wss://<workspace-host>/api/terminal/ws`. The owner is already
 * auto-signed-in to this workspace as instance admin (jade SSO bridge),
 * so the WS is gated to that role only — a shell is full machine access.
 *
 * No `node-pty` (native build is fragile in the slim image): we get a
 * real PTY for free via util-linux `script`, which allocates a tty for
 * the shell. Enough for `claude login` / `codex login` / general use.
 */

interface WsSocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer) => void): void;
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
  on(event: "connection", listener: (ws: WsSocket) => void): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

export const TERMINAL_WS_PATH = "/api/terminal/ws";

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`,
  );
  socket.destroy();
}

/**
 * Only the workspace's instance admin (the jade owner, auto-SSO'd) may
 * open a shell. Mirrors the live-events authenticated-session check.
 */
async function authorize(
  db: Db,
  req: IncomingMessage,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (
      headers: Headers,
    ) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<{ userId: string } | null> {
  // local_trusted has no auth wall at all — single-operator dev box.
  if (opts.deploymentMode === "local_trusted") {
    return { userId: "local" };
  }
  if (
    opts.deploymentMode !== "authenticated" ||
    !opts.resolveSessionFromHeaders
  ) {
    return null;
  }
  const session = await opts.resolveSessionFromHeaders(
    headersFromIncomingMessage(req),
  );
  const userId = session?.user?.id;
  if (!userId) return null;

  const roleRow = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(
      and(
        eq(instanceUserRoles.userId, userId),
        eq(instanceUserRoles.role, "instance_admin"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!roleRow) return null;

  return { userId };
}

export interface TerminalUpgradeHandler {
  matches(pathname: string): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createTerminalUpgradeHandler(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (
      headers: Headers,
    ) => Promise<BetterAuthSessionResult | null>;
  },
): TerminalUpgradeHandler {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WsSocket) => {
    const home = process.env.PAPERCLIP_HOME || process.env.HOME || "/paperclip";
    // `script` allocates a real PTY for the shell, so interactive CLIs
    // (claude/codex login) behave as if on a terminal. `-q` quiet,
    // `-f` flush each write, `-c` run the command, output to /dev/null
    // (we stream via the pipes, not the typescript file).
    const child = spawn("script", ["-qfc", "/bin/bash -l", "/dev/null"], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        TERM: "xterm-256color",
        COLUMNS: "120",
        LINES: "32",
      },
    });

    const closeAll = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        if (ws.readyState === 1) ws.close();
      } catch {
        /* already closed */
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      if (ws.readyState === 1) ws.send(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (ws.readyState === 1) ws.send(d);
    });
    child.on("exit", closeAll);
    child.on("error", (err) => {
      logger.warn({ err }, "terminal pty spawn error");
      closeAll();
    });

    ws.on("message", (data: Buffer) => {
      const text = data.toString("utf8");
      // Reserved control channel for future resize support; ignored for
      // now (script's pty is fixed-size, which is fine for auth flows).
      if (text.startsWith("\x00jade-ctrl:")) return;
      try {
        child.stdin.write(data);
      } catch {
        closeAll();
      }
    });
    ws.on("close", closeAll);
    ws.on("error", closeAll);
  });

  return {
    matches(pathname: string) {
      return pathname === TERMINAL_WS_PATH;
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      void authorize(db, req, opts)
        .then((auth) => {
          if (!auth) {
            rejectUpgrade(socket, "403 Forbidden", "forbidden");
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
            wss.emit("connection", ws, req);
          });
        })
        .catch((err) => {
          logger.error({ err }, "terminal websocket upgrade failed");
          rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
        });
    },
  };
}
