export interface DraftMime {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
  boundary: string;
}

const CRLF = "\r\n";
export const PREFERRED_LINE_LENGTH = 78;
const MAX_ASCII_TOKEN = 900;
const ENCODED_WORD_BYTES = 39;

function assertSingleLine(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line`);
  return value;
}

export function foldHeader(name: string, tokens: readonly string[], separator: string): string {
  let line = `${name}:`;
  const lines: string[] = [];
  tokens.forEach((token, index) => {
    const piece = index === tokens.length - 1 ? token : `${token}${separator}`;
    if (piece.trim() !== "" && line.length + 1 + piece.length > PREFERRED_LINE_LENGTH && line.trim() !== `${name}:`) {
      lines.push(line);
      line = "";
    }
    line += ` ${piece}`;
  });
  lines.push(line);
  return lines.join(CRLF);
}

function encodedWords(value: string): string[] {
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
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`);
}

export function subjectHeader(subject: string): string {
  assertSingleLine("Subject", subject);
  const words = subject.split(" ");
  const plain = /^[\x20-\x7e]*$/.test(subject) && words.every((word) => word.length <= MAX_ASCII_TOKEN);
  if (plain) {
    if (`Subject: ${subject}`.length <= PREFERRED_LINE_LENGTH) return `Subject: ${subject}`;
    return foldHeader("Subject", words, "");
  }
  return foldHeader("Subject", encodedWords(subject), "");
}

function textPart(mimeType: "text/plain" | "text/html", text: string): string {
  const encoded = (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join(CRLF);
  return [`Content-Type: ${mimeType}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", encoded].join(CRLF);
}

export function buildDraftMime(input: DraftMime): string {
  assertSingleLine("Boundary", input.boundary);
  for (const address of [...input.to, ...input.cc, ...input.bcc]) assertSingleLine("Address", address);
  const headers = [
    "MIME-Version: 1.0",
    input.to.length ? foldHeader("To", input.to, ",") : null,
    input.cc.length ? foldHeader("Cc", input.cc, ",") : null,
    input.bcc.length ? foldHeader("Bcc", input.bcc, ",") : null,
    subjectHeader(input.subject),
    input.inReplyTo ? `In-Reply-To: ${assertSingleLine("In-Reply-To", input.inReplyTo)}` : null,
    input.references ? foldHeader("References", assertSingleLine("References", input.references).split(" "), "") : null,
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
