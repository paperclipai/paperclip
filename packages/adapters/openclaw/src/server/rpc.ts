import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// JSON-RPC frame types
// ---------------------------------------------------------------------------

export interface RpcRequest {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

export function buildRpcRequest(
  method: string,
  params: Record<string, unknown>,
): { frame: RpcRequest; id: string } {
  const id = crypto.randomUUID();
  return {
    id,
    frame: { type: "req", id, method, params },
  };
}

export function isRpcResponse(data: unknown): data is RpcResponse {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "res" && typeof obj.id === "string";
}

// ---------------------------------------------------------------------------
// WebSocket helpers (Node 22 native WebSocket)
// ---------------------------------------------------------------------------

function createWebSocket(
  url: string,
  headers?: Record<string, string>,
): WebSocket {
  const options: Record<string, unknown> = {};
  if (headers && Object.keys(headers).length > 0) {
    options.headers = headers;
  }
  return Object.keys(options).length > 0
    ? new (WebSocket as unknown as new (url: string, protocols?: string | string[], opts?: unknown) => WebSocket)(url, undefined, options)
    : new WebSocket(url);
}

export function openWebSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = createWebSocket(url, headers);

    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (ev: Event) => {
      cleanup();
      const msg =
        (ev as ErrorEvent).message ??
        `WebSocket connection to ${url} failed`;
      reject(new Error(msg));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

export function safeCloseWebSocket(ws: WebSocket) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Open a WebSocket, send a JSON-RPC request, and wait for a single response
 * frame that matches the request id. Rejects on timeout or connection error.
 */
export function rpcCall(
  url: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolve, reject) => {
    const { frame, id } = buildRpcRequest(method, params);
    const ws = createWebSocket(url, headers);

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`RPC call to ${method} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const onOpen = () => {
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        settle(() =>
          reject(new Error(err instanceof Error ? err.message : String(err))),
        );
      }
    };

    const onMessage = (ev: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!isRpcResponse(data) || data.id !== id) return;
      settle(() => resolve(data as RpcResponse));
    };

    const onError = (ev: Event) => {
      const msg =
        (ev as ErrorEvent).message ?? `WebSocket connection to ${url} failed`;
      settle(() => reject(new Error(msg)));
    };

    const onClose = () => {
      settle(() =>
        reject(new Error("WebSocket closed before receiving a response")),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      safeCloseWebSocket(ws);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}
