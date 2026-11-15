import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { linkRates, paced, releaseLinks, type LinkRates } from "./storage-bandwidth.js";
import { ReadAfterWriteTracker } from "./storage-lag.js";
import { partNumberOf, s3Operation, type S3Operation } from "./storage-s3-ops.js";

export type StorageFault =
  | { kind: "pass" }
  | { kind: "outage"; status?: number }
  | { kind: "latency"; ms: number; jitterMs?: number; bytesPerSecond?: number }
  | { kind: "errors"; rate: number; status?: number; slowDown?: boolean }
  | { kind: "reset" }
  | { kind: "expired_credentials"; code?: CredentialErrorCode }
  | { kind: "credential_rotation" }
  | { kind: "truncate"; afterBytes: number }
  | { kind: "read_after_write_lag"; lagMs: number }
  | { kind: "throttle" };

export const CREDENTIAL_ERROR_CODES = ["ExpiredToken", "InvalidAccessKeyId", "SignatureDoesNotMatch"] as const;
export type CredentialErrorCode = typeof CREDENTIAL_ERROR_CODES[number];
const CREDENTIAL_ERROR_MESSAGES: Record<CredentialErrorCode, string> = {
  ExpiredToken: "The provided token has expired.",
  InvalidAccessKeyId: "The Access Key Id you provided does not exist in our records.",
  SignatureDoesNotMatch: "The request signature we calculated does not match the signature you provided.",
};

export interface StorageFaultRule { fault: StorageFault; methods?: readonly string[]; pathIncludes?: string; remaining?: number;
  operations?: readonly S3Operation[]; partNumbers?: readonly number[]; firstObjectOnly?: boolean; pinnedObject?: string }

export type StorageRequestListener = (incoming: IncomingMessage, outgoing: ServerResponse) => number | void;

export interface StorageProxyCounts { requests: number; injected: number; byMethod: Record<string, number>; byStatus: Record<string, number>;
  injectedBy?: Record<string, number> }

