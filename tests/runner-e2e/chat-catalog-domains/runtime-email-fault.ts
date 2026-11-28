/** Finite test-server network loss for one actual self-addressed AgentMail send.
 * No provider success, publication, delivery, or DB status is manufactured. */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
export const lostEmailScenario = "recovery.unknown-email-outcome";
export interface EmailFaultRequest { schema: "paperclip.email-response-loss.v1"; executionId: string; attemptId: string; companyId: string; endpointId: string; agentId: string; sourceIssueId: string; inboxId: string; recipient: string; subject: string; textSha256: string; nonce: string; createdAt: number; expiresAt: number; dedicatedDisposableInbox: true }
export interface AcceptedEmailFault { schema: "paperclip.email-response-loss-accepted.v1"; executionId: string; attemptId: string; nonce: string; publicationId: string; providerMessageId: string; providerThreadId: string; upstreamStatus: number; acceptedAt: number; acceptedResponseSha256: string }
export interface EmailFaultStatus { schema: "paperclip.email-response-loss-status.v1"; executionId: string; attemptId: string; nonce: string; realSendsForwarded: number; sameKeyRetriesBlocked: number; receiptReadsBlocked: number; matchingNotificationsWithheld: number; unrelatedNotificationsForwarded: number; released: boolean; expired: boolean }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const uuid = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const keys = (value: unknown, expected: string[]) => !!value && typeof value === "object" && Object.keys(value).sort().join() === expected.sort().join();
export function emailFaultRequestMatches(value: EmailFaultRequest, expected: { executionId: string; attemptId: string }, now = Date.now()) {
  return keys(value, ["schema", "executionId", "attemptId", "companyId", "endpointId", "agentId", "sourceIssueId", "inboxId", "recipient", "subject", "textSha256", "nonce", "createdAt", "expiresAt", "dedicatedDisposableInbox"]) && value.schema === "paperclip.email-response-loss.v1" && value.executionId === expected.executionId && value.executionId.endsWith(`.local.${lostEmailScenario}`) && value.attemptId === expected.attemptId && /^[a-f0-9]{32}$/.test(value.attemptId)
    && [value.companyId, value.endpointId, value.agentId, value.sourceIssueId, value.nonce].every(uuid) && value.dedicatedDisposableInbox === true && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.inboxId) && value.recipient === value.inboxId
    && value.subject.includes(value.nonce) && value.subject.length <= 200 && !/[\r\n]/.test(value.subject) && /^[a-f0-9]{64}$/.test(value.textSha256) && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.expiresAt) && value.createdAt <= now && now < value.expiresAt && value.expiresAt - value.createdAt <= 480000;
}
export function matchesFaultSend(request: EmailFaultRequest, url: URL, init: RequestInit | undefined) {
  if (url.origin !== "https://api.agentmail.to" || url.pathname !== `/v0/inboxes/${encodeURIComponent(request.inboxId)}/messages/send` || url.search || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 131072) return undefined;
  try {
    const body = JSON.parse(init.body), key = new Headers(init.headers).get("Idempotency-Key"), publication = body.headers?.["X-Paperclip-Publication-Id"];
    return key && uuid(key) && publication === key && JSON.stringify(body.to) === JSON.stringify([request.recipient]) && !body.cc?.length && !body.bcc?.length && !body.attachments?.length && body.subject === request.subject && typeof body.text === "string" && hash(body.text) === request.textSha256 ? key : undefined;
  } catch { return undefined; }
}
export function matchesFaultRead(request: EmailFaultRequest, url: URL, method: string) { return url.origin === "https://api.agentmail.to" && method === "GET" && (url.pathname === `/v0/inboxes/${encodeURIComponent(request.inboxId)}/messages` || url.pathname.startsWith(`/v0/inboxes/${encodeURIComponent(request.inboxId)}/messages/`) || url.pathname.startsWith(`/v0/inboxes/${encodeURIComponent(request.inboxId)}/threads/`)); }
export function faultNotification(value: unknown): { inboxId: string; messageId: string } | undefined {
  const event = value as { event_type?: string; type?: string; message?: unknown; send?: unknown; delivery?: unknown; bounce?: unknown; complaint?: unknown; reject?: unknown };
  const kind = event?.event_type ?? event?.type?.replace(/^message_/, "message."), item = kind === "message.sent" ? event.send ?? event.message : kind === "message.delivered" ? event.delivery ?? event.message : kind === "message.bounced" ? event.bounce ?? event.message : kind === "message.complained" ? event.complaint ?? event.message : kind === "message.rejected" ? event.reject ?? event.message : kind === "message.received" ? event.message : undefined;
  const msg = item as { inbox_id?: unknown; message_id?: unknown } | undefined;
  return typeof msg?.inbox_id === "string" && typeof msg.message_id === "string" ? { inboxId: msg.inbox_id, messageId: msg.message_id } : undefined;
}
export function emailFaultDirectory(temporaryRoot: string) { return path.join(temporaryRoot, "email-response-loss"); }
async function atomic(directory: string, name: string, value: unknown) { const filename = path.join(directory, `${name}.${randomUUID()}.tmp`); await writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(filename, path.join(directory, name)); }
function privateRead<T>(filename: string): T {
  const folder = path.dirname(filename), dir = lstatSync(folder), file = lstatSync(filename);
  if (!dir.isDirectory() || dir.mode & 0o077 || dir.uid !== process.getuid?.() || realpathSync(folder) !== folder || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.mode & 0o077 || file.size > 32768) throw new Error("Email fault private control ownership changed");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd); if (before.ino !== file.ino || before.dev !== file.dev) throw new Error("Private email fault control changed before read"); const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(filename); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || named.ino !== before.ino || named.dev !== before.dev) throw new Error("Private email fault control changed during read"); return JSON.parse(bytes.toString("utf8")) as T; } finally { closeSync(fd); }
}
/** Called ONLY by server-entry before production service construction. Other
 * executions install no wrapper, timer, socket hook or private control files. */
