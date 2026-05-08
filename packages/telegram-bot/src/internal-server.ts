import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CodeStore } from "./state/code-store.js";

export type InternalServerOptions = {
  codeStore: CodeStore;
  secret: string;
  port: number;
  host?: string;
  logger?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
};

export type InternalServerHandle = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function handleResolveCode(
  req: IncomingMessage,
  res: ServerResponse,
  opts: InternalServerOptions,
): void {
  const provided = req.headers["x-internal-secret"];
  if (typeof provided !== "string" || provided !== opts.secret) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://internal");
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code) {
    send(res, 400, { error: "missing code" });
    return;
  }
  const entry = opts.codeStore.consume(code);
  if (!entry) {
    send(res, 404, { error: "code not found or expired" });
    return;
  }
  send(res, 200, {
    tgChatId: entry.chatId,
    tgUserId: entry.tgUserId ?? null,
    tgUsername: entry.tgUsername ?? null,
  });
}

export function createInternalServer(opts: InternalServerOptions): Server {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      if (req.method === "GET" && url.pathname === "/internal/resolve-code") {
        handleResolveCode(req, res, opts);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      opts.logger?.error("internal-server error", err);
      send(res, 500, { error: "internal error" });
    }
  });
}

export async function startInternalServer(
  opts: InternalServerOptions,
): Promise<InternalServerHandle> {
  const server = createInternalServer(opts);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, opts.host ?? "127.0.0.1");
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null && "port" in address ? address.port : opts.port;
  opts.logger?.info(`internal-server listening on ${opts.host ?? "127.0.0.1"}:${port}`);
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
