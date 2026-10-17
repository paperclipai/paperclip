import { createReadStream, chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MANAGED_DATABASE_HTTP, MANAGED_DATABASE_MAX_COMMAND_BYTES } from "@paperclipai/shared/managed-database";
import type { CommandResponse, ManagedDatabaseSupervisor } from "./supervisor.js";

const MAX_COMMAND_BYTES = MANAGED_DATABASE_MAX_COMMAND_BYTES;

export type ControlServerLimits = {
  /** Time allowed to receive an upload's command line, before it is authenticated. */
  uploadPreambleTimeoutMs?: number;
  /** Uploads whose command line is still being read; more are refused. */
  maxPendingUploads?: number;
};

const DEFAULT_UPLOAD_PREAMBLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_UPLOADS = 4;

function send(res: ServerResponse, response: CommandResponse, req?: IncomingMessage): void {
  const payload = JSON.stringify(response.body);
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  // The body was not read and will not be: answer, then drop the connection
  // rather than let Node drain whatever the caller keeps sending.
  if (response.closeConnection) headers.connection = "close";
  res.writeHead(response.status, headers);
  if (response.closeConnection && req) res.once("finish", () => req.destroy());
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_COMMAND_BYTES) throw new Error("command body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Split a PUT archive body into its command preamble (one line of JSON) and
 * the archive stream that follows it.
 */
export async function readUploadPreamble(body: Readable): Promise<{ command: unknown; archive: Readable }> {
  const chunks = body[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let newline = -1;
  while (newline < 0) {
    const next = await chunks.next();
    if (next.done) throw new Error("upload body ended before its command line");
    head = Buffer.concat([head, next.value as Buffer]);
    newline = head.indexOf(0x0a);
    if (newline < 0 && head.length > MAX_COMMAND_BYTES) throw new Error("upload command line too large");
  }
  if (newline > MAX_COMMAND_BYTES) throw new Error("upload command line too large");
  const command: unknown = JSON.parse(head.subarray(0, newline).toString("utf8"));
  const rest = head.subarray(newline + 1);
  const archive = Readable.from((async function* () {
    if (rest.length > 0) yield rest;
    for (;;) {
      const next = await chunks.next();
      if (next.done) return;
      yield next.value as Buffer;
    }
  })());
  return { command, archive };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The supervisor's HTTP surface. It exposes exactly the signed command API,
 * archive transfer, and a minimal health probe; there is no shell or SQL
 * passthrough. `maintenanceSurface` additionally answers the app's public
 * health path while no app is running.
 */
export function createControlHandler(
  supervisor: ManagedDatabaseSupervisor,
  maintenanceSurface: () => boolean,
  limits: ControlServerLimits = {},
) {
  const preambleTimeoutMs = limits.uploadPreambleTimeoutMs ?? DEFAULT_UPLOAD_PREAMBLE_TIMEOUT_MS;
  const maxPendingUploads = limits.maxPendingUploads ?? DEFAULT_MAX_PENDING_UPLOADS;
  let pendingUploads = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === MANAGED_DATABASE_HTTP.health || (url.pathname === "/api/health" && maintenanceSurface()))) {
        send(res, { status: 200, body: supervisor.publicHealth() });
        return;
      }
      if (req.method === "POST" && url.pathname === MANAGED_DATABASE_HTTP.command) {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, { status: 400, body: { outcome: "rejected", code: "invalid_command", error: "body must be JSON" } });
          return;
        }
        send(res, await supervisor.handleCommand(body, header(req, MANAGED_DATABASE_HTTP.signatureHeader)));
        return;
      }
      if (url.pathname === MANAGED_DATABASE_HTTP.archive && (req.method === "GET" || req.method === "PUT")) {
        const signature = header(req, MANAGED_DATABASE_HTTP.signatureHeader);
        if (req.method === "PUT") {
          // Until its command line is authenticated an upload is anonymous:
          // bound how many may wait, how long, and (in readUploadPreamble) how
          // many bytes they may send.
          if (pendingUploads >= maxPendingUploads) {
            send(res, { status: 503, body: { outcome: "rejected", code: "busy", error: "too many uploads in progress" }, closeConnection: true }, req);
            return;
          }
          pendingUploads += 1;
          let upload: Awaited<ReturnType<typeof readUploadPreamble>>;
          let timedOut = false;
          const deadline = setTimeout(() => {
            timedOut = true;
            req.destroy();
          }, preambleTimeoutMs);
          try {
            upload = await readUploadPreamble(req);
          } catch {
            if (timedOut) return; // The connection is already gone.
            send(res, {
              status: 400,
              body: { outcome: "rejected", code: "invalid_command", error: "upload body must start with one line of command JSON" },
              closeConnection: true,
            }, req);
            return;
          } finally {
            clearTimeout(deadline);
            pendingUploads -= 1;
          }
          send(res, await supervisor.handleArchiveUpload(upload.command, signature, upload.archive), req);
          return;
        }
        const opened = supervisor.openArchiveDownload(header(req, MANAGED_DATABASE_HTTP.commandHeader), signature);
        if (!opened.ok) {
          send(res, opened.response);
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(opened.sizeBytes),
          [MANAGED_DATABASE_HTTP.archiveSha256Header]: opened.sha256,
          "cache-control": "no-store",
        });
        // The descriptor was opened before the headers, so a concurrent
        // delete cannot fail the stream; a read error only ends this response.
        await pipeline(createReadStream("", { fd: opened.fd }), res).catch(() => res.destroy());
        return;
      }
      if (maintenanceSurface()) {
        send(res, { status: 503, body: { status: supervisor.publicHealth().status, error: "stack is in database maintenance" } });
        return;
      }
      send(res, { status: 404, body: { error: "not found" } });
    } catch (error) {
      if (!res.headersSent) send(res, { status: 500, body: { error: error instanceof Error ? error.message : "internal error" } });
      else res.destroy();
    }
  };
}

export async function listenUnix(server: Server, socketPath: string): Promise<void> {
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Any local user may connect: every command is authenticated by HMAC, so
  // the socket grants reachability, not authority.
  chmodSync(socketPath, 0o666);
}

export async function listenTcp(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function createControlServer(
  supervisor: ManagedDatabaseSupervisor,
  maintenanceSurface: () => boolean,
  limits: ControlServerLimits = {},
): Server {
  const handler = createControlHandler(supervisor, maintenanceSurface, limits);
  return createServer((req, res) => {
    void handler(req, res);
  });
}

export async function closeServer(server: Server | null): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
