import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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

function writeEvent(res: Response, event: string, payload: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function pipeBrowserStreamToSse(
  runId: string,
  res: Response,
  options?: { onFirstFrame?: () => void; scopeId?: string },
) {
  const scopeId = options?.scopeId ?? runId;
  const port = browserStreamPortForRun(scopeId);
  const artifactRoot = path.join(process.env.PAPERCLIP_HOME?.trim() || "/paperclip", "browser-artifacts");
  const safeScope = scopeId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const providerPath = path.join(artifactRoot, `${safeScope}-provider`);
  const camoufoxFramePath = path.join(artifactRoot, `${safeScope}-camoufox.jpg`);
  let socket: BrowserSocket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let connectedOnce = false;
  let receivedFrame = false;
  let activeProvider: "agent-browser" | "camoufox" = "agent-browser";
  let lastCamoufoxFrameMtime = 0;

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
      if (activeProvider === "camoufox") return;
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const message = JSON.parse(text) as { type?: unknown; data?: unknown; metadata?: unknown };
        if (message.type !== "frame" || typeof message.data !== "string") return;
        if (!receivedFrame) {
          receivedFrame = true;
          options?.onFirstFrame?.();
        }
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

  const camoufoxPoll = setInterval(async () => {
    if (closed || res.writableEnded) return;
    try {
      const selected = (await readFile(providerPath, "utf8")).trim();
      const nextProvider = selected === "camoufox" ? "camoufox" : "agent-browser";
      if (nextProvider !== activeProvider) {
        activeProvider = nextProvider;
        writeEvent(res, "status", { status: "live", provider: activeProvider });
      }
      if (activeProvider !== "camoufox") return;
      const frameStat = await stat(camoufoxFramePath);
      if (frameStat.mtimeMs <= lastCamoufoxFrameMtime) return;
      const frame = await readFile(camoufoxFramePath);
      lastCamoufoxFrameMtime = frameStat.mtimeMs;
      if (!receivedFrame) {
        receivedFrame = true;
        options?.onFirstFrame?.();
      }
      writeEvent(res, "frame", {
        data: frame.toString("base64"),
        metadata: { provider: "camoufox", capturedAt: frameStat.mtime.toISOString() },
      });
    } catch {
      // Provider marker or frame is not present yet.
    }
  }, 500);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    clearInterval(camoufoxPoll);
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
  res.on("close", cleanup);
  connect();
  return cleanup;
}
