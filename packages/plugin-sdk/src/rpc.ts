import type { JsonRpcRequest, JsonRpcResponse, JsonRpcError } from "./types.js";

/**
 * Parse a single newline-delimited JSON-RPC message.
 * Returns the parsed object (request or response).
 */
export function parseJsonRpcMessage(raw: string): JsonRpcRequest | JsonRpcResponse {
  const obj = JSON.parse(raw);
  if (obj.jsonrpc !== "2.0") {
    throw new Error("not a valid JSON-RPC 2.0 message");
  }
  return obj;
}

/**
 * Serialize a JSON-RPC request with newline delimiter.
 */
export function serializeJsonRpcRequest(
  id: number | string,
  method: string,
  params?: unknown,
): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    msg.params = params;
  }
  return JSON.stringify(msg) + "\n";
}

/**
 * Serialize a JSON-RPC response with newline delimiter.
 */
export function serializeJsonRpcResponse(
  id: number | string,
  result?: unknown,
  error?: JsonRpcError,
): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error) {
    msg.error = error;
  } else {
    msg.result = result;
  }
  return JSON.stringify(msg) + "\n";
}

/**
 * RPC Channel: manages bidirectional JSON-RPC communication over readable/writable streams.
 * Used by both host (per-worker) and worker (to host).
 */
export class RpcChannel {
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private onRequest?: (method: string, params: unknown, id: number | string) => Promise<unknown>;

  constructor(
    private input: NodeJS.ReadableStream,
    private output: NodeJS.WritableStream,
  ) {
    this.input.setEncoding("utf8" as any);
    this.input.on("data", (chunk: string) => this.handleData(chunk));
  }

  /**
   * Register a handler for incoming requests (host->worker or worker->host).
   */
  setRequestHandler(handler: (method: string, params: unknown, id: number | string) => Promise<unknown>) {
    this.onRequest = handler;
  }

  /**
   * Send an RPC request and wait for the response.
   */
  async call(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(serializeJsonRpcRequest(id, method, params));
    });
  }

  /**
   * Send a response to an incoming request.
   */
  respond(id: number | string, result?: unknown, error?: JsonRpcError) {
    this.output.write(serializeJsonRpcResponse(id, result, error));
  }

  /**
   * Clean up pending calls.
   */
  destroy() {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("RPC channel destroyed"));
    }
    this.pending.clear();
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const msg = parseJsonRpcMessage(line);
        this.handleMessage(msg);
      } catch {
        // Skip malformed messages
      }
    }
  }

  private handleMessage(msg: JsonRpcRequest | JsonRpcResponse) {
    // Response to our outgoing call
    if ("result" in msg || "error" in msg) {
      const resp = msg as JsonRpcResponse;
      const entry = this.pending.get(resp.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(resp.id);
        if (resp.error) {
          entry.reject(new Error(resp.error.message));
        } else {
          entry.resolve(resp.result);
        }
      }
      return;
    }

    // Incoming request
    const req = msg as JsonRpcRequest;
    if (this.onRequest && req.method) {
      this.onRequest(req.method, req.params, req.id)
        .then((result) => this.respond(req.id, result))
        .catch((err) => this.respond(req.id, undefined, {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        }));
    }
  }
}
