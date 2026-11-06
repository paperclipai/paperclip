/** Exact selected network duplicate of one authentic AgentMail sent receipt.
 * The real send and first provider notification are forwarded unchanged. */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { constants, openSync, readFileSync, closeSync, fstatSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { faultNotification } from "./runtime-email-fault.js";
export const duplicateEmailScenario = "chat-channels.outbound-email";
export interface EmailDuplicateRequest { executionId: string; attemptId: string; inboxId: string; marker: string; nonce: string; expiresAt: number }
export interface EmailDuplicateReceipt { executionId: string; attemptId: string; nonce: string; publicationId: string; providerMessageId: string; authenticPayloadSha256: string; injectedDuplicateCount: number; released: boolean; expired: boolean }
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function directory(root: string) { return path.join(root, "email-receipt-duplicate"); }
async function atomic(root: string, name: string, value: unknown) { const target = path.join(directory(root), name), temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
function read<T>(root: string, name: string): T {
 const dir = directory(root), d = lstatSync(dir), target = path.join(dir, name), s = lstatSync(target);
 if (!d.isDirectory() || d.mode & 0o077 || d.uid !== process.getuid?.() || realpathSync(dir) !== dir || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.mode & 0o077 || s.uid !== process.getuid?.() || s.size > 32768) throw new Error("Owned email duplicate control ownership changed");
 const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { const opened = fstatSync(fd); if (opened.ino !== s.ino || opened.dev !== s.dev) throw new Error("Email duplicate control changed before read"); const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(target); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || named.ino !== opened.ino || named.dev !== opened.dev) throw new Error("Email duplicate control changed during read"); return JSON.parse(bytes.toString()) as T; } finally { closeSync(fd); }
}
export function emailDuplicateRequestMatches(r: EmailDuplicateRequest, expected: { executionId: string; attemptId: string }, now = Date.now()) {
 return !!r && Object.keys(r).sort().join() === ["executionId", "attemptId", "inboxId", "marker", "nonce", "expiresAt"].sort().join() && r.executionId === expected.executionId && r.executionId.endsWith(`.local.${duplicateEmailScenario}`) && r.attemptId === expected.attemptId && /^[a-f0-9]{32}$/.test(r.attemptId) && uuid(r.nonce) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.inboxId) && r.marker.includes(r.nonce) && r.marker.length <= 200 && now < r.expiresAt && r.expiresAt <= now + 480000;
}
export function matchesDuplicateSend(r: EmailDuplicateRequest, url: URL, init?: RequestInit) {
 if (url.origin !== "https://api.agentmail.to" || url.pathname !== `/v0/inboxes/${encodeURIComponent(r.inboxId)}/messages/send` || url.search || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > 131072) return undefined;
 try { const body = JSON.parse(init.body), pub = new Headers(init.headers).get("Idempotency-Key"); return uuid(pub) && body.headers?.["X-Paperclip-Publication-Id"] === pub && JSON.stringify(body.to) === JSON.stringify([r.inboxId]) && !body.cc?.length && !body.bcc?.length && typeof body.text === "string" && body.text.includes(r.marker) ? pub! : undefined; } catch { return undefined; }
}
export async function installOwnedEmailReceiptDuplicate(input: { executionIds: string[]; attemptId: string; temporaryRoot: string }) {
 if (!input.executionIds.some(id => id.endsWith(`.local.${duplicateEmailScenario}`))) return undefined;
 if (input.executionIds.length !== 1 || !/^[a-f0-9]{32}$/.test(input.attemptId) || !path.isAbsolute(input.temporaryRoot) || realpathSync(input.temporaryRoot) !== input.temporaryRoot) throw new Error("Receipt duplicate requires its exact isolated execution");
 await mkdir(directory(input.temporaryRoot), { mode: 0o700 });
 const WebSocket = createRequire(new URL("../../../server/package.json", import.meta.url))("ws") as { prototype: EventEmitter }, originalEmit = WebSocket.prototype.emit, originalFetch = globalThis.fetch;
 let request: EmailDuplicateRequest | undefined, publicationId: string | undefined, providerMessageId: string | undefined, pending: Promise<void> | undefined, settle: (() => void) | undefined, receipt: EmailDuplicateReceipt | undefined, closed = false, buffered = 0, writes = Promise.resolve();
 const save = () => { if (receipt) { const snapshot = { ...receipt }; writes = writes.then(() => atomic(input.temporaryRoot, "receipt.json", snapshot)); } };
 const load = () => { if (request || closed) return request; try { const r = read<EmailDuplicateRequest>(input.temporaryRoot, "request.json"); if (!emailDuplicateRequestMatches(r, { executionId: input.executionIds[0]!, attemptId: input.attemptId })) throw new Error("Stale or undeclared email duplicate request"); return request = r; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
 const release = async (expired = false) => { if (closed) return; closed = true; clearInterval(timer); if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch; if (WebSocket.prototype.emit === wrappedEmit) WebSocket.prototype.emit = originalEmit; if (receipt) { receipt.released = true; receipt.expired = expired; save(); } await writes; await atomic(input.temporaryRoot, "closed.json", { executionId: input.executionIds[0], attemptId: input.attemptId, nonce: request?.nonce ?? null, released: true, expired }); };
 const wrappedFetch: typeof fetch = async (target, init) => {
  const r = load(); if (!r || closed) return originalFetch(target, init); if (Date.now() >= r.expiresAt) { await release(true); return originalFetch(target, init); }
  const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url), candidate = matchesDuplicateSend(r, url, init);
  if (!candidate || publicationId) return originalFetch(target, init); publicationId = candidate; pending = new Promise(resolve => { settle = resolve; });
  try { const response = await originalFetch(target, init); if (response.ok) { const clone = response.clone(), reader = clone.body?.getReader(); if (!reader) throw new Error("Actual send has no provider receipt"); const parts: Uint8Array[] = []; let size = 0; try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 32768) throw new Error("Actual provider receipt exceeds finite bounds"); parts.push(item.value); } } finally { await reader.cancel(); } const body = JSON.parse(Buffer.concat(parts).toString()) as { message_id?: unknown }; if (typeof body.message_id !== "string" || !body.message_id || body.message_id.length > 998) throw new Error("Actual provider send lacks message identity"); providerMessageId = body.message_id; } return response; } finally { settle?.(); }
 };
 const wrappedEmit: EventEmitter["emit"] = function (this: EventEmitter, event, ...args) {
  const r = request, data = args[0]; if (event !== "message" || !r || closed || String((this as EventEmitter & { url?: string }).url) !== "wss://ws.agentmail.to/v0" || !Buffer.isBuffer(data) && typeof data !== "string" || Buffer.byteLength(data as string | Buffer) > 131072) return originalEmit.call(this, event, ...args);
  let parsed: { event_type?: string; type?: string }; try { parsed = JSON.parse(String(data)); } catch { return originalEmit.call(this, event, ...args); } const notification = faultNotification(parsed);
  if ((parsed.event_type ?? parsed.type?.replace(/^message_/, "message.")) !== "message.sent" || notification?.inboxId !== r.inboxId || !publicationId || receipt) return originalEmit.call(this, event, ...args);
  const deliver = () => { const first = originalEmit.call(this, event, ...args); if (!closed && notification.messageId === providerMessageId && !receipt) { receipt = { executionId: r.executionId, attemptId: r.attemptId, nonce: r.nonce, publicationId: publicationId!, providerMessageId, authenticPayloadSha256: sha(data as string | Buffer), injectedDuplicateCount: 1, released: false, expired: false }; originalEmit.call(this, event, ...args); save(); } return first; };
  if (!providerMessageId && pending) { if (++buffered > 128) { void release(true); return originalEmit.call(this, event, ...args); } void pending.then(() => { buffered--; deliver(); }); return true; } return deliver();
 };
 globalThis.fetch = wrappedFetch; WebSocket.prototype.emit = wrappedEmit;
 const timer = setInterval(() => { void (async () => { const r = load(); if (!r || closed) return; let releaseRequest: { nonce?: string; attemptId?: string; executionId?: string; release?: boolean } | undefined; try { releaseRequest = read(input.temporaryRoot, "release.json"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } if (releaseRequest) { if (Object.keys(releaseRequest).sort().join() !== ["nonce", "attemptId", "executionId", "release"].sort().join() || releaseRequest.nonce !== r.nonce || releaseRequest.attemptId !== r.attemptId || releaseRequest.executionId !== r.executionId || releaseRequest.release !== true) throw new Error("Wrong email duplicate release"); await release(); } else if (Date.now() >= r.expiresAt) await release(true); })().catch(() => { void release(true); }); }, 200); timer.unref();
 await atomic(input.temporaryRoot, "installed.json", { executionId: input.executionIds[0], attemptId: input.attemptId, pid: process.pid }); return { close: release };
}
export async function armOwnedEmailReceiptDuplicate(root: string, request: EmailDuplicateRequest) { if (!emailDuplicateRequestMatches(request, request)) throw new Error("Cannot arm an unsafe email receipt duplicate"); await atomic(root, "request.json", request); }
export function readOwnedEmailDuplicate<T>(root: string, name: "receipt.json" | "installed.json" | "closed.json") { return read<T>(root, name); }
export async function releaseOwnedEmailReceiptDuplicate(root: string, request: EmailDuplicateRequest) { await atomic(root, "release.json", { executionId: request.executionId, attemptId: request.attemptId, nonce: request.nonce, release: true }); const deadline = Date.now() + 10000; while (Date.now() < deadline) { try { const receipt = read<{ executionId: string; attemptId: string; nonce: string; released: boolean; expired: boolean }>(root, "closed.json"); if (receipt.executionId !== request.executionId || receipt.attemptId !== request.attemptId || receipt.nonce !== request.nonce || !receipt.released || receipt.expired) throw new Error("Exact email duplicate teardown failed"); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Email duplicate teardown was not confirmed"); }
