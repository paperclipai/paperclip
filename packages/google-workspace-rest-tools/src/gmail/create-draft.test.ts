import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createDraft, createDraftRequest, createDraftResult, replyContext } from "./create-draft.js";
import { CREATED_DRAFT, REPLY_ORIGINAL } from "./fixtures/gmail-rest.js";

function decodedRaw(request: ReturnType<typeof createDraftRequest>): string {
  const raw = (request.body as { message: { raw: string } }).message.raw;
  return Buffer.from(raw, "base64url").toString("utf8");
}

function decodedParts(mime: string): string[] {
  return [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)]
    .map((match) => Buffer.from(match[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"));
}

describe("create_draft request", () => {
  it("creates a draft (never sends) with a plain-text body", () => {
    const request = createDraftRequest({ to: ["blake@example.test"], subject: "Hello", body: "Hi Blake" }, undefined, "b1");
    expect(request).toMatchObject({ method: "POST", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts" });
    const mime = decodedRaw(request);
    expect(mime).toContain("To: blake@example.test\r\n");
    expect(mime).toContain("Subject: Hello\r\n");
    expect(mime).toContain("Content-Type: text/plain; charset=\"UTF-8\"");
    expect(decodedParts(mime)).toEqual(["Hi Blake"]);
    expect((request.body as { message: Record<string, unknown> }).message).not.toHaveProperty("threadId");
  });

  it("sends both bodies as multipart/alternative and encodes a non-ASCII subject", () => {
    const mime = decodedRaw(createDraftRequest({
      to: ["a@example.test"], cc: ["c@example.test"], bcc: ["d@example.test"],
      subject: "Plan für Q4", body: "plain", htmlBody: "<p>rich</p>",
    }, undefined, "b2"));
    expect(mime).toContain("Cc: c@example.test\r\n");
    expect(mime).toContain("Bcc: d@example.test\r\n");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Plan für Q4").toString("base64")}?=`);
    expect(mime).toContain("Content-Type: multipart/alternative; boundary=\"b2\"");
    expect(decodedParts(mime)).toEqual(["plain", "<p>rich</p>"]);
  });

  it("threads a reply and defaults the subject to Re:", () => {
    const reply = replyContext(REPLY_ORIGINAL);
    expect(reply).toEqual({
      threadId: "18c0ffee00000000",
      inReplyTo: "<plan-1@mail.example.test>",
      references: "<kickoff-0@mail.example.test> <plan-1@mail.example.test>",
      subject: "Quarterly plan",
    });
    const request = createDraftRequest({ to: ["avery@example.test"], body: "Looks good" }, reply, "b3");
    expect((request.body as { message: Record<string, unknown> }).message.threadId).toBe("18c0ffee00000000");
    const mime = decodedRaw(request);
    expect(mime).toContain("Subject: Re: Quarterly plan\r\n");
    expect(mime).toContain("In-Reply-To: <plan-1@mail.example.test>\r\n");
    expect(mime).toContain("References: <kickoff-0@mail.example.test> <plan-1@mail.example.test>\r\n");
  });

  it("drops malformed threading headers from the original message", () => {
    const reply = replyContext({ threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<a@b>\r\nBcc: x@example.test" }] } });
    expect(reply.inReplyTo).toBeUndefined();
    expect(reply.references).toBeUndefined();
  });
});

describe("create_draft result", () => {
  it("returns Google's MCP Draft", () => {
    const input = { to: ["blake@example.test"], subject: "Hello", body: "Hi" };
    expect(createDraftResult(CREATED_DRAFT, input, undefined, new Date("2026-11-17T12:00:00Z")).structuredContent).toEqual({
      id: "r-1234567890123456789", subject: "Hello", threadId: "18c0ffee00000000",
      toRecipients: ["blake@example.test"], ccRecipients: [], bccRecipients: [], plaintextBody: "Hi", date: "2026-11-17",
    });
  });
});

describe("create_draft tool", () => {
  it("looks up the original for a reply, then makes exactly one drafts.create call", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => json(method === "GET" ? REPLY_ORIGINAL : CREATED_DRAFT));
    const result = await createDraft.call({ to: ["avery@example.test"], body: "Looks good", replyToMessageId: "18c0ffee00000001" },
      createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /gmail/v1/users/me/messages/18c0ffee00000001",
      "POST /gmail/v1/users/me/drafts",
    ]);
    expect(calls.some((call) => call.url.pathname.includes("send"))).toBe(false);
  });

  it("rejects header injection and display-name recipients before calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json(CREATED_DRAFT));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const args of [
      { subject: "Hi\r\nBcc: x@example.test" },
      { to: ["Blake <blake@example.test>"] },
      { to: ["blake@example.test\r\nBcc: x@example.test"] },
      { cc: ["a@example.test, b@example.test"] },
      { replyToMessageId: "../send" },
    ]) {
      const result = await createDraft.call(args, http);
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses attachments, as Google's tool does today", async () => {
    const { fetch, calls } = fakeGoogle(() => json(CREATED_DRAFT));
    const result = await createDraft.call({ to: ["a@example.test"], attachments: [{ content: "aGk=" }] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Drafts with attachments are not supported yet." }] });
    expect(calls).toHaveLength(0);
  });

  it("does not retry the write when Google fails", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}, 503));
    const result = await createDraft.call({ to: ["a@example.test"] }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
