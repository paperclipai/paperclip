import { describe, expect, it } from "vitest";
import { buildRawMessage, decodeBase64Url, extractMessageBody, getHeader, MESSAGE_BODY_CHAR_CAP } from "./mime.js";

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function encodeLatin1(text: string): string {
  return Buffer.from(text, "latin1").toString("base64url");
}

// Mirrors how a real MIME client would read buildRawMessage's output: split
// headers from body, then decode the body per the declared transfer encoding.
function decodeMimeBody(rawMessage: string): string {
  const body = rawMessage.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

describe("getHeader", () => {
  it("is case-insensitive", () => {
    const headers = [{ name: "Subject", value: "Hello" }];
    expect(getHeader(headers, "subject")).toBe("Hello");
    expect(getHeader(headers, "SUBJECT")).toBe("Hello");
  });

  it("returns null when absent", () => {
    expect(getHeader([], "Subject")).toBeNull();
    expect(getHeader(null, "Subject")).toBeNull();
  });
});

describe("extractMessageBody", () => {
  it("prefers a top-level text/plain body", () => {
    const result = extractMessageBody({
      mimeType: "text/plain",
      body: { data: encode("plain body") },
    });
    expect(result.text).toBe("plain body");
    expect(result.truncated).toBe(false);
    expect(result.attachmentFilenames).toEqual([]);
  });

  it("finds text/plain nested inside multipart/alternative", () => {
    const result = extractMessageBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: encode("<p>hi</p>") } },
        { mimeType: "text/plain", body: { data: encode("hi") } },
      ],
    });
    expect(result.text).toBe("hi");
  });

  it("falls back to stripped HTML when no text/plain part exists", () => {
    const result = extractMessageBody({
      mimeType: "text/html",
      body: { data: encode("<p>Hello <b>world</b></p><p>Second line</p>") },
    });
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("world");
    expect(result.text).toContain("Second line");
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<b>");
  });

  it("caps the body at 20,000 characters and reports truncation", () => {
    const longBody = "x".repeat(MESSAGE_BODY_CHAR_CAP + 500);
    const result = extractMessageBody({
      mimeType: "text/plain",
      body: { data: encode(longBody) },
    });
    expect(result.text).toHaveLength(MESSAGE_BODY_CHAR_CAP);
    expect(result.truncated).toBe(true);
  });

  it("collects attachment filenames across nested parts without including them in the body", () => {
    const result = extractMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encode("see attached") } },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "abc", size: 1024 } },
        {
          mimeType: "multipart/mixed",
          parts: [{ mimeType: "image/png", filename: "screenshot.png", body: { attachmentId: "def" } }],
        },
      ],
    });
    expect(result.text).toBe("see attached");
    expect(result.attachmentFilenames).toEqual(["invoice.pdf", "screenshot.png"]);
  });

  it("returns an empty body for a payload with no text parts", () => {
    const result = extractMessageBody(null);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("does not let a text/plain attachment replace an HTML-only message's body", () => {
    const result = extractMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: encode("<p>the real message</p>") } },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: encode("attachment contents, not the message") },
        },
      ],
    });
    expect(result.text).toContain("the real message");
    expect(result.attachmentFilenames).toEqual(["notes.txt"]);
  });

  it("excludes a forwarded message attachment's nested parts from the body too", () => {
    const result = extractMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encode("top-level reply") } },
        {
          mimeType: "message/rfc822",
          filename: "forwarded.eml",
          parts: [{ mimeType: "text/plain", body: { data: encode("forwarded body, not the reply") } }],
        },
      ],
    });
    expect(result.text).toBe("top-level reply");
  });
});

describe("decodeBase64Url", () => {
  it("round-trips UTF-8 text", () => {
    expect(decodeBase64Url(encode("héllo wörld"))).toBe("héllo wörld");
  });

  it("decodes a declared ISO-8859-1 part using that charset instead of UTF-8", () => {
    expect(decodeBase64Url(encodeLatin1("café"), "ISO-8859-1")).toBe("café");
  });

  it("extractMessageBody honors a part's own charset header", () => {
    const result = extractMessageBody({
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
      body: { data: encodeLatin1("café") },
    });
    expect(result.text).toBe("café");
  });
});

describe("buildRawMessage", () => {
  it("builds a plain RFC 2822 message with no In-Reply-To when not replying", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Body text" }),
      "base64url",
    ).toString("utf8");

    expect(raw).toContain("To: a@example.com");
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(decodeMimeBody(raw)).toBe("Body text");
    expect(raw).not.toContain("In-Reply-To");
  });

  it("includes Cc/Bcc and threading headers when replying", () => {
    const raw = Buffer.from(
      buildRawMessage({
        to: ["a@example.com"],
        cc: ["b@example.com"],
        bcc: ["c@example.com"],
        subject: "Re: Hi",
        body: "Reply text",
        inReplyToMessageId: "<msg-1@mail.gmail.com>",
        references: "<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>",
      }),
      "base64url",
    ).toString("utf8");

    expect(raw).toContain("Cc: b@example.com");
    expect(raw).toContain("Bcc: c@example.com");
    expect(raw).toContain("In-Reply-To: <msg-1@mail.gmail.com>");
    expect(raw).toContain("References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>");
  });

  it("rejects a subject containing CR or LF instead of injecting a header", () => {
    expect(() =>
      buildRawMessage({
        to: ["a@example.com"],
        subject: "Hi\r\nBcc: attacker@example.com",
        body: "Body",
      }),
    ).toThrow(/CR or LF/);
  });

  it("rejects a recipient containing CR or LF", () => {
    expect(() =>
      buildRawMessage({
        to: ["a@example.com\r\nBcc:attacker@example.com"],
        subject: "Hi",
        body: "Body",
      }),
    ).toThrow(/CR or LF/);
  });

  it("encodes a non-ASCII subject as a MIME encoded-word", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "héllo", body: "Body" }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
  });

  it("round-trips a non-ASCII body consistently with its declared transfer encoding", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "café ☕ déjà vu" }),
      "base64url",
    ).toString("utf8");

    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(decodeMimeBody(raw)).toBe("café ☕ déjà vu");
  });

  it("folds a long base64-encoded body at 76 characters per RFC 2045", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "x".repeat(200) }),
      "base64url",
    ).toString("utf8");

    const bodyLines = raw.split("\r\n\r\n")[1].split("\r\n");
    for (const line of bodyLines) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
