import { afterEach, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { emailFaultRequestMatches, matchesFaultSend, matchesFaultRead, faultNotification, installOwnedEmailResponseLoss, armOwnedEmailResponseLoss, readOwnedEmailFault, type EmailFaultRequest, type AcceptedEmailFault, type EmailFaultStatus } from "./runtime-email-fault.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
 const nonce = randomUUID(), text = `Self-addressed synthetic fixture ${nonce}`;
 const request: EmailFaultRequest = { schema: "paperclip.email-response-loss.v1", executionId: "chat-features.runner-codex-subscription.local.recovery.unknown-email-outcome", attemptId: "a".repeat(32), companyId: randomUUID(), endpointId: randomUUID(), agentId: randomUUID(), sourceIssueId: randomUUID(), inboxId: "dedicated-qa@example.test", recipient: "dedicated-qa@example.test", subject: `Owned self test ${nonce}`, textSha256: createHash("sha256").update(text).digest("hex"), nonce, createdAt: Date.now() - 1, expiresAt: Date.now() + 60000, dedicatedDisposableInbox: true };
 const publicationId = randomUUID(), url = new URL(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(request.inboxId)}/messages/send`);
 const init: RequestInit = { method: "POST", headers: { "Idempotency-Key": publicationId }, body: JSON.stringify({ to: [request.recipient], subject: request.subject, text, headers: { "X-Paperclip-Publication-Id": publicationId } }) };
 return { request, text, publicationId, url, init };
}
it("accepts only an exact finite owned action and time-bounded self-addressed inbox", () => { const f = fixture(); expect(emailFaultRequestMatches(f.request, f.request)).toBe(true); for (const mutation of [{ executionId: "goals.list" }, { attemptId: "b".repeat(32) }, { dedicatedDisposableInbox: false }, { recipient: "someone-else@example.test" }, { expiresAt: f.request.createdAt + 480001 }, { createdAt: Date.now() + 1000 }, { extra: true }]) expect(emailFaultRequestMatches({ ...f.request, ...mutation } as typeof f.request, f.request)).toBe(false); });
it("never intercepts another publication target, body, provider or recipient", () => { const f = fixture(); expect(matchesFaultSend(f.request, f.url, f.init)).toBe(f.publicationId); expect(matchesFaultSend(f.request, new URL(f.url.href.replace("api.agentmail.to", "another.example.test")), f.init)).toBeUndefined(); expect(matchesFaultSend(f.request, f.url, { ...f.init, method: "GET" })).toBeUndefined(); for (const change of [{ to: ["other@example.test"] }, { text: f.text + "changed" }, { subject: "different" }, { attachments: [{ content: "unapproved" }] }, { headers: { "X-Paperclip-Publication-Id": randomUUID() } }]) expect(matchesFaultSend(f.request, f.url, { ...f.init, body: JSON.stringify({ ...JSON.parse(String(f.init.body)), ...change }) })).toBeUndefined(); });
it("receipt-read outage stays scoped to the selected inbox", () => { const f = fixture(); expect(matchesFaultRead(f.request, new URL(f.url.href.replace(/\/send$/, "/message-id")), "GET")).toBe(true); expect(matchesFaultRead(f.request, new URL("https://api.agentmail.to/v0/auth/me"), "GET")).toBe(false); expect(matchesFaultRead(f.request, new URL("https://api.agentmail.to/v0/inboxes/other/messages"), "GET")).toBe(false); expect(matchesFaultRead(f.request, f.url, "POST")).toBe(false); });
it("uses actual source-qualified message, send and delivery receipt envelopes", () => { for (const value of [{ event_type: "message.sent", send: { inbox_id: "inbox", message_id: "message" } }, { type: "message_received", message: { inbox_id: "inbox", message_id: "message" } }, { event_type: "message.delivered", delivery: { inbox_id: "inbox", message_id: "message" } }]) expect(faultNotification(value)).toEqual({ inboxId: "inbox", messageId: "message" }); expect(faultNotification({ type: "subscribed" })).toBeUndefined(); });
it("installs nothing for default source executions", async () => { const original = globalThis.fetch; expect(await installOwnedEmailResponseLoss({ executionIds: ["goals.list"], attemptId: "", temporaryRoot: "/never-read" })).toBeUndefined(); expect(globalThis.fetch).toBe(original); });
it("forwards exactly one genuine synthetic upstream response, loses it, blocks only same-key retries and records private actual IDs", async () => {
 const f = fixture(), root = await realpath(await mkdtemp(path.join(tmpdir(), "email-loss-control-"))); roots.push(root);
 const previous = globalThis.fetch; let forwarded = 0;
 globalThis.fetch = (async () => { forwarded++; return new Response(JSON.stringify({ message_id: "actual-upstream-message", thread_id: "actual-upstream-thread" }), { status: 202 }); }) as typeof fetch;
 const installed = await installOwnedEmailResponseLoss({ executionIds: [f.request.executionId], attemptId: f.request.attemptId, temporaryRoot: root });
 try {
  await armOwnedEmailResponseLoss(root, f.request);
  await expect(fetch(f.url, f.init)).rejects.toThrow("actual accepted send response was lost");
  const accepted = await readOwnedEmailFault<AcceptedEmailFault>(root, "accepted-private.json"); expect(accepted.publicationId).toBe(f.publicationId); expect(accepted.providerMessageId).toBe("actual-upstream-message");
  await expect(fetch(f.url, f.init)).rejects.toThrow("original persisted send response remains unavailable");
  await expect(fetch(new URL(f.url.href.replace(/\/send$/, "")))).rejects.toThrow("receipt transport unavailable");
  expect(forwarded).toBe(1);
  const other = randomUUID(), response = await fetch(f.url, { ...f.init, headers: { "Idempotency-Key": other }, body: JSON.stringify({ ...JSON.parse(String(f.init.body)), headers: { "X-Paperclip-Publication-Id": other } }) }); expect(response.status).toBe(202); expect(forwarded).toBe(2);
  const status = await readOwnedEmailFault<EmailFaultStatus>(root, "status.json"); expect(status.realSendsForwarded).toBe(1);
 } finally { await installed?.close(); globalThis.fetch = previous; }
});
it("withholds only the real accepted message's WebSocket receipt and restores the actual emitter at teardown", async () => {
 const f = fixture(), root = await realpath(await mkdtemp(path.join(tmpdir(), "email-loss-control-"))); roots.push(root);
 const WS = createRequire(new URL("../../../server/package.json", import.meta.url))("ws") as { prototype: EventEmitter }, originalEmit = WS.prototype.emit, previous = globalThis.fetch;
 globalThis.fetch = (async () => new Response(JSON.stringify({ message_id: "accepted-id", thread_id: "thread-id" }), { status: 200 })) as typeof fetch;
 const installed = await installOwnedEmailResponseLoss({ executionIds: [f.request.executionId], attemptId: f.request.attemptId, temporaryRoot: root });
 try {
  await armOwnedEmailResponseLoss(root, f.request); await expect(fetch(f.url, f.init)).rejects.toThrow("response was lost");
  const socket = Object.setPrototypeOf(new EventEmitter(), WS.prototype) as EventEmitter & { _url: string }; socket._url = "wss://ws.agentmail.to/v0"; let observed = 0; socket.on("message", () => { observed++; });
  socket.emit("message", Buffer.from(JSON.stringify({ event_type: "message.sent", send: { inbox_id: f.request.inboxId, message_id: "accepted-id" } })));
  expect(observed).toBe(0);
  socket.emit("message", Buffer.from(JSON.stringify({ event_type: "message.sent", send: { inbox_id: f.request.inboxId, message_id: "unrelated-id" } })));
  socket.emit("message", Buffer.from(JSON.stringify({ event_type: "message.sent", send: { inbox_id: "other-inbox", message_id: "accepted-id" } })));
  expect(observed).toBe(2);
 } finally { await installed?.close(); globalThis.fetch = previous; }
 expect(WS.prototype.emit).toBe(originalEmit);
});
