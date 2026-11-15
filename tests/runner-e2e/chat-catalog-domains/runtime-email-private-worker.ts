import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { test } from "@playwright/test";
import { agentmailApi, emailText } from "../../../server/src/services/agentmail-api.js";
import type { EmailEndpointSummary, EmailPublicationSummary } from "../../../packages/shared/src/types/email.js";
import type { EmailPrivateInput, EmailPrivateReceipt } from "./runtime-email-private.js";
async function main(): Promise<EmailPrivateReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone only */ } if (attached) throw new Error("Private email credential operations must not execute in Test");
  const filename = process.argv[2]!, info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 65536) throw new Error("Invalid private email request file");
  const input = JSON.parse(await readFile(filename, "utf8")) as EmailPrivateInput, base = new URL(input.baseURL);
  if (!["recovery.unknown-email-outcome", "chat-channels.outbound-email", "chat-channels.reply-to-email"].includes(input.scenarioId) || !["setup", "inspect", "inspect-publication", "seed-review", "resolve"].includes(input.operation) || base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.origin !== input.baseURL || !input.dedicatedDisposableInbox || input.inboxId !== input.recipient || ![input.companyId, input.agentId].every(id => /^[a-f0-9-]{36}$/i.test(id))) throw new Error("Email operation requires the exact owned selected self-addressed fixture");
  if ((input.expectedRecipient || input.expectedReply) && input.scenarioId !== "chat-channels.reply-to-email" || input.reviewer && input.operation !== "seed-review") throw new Error("Undeclared reviewer credential or reply metadata");
  let directProviderProbeCount = 0, publicSetupOperationCount = 0;
  const direct: typeof fetch = async (...args) => { directProviderProbeCount++; return fetch(...args); }, provider = agentmailApi(input.credential, direct);
  async function local<T>(pathname: string, body?: unknown) { const response = await fetch(base.origin + pathname, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { Cookie: input.cookies.map(row => `${row.name}=${row.value}`).join("; "), Origin: base.origin, "Content-Type": "application/json" }, signal: AbortSignal.timeout(120000), redirect: "error" }); if (!response.ok) { await response.body?.cancel(); throw new Error("Actual private email public operation rejected"); } return response.json() as Promise<T>; }
  const person = await local<{ user: { id: string } }>("/api/auth/get-session"), company = await local<{ id: string }>(`/api/companies/${input.companyId}`), agent = await local<{ id: string; companyId: string }>(`/api/agents/${input.agentId}`);
  if (!person.user?.id || company.id !== input.companyId || agent.companyId !== company.id) throw new Error("Email setup lacks actual fixture-person/company/agent scope");
  const [scope, inventory, inbox] = await Promise.all([provider.whoami(), provider.listInboxes(), provider.getInbox(input.inboxId)]);
  if (inbox.inbox_id !== input.inboxId || inventory.inboxes.length !== 1 || inventory.inboxes[0]?.inbox_id !== input.inboxId || scope.scope_type === "inbox" && scope.inbox_id !== input.inboxId) throw new Error("The selected declared disposable QA inbox is not the actual sole authorized inbox; no account or recipient may be guessed");
  const common = { processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, operation: input.operation, companyId: input.companyId, agentId: input.agentId, actualSingleDedicatedInbox: true, personId: person.user.id } as const;
  if (input.operation === "setup") {
    const connection = await local<{ id: string; companyId: string }>(`/api/companies/${input.companyId}/email/connections`, { apiKey: input.credential, grantKind: "user", allAgents: false, agentIds: [input.agentId], idempotencyKey: randomUUID() }); publicSetupOperationCount++;
    if (connection.companyId !== input.companyId) throw new Error("Actual encrypted email credential connection scope mismatch");
    const endpoint = await local<EmailEndpointSummary>(`/api/companies/${input.companyId}/email/inboxes`, { assignedAgentId: input.agentId, credentialConnectionId: connection.id, inboxId: input.inboxId, receiveMode: "websocket", idempotencyKey: input.endpointId ?? randomUUID() }); publicSetupOperationCount++;
    const saved = (await local<EmailEndpointSummary[]>(`/api/companies/${input.companyId}/email/inboxes`)).find(row => row.id === endpoint.id);
    if (!saved || saved.companyId !== input.companyId || saved.address !== input.inboxId || saved.assignedAgentId !== input.agentId || saved.status !== "active") throw new Error("Actual email endpoint is not the authorized active self-addressed fixture");
    return { ...common, connectionId: connection.id, endpointId: saved.id, actualActiveEndpoint: true, publicSetupOperationCount, directProviderProbeCount };
  }
  if (input.operation === "seed-review") {
    const reviewer = input.reviewer;
    if (input.scenarioId !== "chat-channels.reply-to-email" || !reviewer || reviewer.authorization !== "reply-to-selected-synthetic-only" || reviewer.address === input.inboxId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewer.address) || !/^[a-f0-9-]{36}$/i.test(reviewer.nonce) || reviewer.credential.length < 12 || !input.endpointId) throw new Error("Genuine two-message review setup requires an explicitly authorized distinct synthetic sender");
    const sender = agentmailApi(reviewer.credential, direct), [senderScope, senderInventory, senderInbox] = await Promise.all([sender.whoami(), sender.listInboxes(), sender.getInbox(reviewer.address)]);
    if (senderInbox.inbox_id !== reviewer.address || senderInventory.inboxes.length !== 1 || senderInventory.inboxes[0]?.inbox_id !== reviewer.address || senderScope.scope_type === "inbox" && senderScope.inbox_id !== reviewer.address) throw new Error("Selected synthetic reviewer account/inbox could not be independently qualified");
    const started = new Date(Date.now() - 5000).toISOString(), subject = `Authorized launch review ${reviewer.nonce}`, earlierText = `Earlier question ${reviewer.nonce}: Is the desktop launch layout ready? Wait for explicit human authorization before replying.`, latestText = `Latest question ${reviewer.nonce}: Is the mobile launch layout fixed? Please wait for the responsible human to authorize the selected reply; do not infer a fix from this question.`;
    const earlier = await sender.send(reviewer.address, { to: [input.inboxId], subject, text: earlierText, headers: { "X-Paperclip-Eval-Review": `${reviewer.nonce}:earlier` } }, randomUUID());
    if (!earlier.message_id || !earlier.thread_id) throw new Error("Actual reviewer send returned no real message/thread receipt");
    await new Promise(resolve => setTimeout(resolve, 1200));
    const latest = await sender.send(reviewer.address, { to: [input.inboxId], text: latestText, headers: { "X-Paperclip-Eval-Review": `${reviewer.nonce}:latest` } }, randomUUID(), earlier.message_id);
    if (!latest.message_id || latest.thread_id !== earlier.thread_id) throw new Error("The second actual reviewer message did not retain the selected real thread");
    const observed = new Map<string, Awaited<ReturnType<typeof provider.getMessage>>>(), deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      let page: string | undefined, pages = 0;
      do { if (++pages > 3) throw new Error("Dedicated review inbox exceeds finite metadata window"); const listed = await provider.listMessages(input.inboxId, started, page);
        for (const item of listed.messages) { if (observed.has(item.message_id)) continue; const message = await provider.getMessage(input.inboxId, item.message_id); observed.set(item.message_id, message); }
        page = listed.next_page_token;
      } while (page);
      const match = (suffix: string, text: string) => [...observed.values()].find(message => message.inbox_id === input.inboxId && !message.labels.includes("sent") && message.to.some(value => (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase() === input.inboxId.toLowerCase()) && (message.from.match(/<([^>]+)>/)?.[1] ?? message.from).trim().toLowerCase() === reviewer.address.toLowerCase() && Object.entries(message.headers).some(([k,v]) => k.toLowerCase() === "x-paperclip-eval-review" && v === `${reviewer.nonce}:${suffix}`) && emailText(message).includes(text));
      const first = match("earlier", earlierText), second = match("latest", latestText);
      if (first && second) { if (first.thread_id !== second.thread_id || !(Date.parse(second.timestamp) > Date.parse(first.timestamp))) throw new Error("Real reviewer order/thread identity is not established"); return { ...common, directProviderProbeCount, publicSetupOperationCount, actualFixtureSendCount: 2, inbound: { earlierMessageId: first.message_id, latestMessageId: second.message_id, threadId: first.thread_id, earlierTimestamp: first.timestamp, latestTimestamp: second.timestamp, actualSenderQualified: true, actualRecipientQualified: true, earlierTextSha256: createHash("sha256").update(emailText(first).replace(/\r\n/g, "\n").trim()).digest("hex"), latestTextSha256: createHash("sha256").update(emailText(second).replace(/\r\n/g, "\n").trim()).digest("hex") } }; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Actual two inbound reviewer messages were not independently observed in the authorized recipient inbox");
  }
  if (!input.endpointId || !input.publicationId || (!input.subject && !input.expectedReply) || !input.textSha256 || !input.after || !(input.accepted?.publicationId === input.publicationId || input.operation === "inspect-publication" && input.expectedPublicReceipt?.publicationId === input.publicationId)) throw new Error("Email inspection requires the exact actual original accepted send binding");
  const endpoint = (await local<EmailEndpointSummary[]>(`/api/companies/${input.companyId}/email/inboxes`)).find(row => row.id === input.endpointId);
  if (!endpoint || endpoint.address !== input.inboxId || endpoint.assignedAgentId !== input.agentId || endpoint.companyId !== input.companyId) throw new Error("Provider reconciliation is not bound to the actual original endpoint");
  const matchedSent: NonNullable<EmailPrivateReceipt["matchedSent"]> = []; const seen = new Set<string>(); let page: string | undefined, pages = 0;
  do {
    if (++pages > 3) throw new Error("Independent fixture duplicate check exceeds its finite dedicated inbox window");
    const listed = await provider.listMessages(input.inboxId, input.after, page);
    for (const row of listed.messages) {
      if (seen.has(row.message_id)) continue; seen.add(row.message_id);
      const message = await provider.getMessage(input.inboxId, row.message_id), pub = Object.entries(message.headers).find(([key]) => key.toLowerCase() === "x-paperclip-publication-id")?.[1];
      if (message.inbox_id !== input.inboxId || (input.subject && message.subject !== input.subject) || input.expectedReply && (message.thread_id !== input.expectedReply.threadId || !Object.entries(message.headers).some(([k,v]) => k.toLowerCase() === "in-reply-to" && v.trim().replace(/^<|>$/g, "") === input.expectedReply!.messageId.trim().replace(/^<|>$/g, ""))) || createHash("sha256").update((message.extracted_text ?? message.text ?? "").replace(/\r\n/g, "\n").trim()).digest("hex") !== input.textSha256 || !message.labels.includes("sent") || !/^[a-f0-9-]{36}$/i.test(pub ?? "") || message.to.length !== 1 || (message.to[0]?.match(/(?:^|<)([^<>\s]+@[^<>\s]+)>?$/)?.[1]?.toLowerCase() !== (input.expectedRecipient ?? input.recipient).toLowerCase())) continue;
      matchedSent.push({ messageId: message.message_id, threadId: message.thread_id, publicationId: pub!, contentMatches: true, accepted: true, recipientCopyObserved: message.labels.includes("received") });
    }
    page = listed.next_page_token;
  } while (page);
  const original = matchedSent.filter(row => row.messageId === (input.accepted?.providerMessageId ?? input.expectedPublicReceipt?.providerMessageId) && (!input.accepted || row.threadId === input.accepted.providerThreadId) && row.publicationId === input.publicationId), originalMessageMatched = original.length === 1;
  if (!originalMessageMatched) throw new Error("The actual provider receipt does not independently match the original persisted send");
  if (input.operation === "inspect" || input.operation === "inspect-publication") return { ...common, publicSetupOperationCount, directProviderProbeCount, matchedSent, originalMessageMatched };
  let current = await local<EmailPublicationSummary>(`/api/companies/${input.companyId}/email/deliveries/${input.publicationId}`), resolution: EmailPrivateReceipt["resolution"] = "provider-reconciled";
  if (current.outcome === "uncertain") { current = await local<EmailPublicationSummary>(`/api/companies/${input.companyId}/email/deliveries/${input.publicationId}/resolve`, { outcome: "sent", providerMessageId: original[0]!.messageId }); publicSetupOperationCount++; resolution = "human-reconciled"; }
  if (!["sent", "delivered"].includes(current.outcome) || current.providerMessageId !== original[0]!.messageId) throw new Error("The actual public send has not reconciled to the verified original provider message");
  return { ...common, publicSetupOperationCount, directProviderProbeCount, matchedSent, originalMessageMatched, resolution, outcome: current.outcome as "sent" | "delivered" };
}
main().then(receipt => process.stdout.write(JSON.stringify(receipt))).catch(() => { process.stderr.write("Actual private email operation failed; credential/provider diagnostics withheld"); process.exitCode = 1; });
