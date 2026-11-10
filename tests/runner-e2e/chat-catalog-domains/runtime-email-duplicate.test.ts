import { expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { emailDuplicateRequestMatches, matchesDuplicateSend, installOwnedEmailReceiptDuplicate, armOwnedEmailReceiptDuplicate, readOwnedEmailDuplicate, type EmailDuplicateRequest, type EmailDuplicateReceipt } from "./runtime-email-duplicate.js";
function fixture() { const nonce = randomUUID(), request: EmailDuplicateRequest = { executionId: "chat-features.runner-codex-subscription.local.chat-channels.outbound-email", attemptId: "a".repeat(32), inboxId: "qa@example.test", marker: `Launch draft ${nonce}`, nonce, expiresAt: Date.now() + 60000 }, publication = randomUUID(), url = new URL(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(request.inboxId)}/messages/send`), init: RequestInit = { method: "POST", headers: { "Idempotency-Key": publication }, body: JSON.stringify({ to: [request.inboxId], text: request.marker, headers: { "X-Paperclip-Publication-Id": publication } }) }; return { request, publication, url, init }; }
it("accepts only exact selected, bounded, attempt-owned receipt duplication", () => { const f = fixture(); expect(emailDuplicateRequestMatches(f.request, f.request)).toBe(true); for (const change of [{ executionId: "goals.list" }, { attemptId: "b".repeat(32) }, { expiresAt: Date.now() - 1 }, { marker: "unrelated draft" }, { extra: true }]) expect(emailDuplicateRequestMatches({ ...f.request, ...change }, f.request)).toBe(false); });
it("observes only the authorized original publication and selected real provider/inbox", () => { const f = fixture(); expect(matchesDuplicateSend(f.request, f.url, f.init)).toBe(f.publication); expect(matchesDuplicateSend(f.request, new URL(f.url.href.replace("api.agentmail.to", "evil.example.test")), f.init)).toBeUndefined(); for (const change of [{ to: ["other@example.test"] }, { text: "wrong draft" }, { headers: { "X-Paperclip-Publication-Id": randomUUID() } }]) expect(matchesDuplicateSend(f.request, f.url, { ...f.init, body: JSON.stringify({ ...JSON.parse(String(f.init.body)), ...change }) })).toBeUndefined(); });
it("installs nothing for unrelated executions", async () => { const original = globalThis.fetch; expect(await installOwnedEmailReceiptDuplicate({ executionIds: ["goals.list"], attemptId: "", temporaryRoot: "/not-read" })).toBeUndefined(); expect(globalThis.fetch).toBe(original); });
it("duplicates one identical authentic receipt only; unrelated and later events remain single, sends remain one", async () => {
 const f = fixture(), root = await realpath(await mkdtemp(path.join(tmpdir(), "email-duplicate-control-"))), prior = globalThis.fetch; let sends = 0;
 globalThis.fetch = (async () => { sends++; return new Response(JSON.stringify({ message_id: "actual-message", thread_id: "actual-thread" }), { status: 202 }); }) as typeof fetch;
 const WS = createRequire(new URL("../../../server/package.json", import.meta.url))("ws") as { prototype: EventEmitter }, originalEmit = WS.prototype.emit;
 const owned = await installOwnedEmailReceiptDuplicate({ executionIds: [f.request.executionId], attemptId: f.request.attemptId, temporaryRoot: root });
 try { await armOwnedEmailReceiptDuplicate(root, f.request); const response = await fetch(f.url, f.init); expect(response.status).toBe(202); expect((await response.json()).message_id).toBe("actual-message");
  const socket = Object.setPrototypeOf(new EventEmitter(), WS.prototype) as EventEmitter & { _url: string }; socket._url = "wss://ws.agentmail.to/v0"; const observed: Buffer[] = []; socket.on("message", bytes => observed.push(bytes));
  const other = Buffer.from(JSON.stringify({ event_type: "message.sent", send: { inbox_id: f.request.inboxId, message_id: "other" } })); socket.emit("message", other); expect(observed).toHaveLength(1);
  const real = Buffer.from(JSON.stringify({ event_type: "message.sent", send: { inbox_id: f.request.inboxId, message_id: "actual-message" } })); socket.emit("message", real); expect(observed).toHaveLength(3); expect(observed[1]).toBe(real); expect(observed[2]).toBe(real);
  socket.emit("message", real); expect(observed).toHaveLength(4); expect(sends).toBe(1); await owned!.close();
  const receipt = readOwnedEmailDuplicate<EmailDuplicateReceipt>(root, "receipt.json"); expect(receipt.publicationId).toBe(f.publication); expect(receipt.authenticPayloadSha256).toBe(createHash("sha256").update(real).digest("hex")); expect(receipt.injectedDuplicateCount).toBe(1); expect(receipt.released).toBe(true);
 } finally { await owned?.close(); globalThis.fetch = prior; await rm(root, { recursive: true, force: true }); } expect(WS.prototype.emit).toBe(originalEmit);
});
