/**
 * Bridges WebSocket connections from the relay tunnel to local Paperclip
 * WebSocket endpoints. Each bridged connection is identified by a unique ID
 * (stream ID).
 *
 * WebSocket data frames are sent as binary tunnel frames — the bridge never
 * inspects or parses the payload. Both text and binary client frames are
 * supported transparently.
 */

import { createRequire } from "node:module";
import type { WsOpen, WsClose, TunnelMessage } from "./protocol.js";
import { encodeDataFrame } from "./protocol.js";

const require = createRequire(import.meta.url);
const WS = require("ws") as { new (url: string, opts?: object): WsInstance; OPEN: number };

interface WsInstance {
  readyState: number;
  on(event: string, cb: (...args: any[]) => void): void;
  send(data: string | Buffer): void;
  close(code?: number): void;
}

type SendJsonFn = (msg: TunnelMessage) => void;
type SendBinaryFn = (frame: Buffer) => void;

interface QueuedMessage {
  data: string | Buffer;
}

interface BridgeEntry {
  ws: WsInstance;
  /** Messages received before the local WebSocket handshake completes. */
  queue: QueuedMessage[];
}

// Module-level singleton — safe because a single Paperclip server runs one
// relay client at a time, so all bridged connections share one map.
const activeBridges = new Map<string, BridgeEntry>();

export function handleWsOpen(msg: WsOpen, localPort: number, sendJson: SendJsonFn, sendBinary: SendBinaryFn): void {
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
      localWs.send(queued.data);
    }
    entry.queue.length = 0;
  });

  localWs.on("message", (data: Buffer | string, isBinary: boolean) => {
    // Encode as binary tunnel frame — no JSON, no content inspection.
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const frame = encodeDataFrame(msg.id, payload, isBinary);
    sendBinary(frame);
  });

  localWs.on("close", (code: number) => {
    activeBridges.delete(msg.id);
    sendJson({
      type: "ws-close",
      id: msg.id,
      code,
    });
  });

  localWs.on("error", (err: Error) => {
    activeBridges.delete(msg.id);
    sendJson({
      type: "ws-error",
      id: msg.id,
      message: err.message,
    });
  });
}

/**
 * Forward a decoded binary data frame to the local WebSocket.
 * The payload is sent as-is — text or binary depending on isBinary.
 */
export function handleWsData(streamId: string, payload: Buffer, isBinary: boolean): void {
  const entry = activeBridges.get(streamId);
  if (!entry) return;

  // ws library: send Buffer → binary frame, send string → text frame
  const data = isBinary ? payload : payload.toString("utf8");

  if (entry.ws.readyState === WS.OPEN) {
    entry.ws.send(data);
  } else {
    // Local WS still connecting — buffer until "open" fires.
    entry.queue.push({ data });
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
