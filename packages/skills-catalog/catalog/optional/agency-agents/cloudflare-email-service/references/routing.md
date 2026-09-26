# Receiving & Routing Inbound Email

Handle incoming emails sent to your domain via a Worker's `email()` handler. Forward, reply, reject, or parse emails programmatically.

For full API details, see the [Email Routing docs](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

## Email Handler

Export an `email()` function from your Worker. No special wrangler binding needed — a routing rule connects incoming addresses to your Worker.

```typescript
export default {
  async email(message, env, ctx): Promise<void> {
    console.log(`Email from ${message.from} to ${message.to}`);
    await message.forward("team@company.com");
  },
} satisfies ExportedHandler<Env>;
```

Set up routing rules in **Dashboard** > **Compute & AI** > **Email Service** > **Email Routing** > **Routing Rules**, or via `wrangler email routing rules create`.

## ForwardableEmailMessage

The `message` parameter is a `ForwardableEmailMessage`. Run `npx wrangler types` to get the full type definition. Key properties and methods:

- `message.from` / `message.to` — envelope addresses (SMTP MAIL FROM / RCPT TO). `message.from` is trustworthy; header addresses can be spoofed.
- `message.headers` — `Headers` object (use `.get("subject")`, `.get("message-id")`, etc.)
- `message.raw` — `ReadableStream<Uint8Array>` of raw MIME content. **Single use** — buffer before accessing.
- `message.rawSize` — size in bytes
- `message.setReject(reason)` — reject with a permanent SMTP error
- `message.forward(rcptTo, headers?)` — forward to a verified destination
- `message.reply(emailMessage)` — reply with an `EmailMessage` object

## Core Operations

### Forward

```typescript
await message.forward("team@company.com");

// With custom headers
await message.forward("team@company.com", new Headers({
  "X-Original-Recipient": message.to,
}));
```

Destination must be verified first (Dashboard or `wrangler email routing addresses create`).

### Reject

```typescript
message.setReject("Your message was blocked");
```

### Reply

Using `env.EMAIL.send()` (recommended — no extra dependencies):

```typescript
async email(message, env, ctx) {
  const subject = message.headers.get("subject") || "";
  await env.EMAIL.send({
    to: message.from,
    from: message.to,
    subject: `Re: ${subject}`,
    html: "<p>Thanks! We'll respond shortly.</p>",
    text: "Thanks! We'll respond shortly.",
  });
  await message.forward("team@company.com");
}
```

Using `message.reply()` with MIME (more control, requires `mimetext` + `nodejs_compat`):

```typescript
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

async email(message, env, ctx) {
  const msg = createMimeMessage();
  const messageId = message.headers.get("Message-ID");
  if (messageId) msg.setHeader("In-Reply-To", messageId);
  msg.setSender({ name: "Support", addr: "support@yourdomain.com" });
  msg.setRecipient(message.from);
  msg.setSubject("Re: " + (message.headers.get("subject") || ""));
  msg.addMessage({ contentType: "text/plain", data: "Thanks for reaching out!" });

  await message.reply(new EmailMessage("support@yourdomain.com", message.from, msg.asRaw()));
}
```

## Parsing Emails

Use [postal-mime](https://www.npmjs.com/package/postal-mime) to parse raw MIME content:

```typescript
import PostalMime from "postal-mime";

async email(message, env, ctx) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);

  console.log("Subject:", parsed.subject);
  console.log("Text:", parsed.text);
  console.log("Attachments:", parsed.attachments.length);
}
```

## Store and Reply Later (Human-in-the-Loop)

A common pattern is to store incoming emails in a Durable Object (SQLite) so a human or AI agent can review and reply later — rather than replying immediately in the `email()` handler. This enables support inboxes, approval workflows, and AI-drafted replies.

### Architecture

```
Email Routing → email() handler → parse + store in DO → user reviews later → reply via send_email binding
```

The `email()` handler stores the email and returns immediately. Replies happen later via a separate HTTP request or agent action.

### Receive and Store

```typescript
import PostalMime from "postal-mime";

export class MailboxDO extends DurableObject {
  async storeEmail(from: string, to: string, subject: string, body: string,
                   messageId: string, inReplyTo: string | null) {
    this.ctx.storage.sql.exec(
      `INSERT INTO emails (sender, recipient, subject, body, message_id, in_reply_to, date, read)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0)`,
      from, to, subject, body, messageId, inReplyTo
    );
  }
}

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const id = env.MAILBOX.idFromName(message.to);
    const stub = env.MAILBOX.get(id);

    await stub.storeEmail(
      message.from,
      message.to,
      parsed.subject || "(no subject)",
      parsed.text || parsed.html || "",
      message.headers.get("message-id") || "",
      message.headers.get("in-reply-to") || null,
    );

    // Optionally trigger an AI agent to draft a reply (non-blocking)
    // ctx.waitUntil(notifyAgent(env, message.to, emailId));
  },
} satisfies ExportedHandler<Env>;
```

### Reply Later

When a user (or agent) decides to reply, build proper threading headers and send via the `send_email` binding:

```typescript
// In an HTTP handler or agent tool — not in the email() handler
async function replyToStoredEmail(env: Env, original: StoredEmail, replyBody: string) {
  // Build threading headers (In-Reply-To + References per RFC 2822)
  const headers: Record<string, string> = {};
  if (original.messageId) {
    headers["In-Reply-To"] = original.messageId;
    headers["References"] = original.messageId;
  }

  await env.EMAIL.send({
    to: original.sender,
    from: original.recipient,
    subject: `Re: ${original.subject}`,
    text: replyBody,
    html: `<p>${replyBody}</p>`,
    headers,
  });
}
```

### Key Design Points

- **Buffer `message.raw` once**, parse with `postal-mime`, then store structured fields. Don't store the raw stream.
- **Extract `Message-ID`, `In-Reply-To`, and `References`** headers during ingest for threading. Fall back to subject-based matching for emails without threading headers.
- **Use Durable Object SQLite** for per-mailbox storage — each mailbox gets its own DO instance keyed by email address, providing natural isolation.
- **Store attachments separately** in R2 (binary blobs), with metadata in SQLite.
- **Defer heavy work** (AI drafting, notifications) via `ctx.waitUntil()` so the `email()` handler returns quickly.
- **Never auto-send from the `email()` handler** in a human-in-the-loop flow. Store a draft, let the user review, then send via a separate action.

## Gotchas

- **`message.raw` is single-use.** Buffer first: `const raw = await new Response(message.raw).arrayBuffer()`
- **Destinations must be verified.** Forwarding to unverified addresses fails silently.
- **Handler must act.** If your handler returns without consuming raw, forwarding, or rejecting, the email is dropped.
- **DMARC/SPF for replies.** If sending replies, ensure your domain has proper SPF/DKIM records (auto-configured on domain onboarding).
