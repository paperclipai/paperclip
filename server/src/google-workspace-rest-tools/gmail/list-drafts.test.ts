import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { DRAFT_LIST, FULL_DRAFT } from "./fixtures/gmail-rest.js";
import { getDraftResult } from "./get-draft.js";
import { listDrafts, listDraftsRequest, listDraftsResult } from "./list-drafts.js";

describe("list_drafts request", () => {
  it("passes the query as is and defaults the page size to 20, capped at 50", () => {
    expect(listDraftsRequest({})).toEqual({
      method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/drafts",
      query: { q: undefined, maxResults: 20, pageToken: undefined },
    });
    expect(listDraftsRequest({ query: " to:avery@example.test ", pageSize: 80, pageToken: "drafts-page-2" }).query).toEqual({
      q: "to:avery@example.test", maxResults: 50, pageToken: "drafts-page-2",
    });
  });
});

describe("list_drafts result", () => {
  it("maps each draft exactly as get_draft does", () => {
    const result = listDraftsResult(DRAFT_LIST, [FULL_DRAFT, null], {});
    expect(result.structuredContent).toEqual({
      drafts: [getDraftResult(FULL_DRAFT, { draftId: FULL_DRAFT.id }).structuredContent],
      nextPageToken: "drafts-page-2",
    });
  });

  it("returns an empty page without nextPageToken", () => {
    expect(listDraftsResult({}, [], {}).structuredContent).toEqual({ drafts: [] });
  });
});

describe("list_drafts tool", () => {
  it("lists, then reads each draft, skipping one deleted in between", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/drafts")) return json(DRAFT_LIST);
      if (url.pathname.endsWith(`/drafts/${FULL_DRAFT.id}`)) return json(FULL_DRAFT);
      return json({ error: { code: 404 } }, 404);
    });
    const result = await listDrafts.call({}, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { drafts: Array<{ id: string }> }).drafts.map((draft) => draft.id)).toEqual([FULL_DRAFT.id]);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/gmail/v1/users/me/drafts",
      "/gmail/v1/users/me/drafts/r-1234567890123456789",
      "/gmail/v1/users/me/drafts/r-2000000000000000001",
    ]);
    expect(calls[1]!.url.searchParams.get("format")).toBe("full");
  });

  it("fails explicitly when a separately stored draft body cannot be read", async () => {
    const stored = { id: "r-9", message: { id: "m9", payload: { mimeType: "text/html", body: { size: 9000, attachmentId: "ANGjdJ_html" } } } };
    const { fetch } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [{ id: "r-9" }] });
      if (url.pathname.includes("/attachments/")) return json({ error: { code: 503 } }, 503);
      return json(stored);
    });
    const result = await listDrafts.call({}, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^Could not read the full body of this message/);
  });

  it("makes at most 51 requests at the maximum page size when no body is stored separately", async () => {
    const ids = Array.from({ length: 70 }, (_, index) => `r-${index}`);
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/drafts")
      ? json({ drafts: ids.slice(0, Number(url.searchParams.get("maxResults"))).map((id) => ({ id })) })
      : json({ id: url.pathname.split("/").pop(), message: { id: "m", payload: { mimeType: "text/plain", body: { data: "" } } } })));
    const result = await listDrafts.call({ pageSize: 70 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { drafts: unknown[] }).drafts).toHaveLength(50);
    expect(calls).toHaveLength(51);
  });
});
