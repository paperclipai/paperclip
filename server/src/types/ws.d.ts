declare module "ws" {
  import type { IncomingMessage } from "http";
  import type { Duplex } from "stream";

  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    terminate(): void;
    ping(): void;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer {
    readonly clients: Set<WebSocket>;
    constructor(options: { noServer?: boolean; [key: string]: unknown });
    on(event: "connection", listener: (socket: WebSocket, req: IncomingMessage) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (ws: WebSocket) => void,
    ): void;
    emit(event: string, ...args: unknown[]): boolean;
    close(callback?: () => void): void;
  }
}