export async function installOwnedEmailResponseLoss(input: { executionIds: string[]; attemptId: string; temporaryRoot: string }) {
  if (!input.executionIds.some(id => id.endsWith(`.local.${lostEmailScenario}`))) return undefined;
  if (input.executionIds.length !== 1 || !/^[a-f0-9]{32}$/.test(input.attemptId) || !path.isAbsolute(input.temporaryRoot) || realpathSync(input.temporaryRoot) !== input.temporaryRoot) throw new Error("Email transport loss requires its exact selected owned attempt");
  const directory = emailFaultDirectory(input.temporaryRoot); await mkdir(directory, { mode: 0o700 });
  const WebSocket = createRequire(new URL("../../../server/package.json", import.meta.url))("ws") as { prototype: EventEmitter };
  const originalFetch = globalThis.fetch, originalEmit = WebSocket.prototype.emit;
  let request: EmailFaultRequest | undefined, accepted: AcceptedEmailFault | undefined, publicationId: string | undefined, inflight: Promise<void> | undefined, settle: (() => void) | undefined;
  let status: EmailFaultStatus | undefined, closed = false, pendingNotifications = 0, write = Promise.resolve();
  const save = () => { if (status) { const snapshot = { ...status }; write = write.then(() => atomic(directory, "status.json", snapshot)); } };
  const load = () => { if (request || closed) return request; try { const value = privateRead<EmailFaultRequest>(path.join(directory, "request.json")); if (!emailFaultRequestMatches(value, { executionId: input.executionIds[0]!, attemptId: input.attemptId })) throw new Error("Email network fault request binding is stale or undeclared"); request = value; status = { schema: "paperclip.email-response-loss-status.v1", executionId: value.executionId, attemptId: value.attemptId, nonce: value.nonce, realSendsForwarded: 0, sameKeyRetriesBlocked: 0, receiptReadsBlocked: 0, matchingNotificationsWithheld: 0, unrelatedNotificationsForwarded: 0, released: false, expired: false }; save(); return request; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const release = async (expired = false) => { if (closed) return; closed = true; if (status) { status.released = true; status.expired = expired; save(); } if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch; if (WebSocket.prototype.emit === wrappedEmit) WebSocket.prototype.emit = originalEmit; clearInterval(timer); settle?.(); await write; await atomic(directory, "closed.json", { executionId: input.executionIds[0], attemptId: input.attemptId, nonce: request?.nonce ?? null, released: true, expired }); };
  const wrappedFetch: typeof fetch = async (target, init) => {
    const req = load(); if (!req || closed) return originalFetch(target, init);
    if (Date.now() >= req.expiresAt) { await release(true); return originalFetch(target, init); }
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url), method = init?.method ?? (target instanceof Request ? target.method : "GET"), candidate = matchesFaultSend(req, url, init);
    if (matchesFaultRead(req, url, method) && publicationId) { status!.receiptReadsBlocked++; save(); await write; throw new TypeError("Selected inbox receipt transport unavailable during the declared bounded outage"); }
    if (!candidate || publicationId && candidate !== publicationId) return originalFetch(target, init);
    if (publicationId) { status!.sameKeyRetriesBlocked++; save(); await write; throw new TypeError("The original persisted send response remains unavailable during the bounded outage"); }
    publicationId = candidate; inflight = new Promise(resolve => { settle = resolve; }); status!.realSendsForwarded++; save();
    try {
      const response = await originalFetch(target, init);
      if (!response.ok) return response;
      const reader = response.clone().body?.getReader(); if (!reader) throw new Error("Actual accepted provider response has no receipt body");
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32768) throw new Error("Accepted AgentMail response exceeded the bounded private receipt"); chunks.push(next.value); } } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as { message_id?: unknown; thread_id?: unknown };
      if (typeof body.message_id !== "string" || typeof body.thread_id !== "string" || !body.message_id || !body.thread_id || body.message_id.length > 998 || body.thread_id.length > 998) throw new Error("Real provider accepted send without a valid actual message/thread receipt");
      accepted = { schema: "paperclip.email-response-loss-accepted.v1", executionId: req.executionId, attemptId: req.attemptId, nonce: req.nonce, publicationId, providerMessageId: body.message_id, providerThreadId: body.thread_id, upstreamStatus: response.status, acceptedAt: Date.now(), acceptedResponseSha256: hash(Buffer.from(bytes)) };
      await atomic(directory, "accepted-private.json", accepted); await write;
      throw new TypeError("The actual accepted send response was lost in the declared selected-inbox network outage");
    } finally { settle?.(); }
  };
  const wrappedEmit: EventEmitter["emit"] = function (this: EventEmitter, event, ...args) {
    const req = request;
    if (event !== "message" || !req || closed || String((this as EventEmitter & { url?: string }).url) !== "wss://ws.agentmail.to/v0") return originalEmit.call(this, event, ...args);
    const data = args[0]; if (!Buffer.isBuffer(data) && typeof data !== "string" || Buffer.byteLength(data as string | Buffer) > 131072) return originalEmit.call(this, event, ...args);
    let notification: ReturnType<typeof faultNotification>; try { notification = faultNotification(JSON.parse(String(data))); } catch { return originalEmit.call(this, event, ...args); }
    if (notification?.inboxId !== req.inboxId || !publicationId) return originalEmit.call(this, event, ...args);
    const deliver = () => { if (!closed && accepted?.providerMessageId === notification!.messageId) { status!.matchingNotificationsWithheld++; save(); return; } status!.unrelatedNotificationsForwarded++; save(); originalEmit.call(this, event, ...args); };
    if (!accepted && inflight) { if (++pendingNotifications > 128) { void release(true); return originalEmit.call(this, event, ...args); } void inflight.then(() => { pendingNotifications--; deliver(); }); return true; }
    if (accepted?.providerMessageId === notification.messageId) { status!.matchingNotificationsWithheld++; save(); return true; }
    return originalEmit.call(this, event, ...args);
  };
  globalThis.fetch = wrappedFetch; WebSocket.prototype.emit = wrappedEmit;
  await atomic(directory, "installed.json", { schema: "paperclip.email-response-loss-installed.v1", executionId: input.executionIds[0], attemptId: input.attemptId, pid: process.pid });
  const timer = setInterval(() => { void (async () => { const req = load(); if (closed || !req) return; let released: { executionId?: string; attemptId?: string; nonce?: string; release?: boolean } | undefined; try { released = privateRead(path.join(directory, "release.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } if (released) { if (!keys(released, ["executionId", "attemptId", "nonce", "release"]) || released.executionId !== req.executionId || released.attemptId !== req.attemptId || released.nonce !== req.nonce || released.release !== true) throw new Error("Email outage release does not bind this exact action"); await release(); } else if (Date.now() >= req.expiresAt) await release(true); })().catch(() => { void release(true); }); }, 200); timer.unref();
  return { directory, close: release };
}
export async function armOwnedEmailResponseLoss(temporaryRoot: string, request: EmailFaultRequest) { if (!emailFaultRequestMatches(request, request)) throw new Error("Cannot arm an undeclared or unsafe email outage"); const directory = emailFaultDirectory(temporaryRoot); const info = lstatSync(directory); if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.() || realpathSync(directory) !== directory) throw new Error("Selected test-server email fault hook is not installed in its owned private directory"); await atomic(directory, "request.json", request); }
export async function readOwnedEmailFault<T>(temporaryRoot: string, name: "accepted-private.json" | "status.json" | "closed.json" | "installed.json") { return privateRead<T>(path.join(emailFaultDirectory(temporaryRoot), name)); }
export async function releaseOwnedEmailResponseLoss(temporaryRoot: string, request: EmailFaultRequest) { await atomic(emailFaultDirectory(temporaryRoot), "release.json", { executionId: request.executionId, attemptId: request.attemptId, nonce: request.nonce, release: true }); const deadline = Date.now() + 10000; while (Date.now() < deadline) { try { const result = await readOwnedEmailFault<{ executionId: string; attemptId: string; nonce: string; released: boolean; expired: boolean }>(temporaryRoot, "closed.json"); if (result.executionId !== request.executionId || result.attemptId !== request.attemptId || result.nonce !== request.nonce || result.released !== true || result.expired !== false) throw new Error("The exact email fault did not release cleanly within its declared phase"); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("The exact owned email outage release was not confirmed"); }
