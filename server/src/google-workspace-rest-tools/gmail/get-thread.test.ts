import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FULL_MESSAGE, FULL_THREAD } from "./fixtures/gmail-rest.js";
import { getMessageResult } from "./get-message.js";
import { getThread, getThreadResult, readThreadRequest } from "./get-thread.js";

describe("get_thread request", () => {
  it("reads the full thread by default and for FULL_CONTENT", () => {
    for (const messageFormat of [undefined, "FULL_CONTENT", "MESSAGE_FORMAT_UNSPECIFIED"] as const) {
      expect(readThreadRequest({ threadId: "18c0ffee00000000", messageFormat })).toEqual({
        method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/threads/18c0ffee00000000", query: { format: "full" },
      });
    }
  });

  it("reads only summary headers for MINIMAL and METADATA_ONLY", () => {
    for (const messageFormat of ["MINIMAL", "METADATA_ONLY"] as const) {
      expect(readThreadRequest({ threadId: "t1", messageFormat }).query).toEqual({
        format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
      });
    }
  });
});

describe("get_thread result", () => {
  it("maps each message exactly as get_message does", () => {
    const result = getThreadResult(FULL_THREAD, { threadId: FULL_THREAD.id });
    const thread = result.structuredContent as { id: string; messages: unknown[] };
    expect(thread.id).toBe("18c0ffee00000000");
    expect(thread.messages[0]).toEqual(getMessageResult(FULL_MESSAGE, { messageId: FULL_MESSAGE.id }).structuredContent);
    expect(thread.messages[1]).toMatchObject({ id: "18c0ffee00000002", plaintextBody: "Thanks, looks good", attachmentIds: [] });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("leaves bodies out of MINIMAL and subject and snippet out of METADATA_ONLY", () => {
    const minimal = getThreadResult(FULL_THREAD, { threadId: "t", messageFormat: "MINIMAL" }).structuredContent as { messages: Array<Record<string, unknown>> };
    expect(minimal.messages[0]).not.toHaveProperty("plaintextBody");
    expect(minimal.messages[0]!.subject).toBe("Quarterly plan");
    const metadata = getThreadResult(FULL_THREAD, { threadId: "t", messageFormat: "METADATA_ONLY" }).structuredContent as { messages: Array<Record<string, unknown>> };
    expect(metadata.messages[0]).not.toHaveProperty("subject");
    expect(metadata.messages[0]).not.toHaveProperty("snippet");
  });

  it("returns an empty message list for a thread without messages", () => {
    expect(getThreadResult({ id: "t" }, { threadId: "t" }).structuredContent).toEqual({ id: "t", messages: [] });
  });
});

describe("get_thread with bodies Gmail stores separately", () => {
  const large = "Line of a long reply.\n".repeat(4000);
  const thread = {
    id: "th1",
    messages: [
      { id: "m1", payload: { mimeType: "text/plain", body: { size: 5, data: Buffer.from("short").toString("base64url") } } },
      {
        id: "m2",
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: large.length, attachmentId: "ANGjdJ_m2_plain" } },
            { mimeType: "text/html", body: { size: large.length, attachmentId: "ANGjdJ_m2_html" } },
          ],
        },
      },
    ],
  };

  it("fetches each separately stored body before answering", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/attachments/ANGjdJ_m2_plain")) return json({ data: Buffer.from(large).toString("base64url") });
      if (url.pathname.endsWith("/attachments/ANGjdJ_m2_html")) return json({ data: Buffer.from(`<pre>${large}</pre>`).toString("base64url") });
      return json(thread);
    });
    const result = await getThread.call({ threadId: "th1" }, createGoogleHttp({ accessToken: "t", fetch }), { maxResultBytes: 1_000_000 });
    const messages = (result.structuredContent as { messages: Array<{ plaintextBody?: string; htmlBody?: string }> }).messages;
    expect(messages[0]!.plaintextBody).toBe("short");
    expect(messages[1]!.plaintextBody).toBe(large);
    expect(messages[1]!.htmlBody).toBe(`<pre>${large}</pre>`);
    expect(calls.map((call) => call.url.pathname).sort()).toEqual([
      "/gmail/v1/users/me/messages/m2/attachments/ANGjdJ_m2_html",
      "/gmail/v1/users/me/messages/m2/attachments/ANGjdJ_m2_plain",
      "/gmail/v1/users/me/threads/th1",
    ]);
  });

  it("makes one request for MINIMAL", async () => {
    const { fetch, calls } = fakeGoogle(() => json(thread));
    await getThread.call({ threadId: "th1", messageFormat: "MINIMAL" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
  });

  it("returns an explicit error, never a partial thread, when a body cannot be read", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/") ? json({ error: { code: 404 } }, 404) : json(thread)));
    const result = await getThread.call({ threadId: "th1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not read the full body of this message/);
  });

  it("reads at most 20 separately stored bodies per call and fails explicitly beyond that", async () => {
    const stored = (count: number) => ({
      id: "th2",
      messages: Array.from({ length: count }, (_, index) => ({
        id: `m${index}`,
        payload: { mimeType: "text/plain", body: { size: 9000, attachmentId: `ANGjdJ_${index}` } },
      })),
    });
    const atLimit = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/") ? json({ data: Buffer.from("body").toString("base64url") }) : json(stored(20))));
    expect((await getThread.call({ threadId: "th2" }, createGoogleHttp({ accessToken: "t", fetch: atLimit.fetch }))).isError).toBeUndefined();
    expect(atLimit.calls).toHaveLength(21);

    const overLimit = fakeGoogle(() => json(stored(21)));
    const result = await getThread.call({ threadId: "th2" }, createGoogleHttp({ accessToken: "t", fetch: overLimit.fetch }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not read the full body of every message: they need 21 separate body reads/);
    expect(overLimit.calls).toHaveLength(1);
  });

  it("refuses a separately stored body on a message without a usable ID", async () => {
    const broken = { id: "th1", messages: [{ id: "../x", payload: thread.messages[1]!.payload }] };
    const { fetch, calls } = fakeGoogle(() => json(broken));
    const result = await getThread.call({ threadId: "th1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("get_thread tool", () => {
  it("rejects thread IDs that could change the request path", async () => {
    const { fetch, calls } = fakeGoogle(() => json(FULL_THREAD));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const threadId of ["..", "a/b", "a?b", ""]) expect((await getThread.call({ threadId }, http)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const { fetch } = fakeGoogle(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = await getThread.call({ threadId: "th1" }, createGoogleHttp({ accessToken: "t", fetch, signal: controller.signal }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The request was cancelled." }] });
  });
});