const XML = "application/xml";
function s3Error(code: string, message: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

export function faultResponse(fault: StorageFault): { status: number; body: string } | "reset" | null {
  switch (fault.kind) {
    case "outage": return { status: fault.status ?? 503, body: s3Error("ServiceUnavailable", "Injected storage outage") };
    case "expired_credentials": {
      const code = fault.code ?? "ExpiredToken";
      return { status: 403, body: s3Error(code, CREDENTIAL_ERROR_MESSAGES[code]) };
    }
    case "reset": return "reset";
    default: return null;
  }
}

export function matches(rule: StorageFaultRule, method: string, url: string): boolean {
  if (rule.remaining !== undefined && rule.remaining <= 0) return false;
  if (rule.methods && !rule.methods.includes(method)) return false;
  if (rule.operations && !rule.operations.includes(s3Operation(method, url))) return false;
  if (rule.partNumbers && !rule.partNumbers.includes(partNumberOf(url) ?? 0)) return false;
  if (rule.pinnedObject !== undefined && url.split("?")[0] !== rule.pinnedObject) return false;
  return !rule.pathIncludes || url.includes(rule.pathIncludes);
}

export async function startStorageFaultProxy(endpoint: string, random: () => number = Math.random,
  writes: ReadAfterWriteTracker = new ReadAfterWriteTracker()) {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error("Storage fault injection requires a loopback store");
  }
  let rules: StorageFaultRule[] = [];
  let listener: StorageRequestListener | null = null;
  const counts: StorageProxyCounts = { requests: 0, injected: 0, byMethod: {}, byStatus: {}, injectedBy: {} };
  const sockets = new Set<Socket>();
  const delayed = new Set<ReturnType<typeof setTimeout>>();
  const agent = new Agent({ keepAlive: true });
  const links = new Map<StorageFaultRule, LinkRates>();
  const endLinks = () => { releaseLinks(links.values()); links.clear(); };
  const note = (method: string, status: number | "reset", injected: boolean, cause?: string) => {
    counts.requests += 1;
    counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
    counts.byStatus[String(status)] = (counts.byStatus[String(status)] ?? 0) + 1;
    if (injected) counts.injected += 1;
    if (cause) counts.injectedBy![cause] = (counts.injectedBy![cause] ?? 0) + 1;
  };
  const forward = (incoming: IncomingMessage, outgoing: ServerResponse, link?: LinkRates) => {
    const upstream = request(target, { method: incoming.method, path: incoming.url, headers: incoming.headers, agent }, response => {
      response.on("error", () => outgoing.destroy());
      note(incoming.method ?? "GET", response.statusCode ?? 502, false);
      writes.note(incoming.method ?? "GET", incoming.url ?? "/", response.statusCode ?? 502);
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      (link ? response.pipe(paced(link.down)) : response).pipe(outgoing);
    });
    upstream.on("error", () => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      note(incoming.method ?? "GET", 502, false);
      outgoing.writeHead(502).end();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
    (link ? incoming.pipe(paced(link.up)) : incoming).pipe(upstream);
  };
  const server = createServer((incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    const heldMs = listener?.(incoming, outgoing) || 0;
    const rule = heldMs ? undefined : rules.find(candidate => matches(candidate, method, incoming.url ?? "/"));
    if (rule?.remaining !== undefined) rule.remaining -= 1;
    if (rule?.firstObjectOnly && rule.pinnedObject === undefined) rule.pinnedObject = (incoming.url ?? "/").split("?")[0];
    const fault: StorageFault = heldMs ? { kind: "latency", ms: heldMs } : rule?.fault ?? { kind: "pass" };
    if (fault.kind === "latency") {
      const delay = fault.ms + Math.round((fault.jitterMs ?? 0) * random());
      if (fault.bytesPerSecond && !links.has(rule!)) links.set(rule!, linkRates(fault.bytesPerSecond));
      incoming.pause();
      const timer = setTimeout(() => {
        delayed.delete(timer);
        if (outgoing.destroyed || incoming.destroyed) return;
        incoming.resume();
        forward(incoming, outgoing, links.get(rule!));
      }, delay);
      delayed.add(timer);
      outgoing.on("close", () => { clearTimeout(timer); delayed.delete(timer); });
      return;
    }
    if (fault.kind === "errors" && random() >= fault.rate) { forward(incoming, outgoing); return; }
    if (fault.kind === "read_after_write_lag" && !writes.lagging(incoming.url ?? "/", fault.lagMs)) { forward(incoming, outgoing); return; }
    const cause = `${s3Operation(method, incoming.url ?? "/")}:${fault.kind}`;
    if (fault.kind === "truncate") {
      let seen = 0;
      const cut = () => { if (incoming.socket.destroyed) return; note(method, "reset", true, cause); incoming.socket.destroy(); };
      incoming.on("data", (chunk: Buffer) => { seen += chunk.length; if (seen >= fault.afterBytes) cut(); });
      forward(incoming, outgoing);
      return;
    }
    const injected = fault.kind === "throttle" ? { status: 503, body: s3Error("SlowDown", "Please reduce your request rate.") }
      : fault.kind === "errors"
      ? { status: fault.status ?? 503, body: fault.slowDown ? s3Error("SlowDown", "Please reduce your request rate.") : s3Error("InternalError", "Injected storage error") }
      : fault.kind === "read_after_write_lag" ? { status: 404, body: s3Error("NoSuchKey", "The specified key does not exist.") }
      : faultResponse(fault);
    if (!injected) { forward(incoming, outgoing); return; }
    incoming.resume();
    if (injected === "reset") { note(method, "reset", true, cause); incoming.socket.destroy(); return; }
    note(method, injected.status, true, cause);
    outgoing.writeHead(injected.status, { "content-type": XML, "content-length": Buffer.byteLength(injected.body) }).end(injected.body);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Storage proxy did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    counts: () => ({ ...structuredClone(counts), lagged: writes.lagged }),
    setRules(next: readonly StorageFaultRule[]) { endLinks(); rules = next.map(rule => ({ ...rule })); },
    clear() { endLinks(); rules = []; },
    observe(next: StorageRequestListener | null) { listener = next; },
    async close() {
      for (const timer of delayed) clearTimeout(timer);
      delayed.clear();
      const closed = once(server, "close"); server.close(); agent.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
