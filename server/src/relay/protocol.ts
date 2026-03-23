/**
 * Relay tunnel protocol message types.
 *
 * These messages are sent over the persistent WebSocket tunnel between the
 * Paperclip server (tunnel client) and the relay server. The relay forwards
 * HTTP requests and WebSocket frames without inspecting payloads.
 */

// ── Tunnel lifecycle ────────────────────────────────────────────────────────

export interface TunnelReady {
  type: "tunnel-ready";
  instanceId: string;
  publicUrl?: string;
}

// ── HTTP request/response ───────────────────────────────────────────────────

export interface HttpRequest {
  id: string;
  type: "http-request";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string; // base64-encoded
}

export interface HttpResponse {
  id: string;
  type: "http-response";
  status: number;
  headers: Record<string, string>;
  body: string; // base64-encoded
}

// ── WebSocket bridging (control — sent as JSON text frames) ─────────────────

export interface WsOpen {
  type: "ws-open";
  id: string;
  path: string;
  headers: Record<string, string>;
}

export interface WsClose {
  type: "ws-close";
  id: string;
  code?: number;
}

export interface WsError {
  type: "ws-error";
  id: string;
  message: string;
}

// ── WebSocket data frames (sent as binary tunnel frames, NOT JSON) ──────────
//
// Binary frame format on the tunnel WebSocket:
//
//   Byte 0:       Flags (bit 0 = original frame was binary; 0 = text, 1 = binary)
//   Bytes 1–36:   Stream ID (UUID as 36 ASCII chars, e.g. "528a881c-6475-...")
//   Bytes 37+:    Raw payload (untouched original WebSocket message bytes)
//
// Text frames on the tunnel WS carry JSON control/HTTP messages (above).
// Binary frames on the tunnel WS carry raw WS data (this format).
// The bridge never inspects or parses the payload — it's a dumb pipe.

export const DATA_FRAME_HEADER_SIZE = 37; // 1 flag + 36 stream ID

export function encodeDataFrame(streamId: string, payload: Buffer | Uint8Array, isBinary: boolean): Buffer {
  const header = Buffer.alloc(DATA_FRAME_HEADER_SIZE);
  header[0] = isBinary ? 0x01 : 0x00;
  header.write(streamId, 1, 36, "ascii");
  return Buffer.concat([header, payload]);
}

export function decodeDataFrame(frame: Buffer): { streamId: string; payload: Buffer; isBinary: boolean } {
  const isBinary = (frame[0]! & 0x01) !== 0;
  const streamId = frame.subarray(1, 37).toString("ascii");
  const payload = frame.subarray(37);
  return { streamId, payload, isBinary };
}

// ── Union type (JSON control messages only — data frames are binary) ────────

export type TunnelMessage =
  | TunnelReady
  | HttpRequest
  | HttpResponse
  | WsOpen
  | WsClose
  | WsError;
