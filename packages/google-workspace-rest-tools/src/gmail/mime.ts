/**
 * Builds the RFC 5322 message a Gmail draft is created from. Every header
 * value is either validated by the caller (addresses) or checked here for line
 * breaks, so caller input cannot add headers.
 */

export interface DraftMime {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
  /** Multipart boundary; random in production, fixed in tests. */
  boundary: string;
}

const CRLF = "\r\n";

function assertSingleLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line`);
  return value;
}

/** Most UTF-8 bytes per encoded-word, keeping each word within RFC 2047's 75 characters. */
const ENCODED_WORD_BYTES = 45;

/**
 * RFC 2047 encoded-words for non-ASCII header text, split on character
 * boundaries and folded onto continuation lines.
 */
export function encodeHeaderText(value: string): string {
  assertSingleLine("Header", value);
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

function base64Body(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join(CRLF);
}

function textPart(mimeType: "text/plain" | "text/html", text: string): string {
  return [
    `Content-Type: ${mimeType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(text),
  ].join(CRLF);
}

export function buildDraftMime(input: DraftMime): string {
  assertSingleLine("Boundary", input.boundary);
  for (const address of [...input.to, ...input.cc, ...input.bcc]) assertSingleLine("Address", address);
  const headers = [
    "MIME-Version: 1.0",
    input.to.length ? `To: ${input.to.join(", ")}` : null,
    input.cc.length ? `Cc: ${input.cc.join(", ")}` : null,
    input.bcc.length ? `Bcc: ${input.bcc.join(", ")}` : null,
    `Subject: ${encodeHeaderText(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${assertSingleLine("In-Reply-To", input.inReplyTo)}` : null,
    input.references ? `References: ${assertSingleLine("References", input.references)}` : null,
  ].filter((line): line is string => line !== null);

  if (input.htmlBody !== undefined && input.body !== undefined) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${input.boundary}"`,
      "",
      `--${input.boundary}`,
      textPart("text/plain", input.body),
      `--${input.boundary}`,
      textPart("text/html", input.htmlBody),
      `--${input.boundary}--`,
      "",
    ].join(CRLF);
  }
  const part = input.htmlBody !== undefined ? textPart("text/html", input.htmlBody) : textPart("text/plain", input.body ?? "");
  return [...headers, part, ""].join(CRLF);
}
