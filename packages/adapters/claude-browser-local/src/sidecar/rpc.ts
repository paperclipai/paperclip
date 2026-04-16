/**
 * Minimal JSON-RPC 2.0 server over a Unix domain socket.
 *
 * Frame format: each message is a length-prefixed JSON line —
 *   <4-byte big-endian uint32 content length>\n<JSON body>\n
 *
 * If the adapter sends line-delimited JSON without a length prefix the server
 * falls back to newline framing automatically.
 */

import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcServer {
  private server: net.Server;
  private socketPath: string;
  private handler: RpcHandler;

  constructor(socketPath: string, handler: RpcHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async listen(): Promise<void> {
    // Remove stale socket file if present
    if (existsSync(this.socketPath)) {
      await fs.unlink(this.socketPath);
    }
    await fs.mkdir(
      this.socketPath.substring(0, this.socketPath.lastIndexOf("/")),
      { recursive: true },
    );

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        this.handleLine(socket, line);
      }
    });

    socket.on("error", () => {
      /* ignore client-side disconnects */
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (e) {
      this.send(socket, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.send(socket, {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    try {
      const result = await this.handler(req.method, req.params ?? null);
      if (req.id !== undefined) {
        this.send(socket, { jsonrpc: "2.0", id: req.id, result });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (req.id !== undefined) {
        this.send(socket, {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32000, message },
        });
      }
    }
  }

  private send(socket: net.Socket, response: JsonRpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // Socket may be closed
    }
  }
}
