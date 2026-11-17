import { describe, expect, it } from "vitest";
import { GoogleWorkspaceAuthError } from "../errors.js";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FULL_MESSAGE, MESSAGE_LIST, METADATA_MESSAGE } from "./fixtures/gmail-rest.js";
import { getMessageResult } from "./get-message.js";
import { listMessagesRequest, searchMessageFormat, searchMessages, searchMessagesResult } from "./search-messages.js";

describe("search_messages request", () => {
  it("lists messages with the same draft and spam rules as search_threads", () => {
    expect(listMessagesRequest({ query: "from:avery@example.test" })).toEqual({
      method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/messages",
      query: { q: "(from:avery@example.test) -in:draft", maxResults: 20, pageToken: undefined, includeSpamTrash: undefined },
    });
    expect(listMessagesRequest({ includeTrash: true }).query).toMatchObject({ q: "-in:draft -in:spam", includeSpamTrash: true });
    expect(listMessagesRequest({ query: "in:draft" }).query?.q).toBe("in:draft");
  });

  it("defaults the page size to 20, caps it at 50, and defaults to summaries", () => {
    expect(listMessagesRequest({ pageSize: 500, pageToken: "p2" }).query).toMatchObject({ maxResults: 50, pageToken: "p2" });
    expect(searchMessageFormat(undefined)).toBe("MINIMAL");
    expect(searchMessageFormat("MESSAGE_FORMAT_UNSPECIFIED")).toBe("MINIMAL");
    expect(searchMessageFormat("FULL_CONTENT")).toBe("FULL_CONTENT");
  });
});

describe("search_messages result", () => {
  it("maps each message exactly as get_message does", () => {
    const result = searchMessagesResult(MESSAGE_LIST, [METADATA_MESSAGE, null, FULL_MESSAGE], { messageFormat: "FULL_CONTENT" });
    expect(result.structuredContent).toEqual({
      messages: [
        getMessageResult(METADATA_MESSAGE, { messageId: METADATA_MESSAGE.id }).structuredContent,
        getMessageResult(FULL_MESSAGE, { messageId: FULL_MESSAGE.id }).structuredContent,
      ],
      nextPageToken: "messages-page-2",
      resultCountEstimate: "37",
    });
  });

  it("returns an empty page without nextPageToken", () => {
    expect(searchMessagesResult({ resultSizeEstimate: 0 }, [], {}).structuredContent).toEqual({ messages: [], resultCountEstimate: "0" });
  });
});

describe("search_messages tool", () => {
  it("lists, then reads each message's summary headers, skipping one deleted in between", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/messages")) return json(MESSAGE_LIST);
      if (url.pathname.endsWith("/messages/18c0ffee00000002")) return json(METADATA_MESSAGE);
      return json({ error: { code: 404 } }, 404);
    });
    const result = await searchMessages.call({ query: "plan" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({
      messages: [getMessageResult(METADATA_MESSAGE, { messageId: METADATA_MESSAGE.id, messageFormat: "MINIMAL" }).structuredContent],
      nextPageToken: "messages-page-2",
      resultCountEstimate: "37",
    });
    expect(calls.slice(1).map((call) => call.url.searchParams.get("format"))).toEqual(["metadata", "metadata"]);
  });

  it("fetches separately stored bodies for FULL_CONTENT and fails explicitly when one cannot be read", async () => {
    const stored = {
      id: "18c0ffee00000002",
      payload: { mimeType: "text/plain", body: { size: 9000, attachmentId: "ANGjdJ_stored" } },
    };
    const body = "x".repeat(9000);
    const route = (attachment: () => Response) => fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "18c0ffee00000002" }] });
      if (url.pathname.includes("/attachments/")) return attachment();
      return json(stored);
    });
    const ok = route(() => json({ data: Buffer.from(body).toString("base64url") }));
    const full = await searchMessages.call({ messageFormat: "FULL_CONTENT" }, createGoogleHttp({ accessToken: "t", fetch: ok.fetch }));
    expect((full.structuredContent as { messages: Array<{ plaintextBody: string }> }).messages[0]!.plaintextBody).toBe(body);
    expect(ok.calls).toHaveLength(3);
    expect(ok.calls[1]!.url.searchParams.get("format")).toBe("full");

    const broken = route(() => json({ size: 9000 }));
    const failed = await searchMessages.call({ messageFormat: "FULL_CONTENT" }, createGoogleHttp({ accessToken: "t", fetch: broken.fetch }));
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as { text: string }).text).toMatch(/^Could not read the full body of this message/);
  });

  it("makes at most 51 requests at the maximum page size with summaries", async () => {
    const ids = Array.from({ length: 80 }, (_, index) => `m${index}`);
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/messages")
      ? json({ messages: ids.slice(0, Number(url.searchParams.get("maxResults"))).map((id) => ({ id })) })
      : json({ id: url.pathname.split("/").pop() })));
    const result = await searchMessages.call({ pageSize: 99 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { messages: unknown[] }).messages).toHaveLength(50);
    expect(calls).toHaveLength(51);
  });

  it("surfaces an auth failure on a message read instead of a partial page", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.endsWith("/messages") ? json(MESSAGE_LIST) : json({}, 401)));
    await expect(searchMessages.call({}, createGoogleHttp({ accessToken: "t", fetch }))).rejects.toBeInstanceOf(GoogleWorkspaceAuthError);
  });
});
