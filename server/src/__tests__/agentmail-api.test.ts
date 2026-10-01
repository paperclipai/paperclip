import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import {
  agentmailApi,
  AgentmailApiError,
  agentmailMessageSchema,
  emailText,
  emailReplyRecipients,
  isAutomaticEmail,
  isFilteredEmail,
  normalizeAgentmailEvent,
  verifyAgentmailWebhook,
} from "../services/agentmail-api.js";
import { emailSendSchema } from "@paperclipai/shared";
import { buildRunnerApiCatalog } from "../services/native-runtime/runner-api-catalog.js";

const message = (extra = {}) =>
  agentmailMessageSchema.parse({
    inbox_id: "agent@agentmail.to",
    thread_id: "thread",
    message_id: "message",
    timestamp: new Date().toISOString(),
    ...extra,
  });
describe("AgentMail protocol boundary", () => {
  it("verifies the exact raw body and rejects forged or stale Svix signatures", () => {
    const secret = `whsec_${Buffer.from("a-test-secret-only").toString("base64")}`;
    const body = JSON.stringify({
      event_type: "message.received",
      message: message(),
    });
    const timestamp = new Date();
    const id = randomUUID();
    const headers = {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, timestamp, body),
    };
    expect(verifyAgentmailWebhook(Buffer.from(body), headers, secret)).toEqual(
      JSON.parse(body),
    );
    expect(() =>
      verifyAgentmailWebhook(Buffer.from(body + " "), headers, secret),
    ).toThrow();
    expect(() =>
      verifyAgentmailWebhook(
        Buffer.from(body),
        { ...headers, "svix-timestamp": "1" },
        secret,
      ),
    ).toThrow();
  });
  it("normalizes both transports and keeps delivery receipts separate from incoming mail", () => {
    const m = { inbox_id: "inbox", message_id: "message" };
    expect(
      normalizeAgentmailEvent({ event_type: "message.received", message: m })
        ?.kind,
    ).toBe("message.received");
    expect(
      normalizeAgentmailEvent({ type: "message_received", message: m })?.kind,
    ).toBe("message.received");
    expect(
      normalizeAgentmailEvent({ type: "message_delivered", message: m })?.kind,
    ).toBe("message.delivered");
    expect(normalizeAgentmailEvent({ type: "subscribed" })).toBeNull();
    expect(() =>
      normalizeAgentmailEvent({ event_type: "message.received", message: {} }),
    ).toThrow();
  });
  it.each([
    ["message.sent", "send"],
    ["message.delivered", "delivery"],
    ["message.bounced", "bounce"],
    ["message.complained", "complaint"],
    ["message.rejected", "reject"],
  ])("admits the documented %s receipt envelope through either transport", (kind, field) => {
    for (const transport of [{ type: "event", event_type: kind }, { type: kind.replace(".", "_") }]) {
      expect(normalizeAgentmailEvent({
        ...transport,
        event_id: "provider-event",
        [field]: { inbox_id: "inbox", thread_id: "thread", message_id: "sent-message" },
      })).toEqual({ kind, inbox_id: "inbox", message_id: "sent-message", eventId: "provider-event" });
    }
  });
  it("prefers extracted text, strips HTML and recognizes provider filtering and auto-replies", () => {
    expect(
      emailText(
        message({ extracted_text: "New reply", text: "Quoted history" }),
      ),
    ).toBe("New reply");
    expect(
      emailText(
        message({
          html: '<script>alert(1)</script><img src="https://tracking.test"><p>Hello</p>',
        }),
      ),
    ).not.toContain("tracking.test");
    expect(
      isAutomaticEmail(
        message({ headers: { "Auto-Submitted": "auto-replied" } }),
      ),
    ).toBe(true);
    expect(
      isAutomaticEmail(message({ headers: { "Auto-Submitted": "no" } })),
    ).toBe(false);
    for (const label of ["spam", "blocked", "unauthenticated"])
      expect(isFilteredEmail(message({ labels: [label] }))).toBe(true);
  });
  it("pins the API host, encodes message IDs and preserves the provider idempotency key", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message_id: "sent", thread_id: "thread" }),
        ),
      );
    await agentmailApi("private-key", fetcher).send(
      "agent@agentmail.to",
      { text: "Reply", reply_all: false },
      "stable-key",
      "<message@domain>",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.agentmail.to/v0/inboxes/agent%40agentmail.to/messages/%3Cmessage%40domain%3E/reply",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "Idempotency-Key": "stable-key" }),
      }),
    );
  });
  it("redacts provider error bodies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("private email and credentials", { status: 403 }),
      );
    await expect(agentmailApi("private-key", fetcher).whoami()).rejects.toThrow(
      "AgentMail request failed (403)",
    );
  });
  it.each(["missing_permission", "limit_exceeded", "domain_not_verified"])(
    "keeps a bounded create-inbox diagnostic for %s without provider data",
    async (code) => {
      const privateValue = "private-address@example.test";
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        code,
        message: privateValue,
        fix: `Use credential ${privateValue}`,
        docs: `https://example.test/${privateValue}`,
        nested: { code: privateValue },
      }), { status: 403 }));
      const error = await agentmailApi(privateValue, fetcher)
        .createInbox({ username: privateValue }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AgentmailApiError);
      expect(error).toMatchObject({ status: 403, operation: "create_inbox", providerCode: code });
      expect(String(error)).toBe(`Error: AgentMail request failed (403) [operation=create_inbox, code=${code}]`);
      expect(JSON.stringify(error)).not.toContain(privateValue);
      expect((error as Error).stack).not.toContain(privateValue);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "private email and credentials",
    JSON.stringify({ code: "private-address@example.test" }),
    JSON.stringify({ code: ["missing_permission"] }),
    JSON.stringify([{ code: "missing_permission" }]),
    JSON.stringify({ message: "Forbidden" }),
    JSON.stringify(null),
  ])("does not copy unrecognized provider bodies into diagnostics (%#)", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 403 }));
    await expect(agentmailApi("private-key", fetcher).whoami()).rejects.toMatchObject({
      status: 403,
      operation: "inspect_key",
      providerCode: "unknown",
      message: "AgentMail request failed (403) [operation=inspect_key, code=unknown]",
    });
  });
  it.each([
    ["GET", "/inboxes?limit=100", "list_inboxes"],
    ["GET", "/inboxes/private%40example.test", "get_inbox"],
    ["GET", "/domains?limit=100", "list_domains"],
    ["GET", "/domains/private.example.test", "get_domain"],
    ["POST", "/inboxes/private%40example.test/api-keys", "create_inbox_key"],
    ["DELETE", "/inboxes/private%40example.test/api-keys/private-key", "delete_inbox_key"],
    ["POST", "/inboxes/private%40example.test/webhooks", "create_webhook"],
    ["DELETE", "/inboxes/private%40example.test/webhooks/private-hook", "delete_webhook"],
    ["GET", "/inboxes/private%40example.test/messages?page_token=private-token", "list_messages"],
    ["GET", "/inboxes/private%40example.test/messages/private-message", "get_message"],
    ["GET", "/inboxes/private%40example.test/threads/private-thread", "get_thread"],
    ["POST", "/inboxes/private%40example.test/messages/send", "send_message"],
    ["POST", "/inboxes/private%40example.test/messages/private-message/reply", "reply_message"],
    ["GET", "/inboxes/private%40example.test/messages/private-message/attachments/private-attachment", "get_attachment"],
    ["POST", "/private-path?key=private-key", "request"],
    ["PATCH", "/inboxes/private%40example.test", "request"],
  ])("uses a fixed operation for %s route %#", async (method, path, operation) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const error = await agentmailApi("private-key", fetcher).request(path, method).catch((error: unknown) => error);
    expect(error).toMatchObject({ operation, providerCode: "unknown" });
    expect(String(error)).not.toContain("private");
    expect(JSON.stringify(error)).not.toContain("private");
  });
  it("bounds the error body read and cancels the remaining stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: "missing_permission", message: "x".repeat(8192) })));
      },
      cancel,
    }), { status: 403 });
    await expect(agentmailApi("private-key", vi.fn().mockResolvedValue(response)).whoami())
      .rejects.toMatchObject({ status: 403, providerCode: "unknown" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps the HTTP status when the error body stalls or cancellation fails", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn().mockRejectedValue(new Error("private provider error"));
      const response = new Response(new ReadableStream({ cancel }), { status: 403 });
      const failure = expect(agentmailApi("private-key", vi.fn().mockResolvedValue(response)).whoami())
        .rejects.toMatchObject({ status: 403, providerCode: "unknown" });
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps retry classification when reading an error body fails", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("private provider error")); },
    }), { status: 429, headers: { "retry-after": "9" } });
    const fetcher = vi.fn().mockResolvedValue(response);
    await expect(agentmailApi("private-key", fetcher).send("private@example.test", {}, "private-key"))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 9000, providerCode: "unknown", operation: "send_message" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([403, 429])("preserves HTTP %s when the response body is already locked", async (status) => {
    const response = new Response(JSON.stringify({ code: "missing_permission" }), {
      status,
      headers: { "retry-after": "9" },
    });
    const owner = response.body!.getReader();
    try {
      await expect(agentmailApi("private-key", vi.fn().mockResolvedValue(response))
        .send("private@example.test", {}, "private-key"))
        .rejects.toMatchObject({ status, retryAfterMs: 9000, providerCode: "unknown", operation: "send_message" });
    } finally {
      owner.releaseLock();
    }
  });
  it("constructs deliberate reply-all from visible recipients, excluding self and Bcc", () => {
    const envelope = {
      from: "Sender <sender@example.test>",
      to: ["agent@agentmail.to", "visible@example.test"],
      cc: ["visible@example.test", "cc@example.test"],
      bcc: ["private@example.test"],
      subject: "Hello",
    };
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", false)).toEqual(
      { to: ["sender@example.test"], cc: [], bcc: [], reply_all: false },
    );
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", true)).toEqual({
      to: ["sender@example.test", "visible@example.test"],
      cc: ["cc@example.test"],
      bcc: [],
      reply_all: false,
    });
  });
  it("honors Reply-To for reply and reply-all without adding the forwarding sender or Bcc", () => {
    const envelope = {
      from: "Forwarder <forwarder@example.test>",
      replyTo: ["Reply desk <reply@example.test>", "agent@agentmail.to"],
      to: ["agent@agentmail.to", "visible@example.test"],
      cc: ["reply@example.test", "cc@example.test"],
      bcc: ["private@example.test"],
      subject: "Forwarded request",
    };
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", false)).toEqual({
      to: ["reply@example.test"], cc: [], bcc: [], reply_all: false,
    });
    expect(emailReplyRecipients(envelope, "agent@agentmail.to", true)).toEqual({
      to: ["reply@example.test", "visible@example.test"], cc: ["cc@example.test"], bcc: [], reply_all: false,
    });
    expect(emailReplyRecipients({ ...envelope, replyTo: [] }, "agent@agentmail.to", false).to)
      .toEqual(["forwarder@example.test"]);
  });
  it("validates explicit new-message and reply envelopes, rejecting header injection and Bcc reuse", () => {
    const base = {
      endpointId: randomUUID(),
      idempotencyKey: randomUUID(),
      text: "Hello",
    };
    expect(
      emailSendSchema.safeParse({
        ...base,
        parentIssueId: randomUUID(),
        to: ["person@example.test"],
        subject: "Hi\r\nBcc: hidden@example.test",
      }).success,
    ).toBe(false);
    expect(
      emailSendSchema.safeParse({
        ...base,
        conversationId: randomUUID(),
        replyToMessageId: "message",
        bcc: ["hidden@example.test"],
      }).success,
    ).toBe(false);
    expect(
      emailSendSchema.parse({
        ...base,
        conversationId: randomUUID(),
        replyToMessageId: "message",
      }).replyAll,
    ).toBe(false);
  });
  it("exposes explicit email actions in runtime API discovery and keeps credential setup board-only", () => {
    const operations = buildRunnerApiCatalog();
    const send = operations.find(o => o.path === "/api/companies/{companyId}/email/send");
    expect(send?.method).toBe("POST"); expect(send?.requestBody).toBeDefined();
    expect(send?.responses).toHaveProperty("202");
    const setup = operations.find(o => o.path === "/api/companies/{companyId}/email/inspect");
    expect(JSON.stringify(setup?.authorization)).toContain("board");
  });

});
