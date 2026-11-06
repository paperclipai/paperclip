import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { listenOnFetchAllowedPort } from "../../e2e/fetch-allowed-port.js";
export interface ArchiveTransportReceipt { requestId: string; sequence: number; taskId: string; phase: "initial" | "retry"; requestSha256: string; runId?: string; explicitUserId?: string; forwarded: boolean; status?: number; completedAt: string }
export interface ArchiveBinding { companyId: string; agentId: string; personId: string; taskIds: string[] }
export interface ArchiveFaultTransport { origin: string; backendOrigin: string; arm(input: ArchiveBinding): Promise<void>; receipts(): Promise<ArchiveTransportReceipt[]>; releaseForExplicitRetry(): Promise<void>; close(): Promise<void> }
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export function validArchiveBinding(value: ArchiveBinding) { return !!value && Object.keys(value).sort().join() === "agentId,companyId,personId,taskIds" && uuid(value.companyId) && uuid(value.agentId) && typeof value.personId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.personId) && Array.isArray(value.taskIds) && value.taskIds.length === 3 && value.taskIds.every(uuid) && new Set(value.taskIds).size === 3; }
/** Started by the single-case launcher before backend bootstrap. No public action
 * or actor is invented: identity probes use the original authenticated request. */
export async function startArchiveFaultProxy(backendOrigin: string): Promise<ArchiveFaultTransport> {
  const upstream = new URL(backendOrigin);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port || upstream.pathname !== "/" || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error("Archive proxy requires the exact owned loopback backend origin");
  const receipts: ArchiveTransportReceipt[] = []; let binding: ArchiveBinding | undefined; let released = false; let failedTaskId: string | undefined;
  let serial = Promise.resolve(); const shutdown = new AbortController(); let closing = false; const successes = new Set<string>(); const sockets = new Set<Socket>();
  const target = (url: string | undefined) => url?.startsWith("/") && !url.startsWith("//") && new URL(url, upstream).origin === upstream.origin ? new URL(url, upstream) : null;
  const forward = (req: IncomingMessage, res: ServerResponse, bytes?: Buffer, receipt?: ArchiveTransportReceipt, continueBody = false) => new Promise<void>(resolve => {
    if (closing) { req.socket.destroy(); resolve(); return; }
    const url = target(req.url); if (!url) { res.writeHead(400); res.end(); resolve(); return; }
    const outgoing = httpRequest(url, { method: req.method, headers: { ...req.headers, host: upstream.host } }, incoming => {
      if (receipt) receipt.status = incoming.statusCode;
      res.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(res);
      const done = () => { if (receipt && !receipt.completedAt) { receipt.completedAt = new Date().toISOString(); receipts.push(receipt); if (incoming.statusCode! >= 200 && incoming.statusCode! < 300) successes.add(receipt.taskId); } resolve(); };
      incoming.on("end", done); incoming.on("error", () => { req.socket.destroy(); resolve(); });
    }); outgoing.on("socket", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }); outgoing.on("error", () => { req.socket.destroy(); resolve(); });
    if (continueBody) { if (bytes) outgoing.write(bytes); req.pipe(outgoing); } else if (bytes) outgoing.end(bytes); else req.pipe(outgoing);
  });
  const identity = async (req: IncomingMessage, runId: string, personId: string) => {
    try {
      const headers: Record<string, string> = {}; for (const name of ["authorization", "x-paperclip-run-id"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name]!;
      const get = async (route: string) => { const response = await fetch(new URL(route, upstream), { headers, redirect: "error", signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]) }); return response.ok ? await response.json() as Record<string, unknown> : null; };
      const agent = await get("/api/agents/me"), run = await get(`/api/heartbeat-runs/${runId}`);
      return agent?.id === binding?.agentId && agent?.companyId === binding?.companyId && run?.id === runId && run?.agentId === binding?.agentId && run?.companyId === binding?.companyId && run?.responsibleUserId === personId;
    } catch { return false; }
  };
  const server = createServer((req, res) => { void (async () => {
    if (!target(req.url)) { res.writeHead(400); res.end(); return; }
    const match = req.method === "POST" ? /^\/api\/issues\/([^/?]+)\/inbox-archive(?:\?.*)?$/.exec(req.url ?? "") : null;
    const taskId = match?.[1];
    if (!taskId || !binding?.taskIds.includes(taskId)) { await forward(req, res); return; }
    // Large/noncanonical requests are ordinary backend traffic, never fault
    // candidates. Keep their original stream and bytes rather than rejecting.
    if (Number(req.headers["content-length"] ?? 0) > 65536) { await forward(req, res); return; }
    const chunks: Buffer[] = []; let size = 0, oversized = false;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length; chunks.push(chunk);
      if (size > 65536) { oversized = true; break; }
    }
    const bytes = Buffer.concat(chunks);
    if (oversized) { await forward(req, res, bytes, undefined, true); return; }
    const prior = serial; let finish!: () => void; serial = new Promise<void>(resolve => { finish = resolve; }); await prior;
    try {
      let explicitUserId: string | undefined, validBody = false;
      try {
        const value: unknown = JSON.parse(bytes.toString());
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          validBody = Object.keys(record).every(key => key === "userId") && (record.userId === undefined || typeof record.userId === "string");
          if (typeof record.userId === "string") explicitUserId = record.userId;
        }
      } catch { /* Backend validation remains authoritative. */ }
      const runId = req.headers["x-paperclip-run-id"];
      if (!validBody || typeof runId !== "string" || !uuid(runId) || explicitUserId !== undefined && explicitUserId !== binding.personId || !await identity(req, runId, binding.personId)) { await forward(req, res, bytes); return; }
      const receipt: ArchiveTransportReceipt = { requestId: randomUUID(), sequence: receipts.length + 1, taskId, phase: released ? "retry" : "initial", requestSha256: createHash("sha256").update(bytes).digest("hex"), runId, explicitUserId, forwarded: false, completedAt: "" };
      if (!released && (failedTaskId === taskId || !successes.has(taskId) && successes.size === 2)) { failedTaskId = taskId; receipt.completedAt = new Date().toISOString(); receipts.push(receipt); req.socket.destroy(); return; }
      receipt.forwarded = true; await forward(req, res, bytes, receipt);
    } finally { finish(); }
  })().catch(() => { req.socket.destroy(); }); });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  // Native control transport may upgrade on the same API origin. Forward only
  // to this exact backend; retain no raw headers, credentials or frame bytes.
  server.on("upgrade", (req, socket, head) => {
    if (!target(req.url)) { socket.destroy(); return; }
    const outgoing = connect(Number(upstream.port), "127.0.0.1", () => {
      outgoing.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers).map(([name, value]) => `${name}: ${name === "host" ? upstream.host : Array.isArray(value) ? value.join(", ") : value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) outgoing.write(head); socket.pipe(outgoing); outgoing.pipe(socket);
    }); sockets.add(outgoing); outgoing.on("close", () => sockets.delete(outgoing)); outgoing.on("error", () => socket.destroy()); socket.on("error", () => outgoing.destroy()); socket.on("close", () => outgoing.destroy()); outgoing.on("close", () => socket.destroy());
  });
  const port = await listenOnFetchAllowedPort(server);
  return { origin: `http://127.0.0.1:${port}`, backendOrigin: upstream.origin,
    async arm(input) { if (binding || !validArchiveBinding(input)) throw new Error("Transport fault must be armed once for exact owned actor/person and three UUID tasks"); binding = structuredClone(input); },
    async receipts() { return structuredClone(receipts); }, async releaseForExplicitRetry() { if (released || !failedTaskId || successes.size !== 2) throw new Error("Cannot release fault before actual two-success/one-drop boundary"); released = true; },
    async close() { closing = true; shutdown.abort(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await serial; },
  };
}
