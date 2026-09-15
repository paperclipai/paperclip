import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import {
  agentmailApi,
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
