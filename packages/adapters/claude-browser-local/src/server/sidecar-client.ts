/**
 * Thin JSON-RPC 2.0 client that talks to the Playwright sidecar over a Unix socket.
 */

import net from "node:net";
import type { BrowserToolCall, BrowserToolResult } from "./tools/types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class SidecarClient {
  private socketPath: string;
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Sidecar connect timeout (${this.socketPath})`));
      }, CONNECT_TIMEOUT_MS);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.handleData(chunk));
        socket.on("error", (err) => this.handleError(err));
        socket.on("close", () => this.handleClose());
        resolve();
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.call("ping", null);
      return (result as { pong?: boolean }).pong === true;
    } catch {
      return false;
    }
  }

  async callTool(toolCall: BrowserToolCall): Promise<BrowserToolResult> {
    return this.call("browser_tool", toolCall) as Promise<BrowserToolResult>;
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (!this.socket) throw new Error("Not connected to sidecar");

    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call timed out: ${method}`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.socket!.write(msg);
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line) as JsonRpcResponse;
        const handler = this.pending.get(resp.id);
        if (!handler) continue;
        this.pending.delete(resp.id);
        if (resp.error) {
          handler.reject(new Error(resp.error.message));
        } else {
          handler.resolve(resp.result);
        }
      } catch {
        // Malformed line — ignore
      }
    }
  }

  private handleError(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  private handleClose(): void {
    const err = new Error("Sidecar connection closed");
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    this.socket = null;
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
