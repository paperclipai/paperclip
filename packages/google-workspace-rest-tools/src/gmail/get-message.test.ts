import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FULL_MESSAGE, METADATA_MESSAGE } from "./fixtures/gmail-rest.js";
import { getMessage, getMessageRequest, getMessageResult } from "./get-message.js";
import { parseAddressList } from "./message.js";

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

  it("parses address lists with quoted commas and bare addresses", () => {
    expect(parseAddressList("\"Doe, Drew\" <drew@example.test>, e@example.test, Fay <f@example.test>")).toEqual([
      "drew@example.test", "e@example.test", "f@example.test",
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
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
