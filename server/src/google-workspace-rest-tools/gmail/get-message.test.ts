import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FULL_MESSAGE, METADATA_MESSAGE } from "./fixtures/gmail-rest.js";
import { getMessage, getMessageRequest, getMessageResult } from "./get-message.js";

describe("get_message request", () => {
  it("reads the full message by default and for FULL_CONTENT", () => {
    for (const messageFormat of [undefined, "FULL_CONTENT", "MESSAGE_FORMAT_UNSPECIFIED"] as const) {
      expect(getMessageRequest({ messageId: "18c0ffee00000001", messageFormat })).toEqual({
        method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/messages/18c0ffee00000001", query: { format: "full" },
      });
    }
  });

  it("reads only summary headers for MINIMAL and METADATA_ONLY", () => {
    for (const messageFormat of ["MINIMAL", "METADATA_ONLY"] as const) {
      expect(getMessageRequest({ messageId: "abc", messageFormat }).query).toEqual({
        format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
      });
    }
  });
});

describe("get_message result", () => {
  it("maps a full message to Google's MCP Message", () => {
    const result = getMessageResult(FULL_MESSAGE, { messageId: FULL_MESSAGE.id });
    expect(result.structuredContent).toEqual({
      id: "18c0ffee00000001",
      snippet: "Here is the quarterly plan we discussed",
      subject: "Quarterly plan",
      sender: "avery@example.test",
      toRecipients: ["blake@example.test", "casey@example.test"],
      ccRecipients: ["drew@example.test"],
      date: "2025-11-17",
      plaintextBody: "Here is the quarterly plan we discussed.",
      htmlBody: "<p>Here is the <b>quarterly plan</b>.</p>",
      attachmentIds: ["ANGjdJ_fake_attachment_1"],
      attachments: [{ id: "ANGjdJ_fake_attachment_1", mimeType: "application/pdf", filename: "plan.pdf" }],
      labelIds: ["INBOX", "UNREAD", "Label_42"],
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("leaves bodies out of MINIMAL and subject and snippet out of METADATA_ONLY", () => {
    const minimal = getMessageResult(METADATA_MESSAGE, { messageId: METADATA_MESSAGE.id, messageFormat: "MINIMAL" }).structuredContent;
    expect(minimal).toEqual({
      id: "18c0ffee00000002", snippet: "Thanks, looks good", subject: "Re: Quarterly plan", sender: "blake@example.test",
      toRecipients: ["avery@example.test"], ccRecipients: [], date: "2025-11-18", labelIds: ["SENT"],
    });
    const metadata = getMessageResult(METADATA_MESSAGE, { messageId: METADATA_MESSAGE.id, messageFormat: "METADATA_ONLY" }).structuredContent;
    expect(metadata).not.toHaveProperty("subject");
    expect(metadata).not.toHaveProperty("snippet");
    expect(metadata).not.toHaveProperty("plaintextBody");
  });

  it("reads the first plain and HTML bodies from nested multiparts", () => {
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    const nested = {
      id: "n1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [{
          mimeType: "multipart/related",
          parts: [{
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("plain ü") } },
              { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
            ],
          }, { mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-Disposition", value: "inline" }], body: { attachmentId: "img1" } }],
        }, { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "att2" } }],
      },
    };
    expect(getMessageResult(nested, { messageId: "n1" }).structuredContent).toMatchObject({
      plaintextBody: "plain ü",
      htmlBody: "<p>html</p>",
      attachmentIds: ["img1", "att2"],
    });
  });
});

describe("get_message with a body Gmail stores separately", () => {
  const large = "A long body line.\n".repeat(5000);
  const message = {
    id: "big1",
    snippet: "A long body line.",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: "Large" }],
      parts: [
        { mimeType: "text/plain", body: { size: large.length, attachmentId: "ANGjdJ_body_plain" } },
        { mimeType: "text/html", body: { size: 12, data: Buffer.from("<p>short</p>").toString("base64url") } },
      ],
    },
  };

  it("fetches the body bytes before returning FULL_CONTENT", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/")
      ? json({ size: large.length, data: Buffer.from(large).toString("base64url") })
      : json(message)));
    const result = await getMessage.call({ messageId: "big1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { plaintextBody: string }).plaintextBody).toBe(large);
    expect((result.structuredContent as { htmlBody: string }).htmlBody).toBe("<p>short</p>");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/gmail/v1/users/me/messages/big1",
      "/gmail/v1/users/me/messages/big1/attachments/ANGjdJ_body_plain",
    ]);
  });

  it("does not fetch body bytes for MINIMAL", async () => {
    const { fetch, calls } = fakeGoogle(() => json(message));
    await getMessage.call({ messageId: "big1", messageFormat: "MINIMAL" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
  });

  it("returns an explicit error, never a body-less success, when the body cannot be read", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/") ? json({ error: { code: 500 } }, 500) : json(message)));
    const result = await getMessage.call({ messageId: "big1" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not read the full body of this message/);
  });

  it("refuses to map a separately stored body that was not fetched", () => {
    expect(() => getMessageResult(message, { messageId: "big1" })).toThrow(/full body/);
  });
});

describe("get_message tool", () => {
  it("rejects message IDs that could change the request path", async () => {
    const { fetch, calls } = fakeGoogle(() => json(FULL_MESSAGE));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const messageId of ["..", "a/b", "a?b", ""]) {
      const result = await getMessage.call({ messageId }, http);
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("returns a tool error result when the message is missing", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 404, message: "Requested entity was not found." } }, 404));
    const result = await getMessage.call({ messageId: "missing1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Google could not find that item." }] });
  });
});
