/**
 * Bridges WebSocket connections from the relay tunnel to local Paperclip
 * WebSocket endpoints. Each bridged connection is identified by a unique ID.
 *
 * Note: the relay tunnel only supports JSON text frames. Binary WebSocket
 * frames are not supported and will be corrupted by UTF-8 serialization.
 */

import { createRequire } from "node:module";
import type { WsOpen, WsMessage, WsClose, TunnelMessage } from "./protocol.js";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);
const WS = require("ws") as { new (url: string, opts?: object): WsInstance; OPEN: number };

interface WsInstance {
  readyState: number;
  on(event: string, cb: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

type SendFn = (msg: TunnelMessage) => void;

interface BridgeEntry {
  ws: WsInstance;
  /** Messages received before the local WebSocket handshake completes. */
  queue: string[];
}

// Module-level singleton — safe because a single Paperclip server runs one
// relay client at a time, so all bridged connections share one map.
const activeBridges = new Map<string, BridgeEntry>();

export function handleWsOpen(msg: WsOpen, localPort: number, send: SendFn): void {
  const url = `ws://127.0.0.1:${localPort}${msg.path}`;

  const headers: Record<string, string> = { ...msg.headers };
  headers.host = `127.0.0.1:${localPort}`;

  const localWs = new WS(url, { headers });
  const entry: BridgeEntry = { ws: localWs, queue: [] };

  // Register immediately so messages arriving before "open" are queued
  // rather than silently dropped.
  activeBridges.set(msg.id, entry);

  localWs.on("open", () => {
    for (const queued of entry.queue) {
      localWs.send(queued);
    }
    entry.queue.length = 0;
  });

  localWs.on("message", (data: Buffer | string, isBinary: boolean) => {
    if (isBinary) {
      send({ type: "ws-error", id: msg.id, message: "Binary WebSocket frames are not supported through the relay tunnel" });
      return;
    }
    const text = typeof data === "string" ? data : data.toString();
    logger.debug({ wsId: msg.id, len: text.length }, "ws-bridge: local → tunnel message");
    send({
      type: "ws-message",
      id: msg.id,
      data: text,
    });
  });

  localWs.on("close", (code: number) => {
    activeBridges.delete(msg.id);
    send({
      type: "ws-close",
      id: msg.id,
      code,
    });
  });

  localWs.on("error", (err: Error) => {
    activeBridges.delete(msg.id);
    send({
      type: "ws-error",
      id: msg.id,
      message: err.message,
    });
  });
}

export function handleWsMessage(msg: WsMessage): void {
  const entry = activeBridges.get(msg.id);
  if (!entry) return;

  if (entry.ws.readyState === WS.OPEN) {
    entry.ws.send(msg.data);
  } else {
    // Local WS still connecting — buffer until "open" fires.
    entry.queue.push(msg.data);
  }
}

export function handleWsClose(msg: WsClose): void {
  const entry = activeBridges.get(msg.id);
  if (entry) {
    activeBridges.delete(msg.id);
    try {
      entry.ws.close(msg.code ?? 1000);
    } catch {
      entry.ws.close(1000);
    }
  }
}

export function closeAllBridges(): void {
  activeBridges.forEach((entry, id) => {
    entry.ws.close(1001);
    activeBridges.delete(id);
  });
}
