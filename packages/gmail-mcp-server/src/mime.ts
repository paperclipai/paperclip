export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartLike {
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  parts?: GmailMessagePartLike[] | null;
}

export const MESSAGE_BODY_CHAR_CAP = 20_000;

export function getHeader(headers: GmailHeader[] | null | undefined, name: string): string | null {
  const needle = name.toLowerCase();
  const match = headers?.find((header) => header.name?.toLowerCase() === needle);
  return match?.value ?? null;
}

/**
 * Node's Buffer only natively decodes a handful of encodings. Map the
 * charset names Gmail actually sends in `Content-Type` onto one of those;
 * anything unrecognized falls back to utf8 rather than throwing.
 */
function normalizeCharset(charset: string | null): BufferEncoding {
  if (!charset) return "utf8";
  switch (charset.trim().toLowerCase()) {
    case "utf-8":
    case "utf8":
      return "utf8";
    case "us-ascii":
    case "ascii":
      return "ascii";
    case "iso-8859-1":
    case "latin1":
      return "latin1";
    default:
      return "utf8";
  }
}

function getPartCharset(part: GmailMessagePartLike): string | null {
  const contentType = getHeader(part.headers, "Content-Type");
  const match = contentType?.match(/charset\s*=\s*"?([^";]+)"?/i);
  return match ? match[1] : null;
}

export function decodeBase64Url(data: string, charset: string | null = null): string {
  return Buffer.from(data, "base64url").toString(normalizeCharset(charset));
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ExtractedMessageBody {
  text: string;
  truncated: boolean;
  attachmentFilenames: string[];
}

/**
 * Walk a (possibly multipart/nested) Gmail message payload once, collecting
 * the best available plain-text body and every part's attachment filename.
 * Prefers text/plain; falls back to a tag-stripped text/html part only when
 * no text/plain part exists anywhere in the tree.
 */
export function extractMessageBody(payload: GmailMessagePartLike | null | undefined): ExtractedMessageBody {
  let plainText: string | null = null;
  let htmlText: string | null = null;
  const attachmentFilenames: string[] = [];

  function visit(part: GmailMessagePartLike | null | undefined, insideAttachment: boolean) {
    if (!part) return;
    if (part.filename) {
      attachmentFilenames.push(part.filename);
    }
    // A part with a filename is an attachment, not inline body text, even if
    // its mimeType is text/plain or text/html - and the same goes for every
    // part nested underneath it (e.g. a forwarded message's own body parts).
    const isAttachment = insideAttachment || Boolean(part.filename);
    if (!isAttachment) {
      const data = part.body?.data;
      if (data && part.mimeType === "text/plain" && plainText === null) {
        plainText = decodeBase64Url(data, getPartCharset(part));
      } else if (data && part.mimeType === "text/html" && htmlText === null) {
        htmlText = decodeBase64Url(data, getPartCharset(part));
      }
    }
    for (const child of part.parts ?? []) {
      visit(child, isAttachment);
    }
  }

  visit(payload, false);

  const raw = plainText ?? (htmlText !== null ? stripHtml(htmlText) : "");
  const truncated = raw.length > MESSAGE_BODY_CHAR_CAP;
  return {
    text: truncated ? raw.slice(0, MESSAGE_BODY_CHAR_CAP) : raw,
    truncated,
    attachmentFilenames,
  };
}

function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** RFC 2045 §6.8: base64-encoded body lines must not exceed 76 characters. */
function encodeBodyBase64(body: string): string {
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

export interface BuildRawMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyToMessageId?: string | null;
  references?: string | null;
}

// A CR or LF inside any header-bound value starts a new header line in the
// raw RFC 2822 message, letting a subject like "Hi\r\nBcc: x@evil.com" add a
// hidden recipient the caller never supplied. Reject rather than strip, so
// the caller sees the problem instead of a silently mangled header.
function assertNoHeaderInjection(fieldName: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${fieldName} must not contain CR or LF characters`);
  }
}

/**
 * Build an RFC 2822 message and base64url-encode it for the Gmail API's
 * `raw` field. Used only for draft creation (`users.drafts.create`) — this
 * module has no code path that calls `users.messages.send` or any other
 * mutating/destructive Gmail endpoint.
 */
export function buildRawMessage(input: BuildRawMessageInput): string {
  assertNoHeaderInjection("subject", input.subject);
  for (const recipient of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    assertNoHeaderInjection("recipient", recipient);
  }
  if (input.inReplyToMessageId) {
    assertNoHeaderInjection("inReplyToMessageId", input.inReplyToMessageId);
  }
  if (input.references) {
    assertNoHeaderInjection("references", input.references);
  }

  const lines: string[] = [];
  lines.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  if (input.inReplyToMessageId) lines.push(`In-Reply-To: ${input.inReplyToMessageId}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=\"UTF-8\"");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(encodeBodyBase64(input.body));

  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}
