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

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderText(value: string): string {
  assertSingleLine("Header", value);
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
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
  const headers = [
    "MIME-Version: 1.0",
    input.to.length ? `To: ${input.to.join(", ")}` : null,
    input.cc.length ? `Cc: ${input.cc.join(", ")}` : null,
    input.bcc.length ? `Bcc: ${input.bcc.join(", ")}` : null,
    `Subject: ${encodeHeaderText(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${assertSingleLine("In-Reply-To", input.inReplyTo)}` : null,
    input.references ? `References: ${assertSingleLine("References", input.references)}` : null,
  ].filter((line): line is string => line !== null);
  for (const line of headers) assertSingleLine("Header", line);

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
