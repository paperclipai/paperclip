import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FULL_DRAFT } from "./fixtures/gmail-rest.js";
import { getDraft, getDraftResult, readDraftRequest } from "./get-draft.js";

describe("get_draft request", () => {
  it("reads the full draft by default", () => {
    for (const view of [undefined, "DRAFT_VIEW_FULL", "DRAFT_VIEW_UNSPECIFIED"] as const) {
      expect(readDraftRequest("r-1", view)).toEqual({
        method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts/r-1", query: { format: "full" },
      });
    }
  });

  it("reads only headers for DRAFT_VIEW_METADATA_ONLY", () => {
    expect(readDraftRequest("r-1", "DRAFT_VIEW_METADATA_ONLY").query).toEqual({
      format: "metadata", metadataHeaders: ["To", "Cc", "Bcc", "Subject", "Date"],
    });
  });
});

describe("get_draft result", () => {
  it("maps a full draft to the Draft shape create_draft and list_drafts return", () => {
    const result = getDraftResult(FULL_DRAFT, { draftId: FULL_DRAFT.id });
    expect(result.structuredContent).toEqual({
      id: "r-1234567890123456789",
      subject: "Re: Quarterly plan",
      threadId: "18c0ffee00000000",
      toRecipients: ["avery@example.test"],
      ccRecipients: ["casey@example.test"],
      bccRecipients: ["ops@example.test"],
      plaintextBody: "Draft reply",
      date: "2025-11-19",
      htmlBody: "<p>Draft reply</p>",
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("leaves subject and bodies out of DRAFT_VIEW_METADATA_ONLY", () => {
    const result = getDraftResult(FULL_DRAFT, { draftId: FULL_DRAFT.id, view: "DRAFT_VIEW_METADATA_ONLY" }).structuredContent;
    expect(result).not.toHaveProperty("subject");
    expect(result).not.toHaveProperty("plaintextBody");
    expect(result).not.toHaveProperty("htmlBody");
    expect(result).toMatchObject({ id: "r-1234567890123456789", bccRecipients: ["ops@example.test"] });
  });

  it("returns an empty subject and no bodies for an empty draft", () => {
    expect(getDraftResult({ id: "r-2", message: { id: "m2", payload: { mimeType: "text/plain", headers: [] } } }, { draftId: "r-2" }).structuredContent).toEqual({
      id: "r-2", subject: "", toRecipients: [], ccRecipients: [], bccRecipients: [],
    });
  });
});

describe("get_draft with a body Gmail stores separately", () => {
  const large = "Draft paragraph.\n".repeat(5000);
  const draft = {
    id: "r-3",
    message: { id: "m3", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Long" }], body: { size: large.length, attachmentId: "ANGjdJ_draft" } } },
  };

  it("fetches the body bytes before answering", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/") ? json({ data: Buffer.from(large).toString("base64url") }) : json(draft)));
    const result = await getDraft.call({ draftId: "r-3" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { plaintextBody: string }).plaintextBody).toBe(large);
    expect(calls.map((call) => call.url.pathname)).toEqual(["/gmail/v1/users/me/drafts/r-3", "/gmail/v1/users/me/messages/m3/attachments/ANGjdJ_draft"]);
  });

  it("returns an explicit error when the body cannot be read", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.includes("/attachments/") ? json({ error: { code: 403, message: "Denied" } }, 403) : json(draft)));
    const result = await getDraft.call({ draftId: "r-3" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not read the full body of this message/);
  });

  it("does not fetch bodies for DRAFT_VIEW_METADATA_ONLY", async () => {
    const { fetch, calls } = fakeGoogle(() => json(draft));
    await getDraft.call({ draftId: "r-3", view: "DRAFT_VIEW_METADATA_ONLY" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
  });
});

describe("get_draft tool", () => {
  it("rejects draft IDs that could change the request path", async () => {
    const { fetch, calls } = fakeGoogle(() => json(FULL_DRAFT));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const draftId of ["..", "a/b", "a?b", ""]) expect((await getDraft.call({ draftId }, http)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
