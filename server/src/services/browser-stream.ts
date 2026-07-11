import { createRequire } from "node:module";
import type { Response } from "express";
import { browserStreamPortForRun } from "@paperclipai/adapter-utils/server-utils";
import { logger } from "../middleware/logger.js";

type BrowserSocket = {
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as {
  WebSocket: new (url: string) => BrowserSocket;
};

const recentBrowserActivity = new Map<string, number>();
const BROWSER_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;

export function hasRecentBrowserActivity(runId: string) {
  const seenAt = recentBrowserActivity.get(runId);
  if (!seenAt) return false;
  if (Date.now() - seenAt <= BROWSER_ACTIVITY_TTL_MS) return true;
  recentBrowserActivity.delete(runId);
  return false;
}

function writeEvent(res: Response, event: string, payload: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function pipeBrowserStreamToSse(runId: string, res: Response) {
  const port = browserStreamPortForRun(runId);
  let socket: BrowserSocket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let connectedOnce = false;

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  writeEvent(res, "status", { status: "waiting", provider: "agent-browser" });

  const connect = () => {
    if (closed) return;
    const nextSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = nextSocket;

    nextSocket.on("open", () => {
      connectedOnce = true;
      writeEvent(res, "status", { status: "live", provider: "agent-browser" });
    });
    nextSocket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const message = JSON.parse(text) as { type?: unknown; data?: unknown; metadata?: unknown };
        if (message.type !== "frame" || typeof message.data !== "string") return;
        recentBrowserActivity.set(runId, Date.now());
        writeEvent(res, "frame", { data: message.data, metadata: message.metadata ?? null });
      } catch {
        // Ignore non-frame or malformed provider messages.
      }
    });
    nextSocket.on("close", () => {
      if (closed) return;
      writeEvent(res, "status", {
        status: connectedOnce ? "disconnected" : "waiting",
        provider: "agent-browser",
      });
      retryTimer = setTimeout(connect, 750);
    });
    nextSocket.on("error", (error) => {
      if (connectedOnce) {
        logger.debug({ err: error, runId, port }, "browser preview stream disconnected");
      }
      nextSocket.close();
    });
  };

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, 15_000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
  res.on("close", cleanup);
  connect();
  return cleanup;
}
