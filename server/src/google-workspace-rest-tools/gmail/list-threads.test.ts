import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { THREAD_LIST, THREAD_ONE } from "./fixtures/gmail-rest.js";
import { listThreads, listThreadsQuery, listThreadsToolRequest } from "./list-threads.js";
import { searchThreadsResult } from "./search-threads.js";

describe("list_threads request", () => {
  it("lists threads without drafts, spam or trash by default", () => {
    expect(listThreadsToolRequest({})).toEqual({
      method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/threads",
      query: { q: "-in:draft", includeSpamTrash: undefined, labelIds: undefined, maxResults: 20, pageToken: undefined },
    });
  });

  it("passes label filters and keeps the label's own drafts, spam or trash", () => {
    expect(listThreadsToolRequest({ labelIds: ["INBOX", "Label_42"] }).query).toMatchObject({ labelIds: ["INBOX", "Label_42"], q: "-in:draft" });
    expect(listThreadsQuery({ labelIds: ["DRAFT"] })).toEqual({ q: undefined, includeSpamTrash: undefined });
    expect(listThreadsQuery({ labelIds: ["SPAM"] })).toEqual({ q: "-in:draft", includeSpamTrash: true });
    expect(listThreadsQuery({ labelIds: ["TRASH"] })).toEqual({ q: "-in:draft -in:spam", includeSpamTrash: true });
    expect(listThreadsQuery({ includeTrash: true })).toEqual({ q: "-in:draft -in:spam", includeSpamTrash: true });
  });

  it("filters by a Gmail search query, combined with labels and the default exclusions", () => {
    expect(listThreadsToolRequest({ query: "subject:marker-123" }).query).toMatchObject({ q: "(subject:marker-123) -in:draft", labelIds: undefined });
    expect(listThreadsQuery({ query: "from:sam@example.test", labelIds: ["INBOX"] })).toEqual({ q: "(from:sam@example.test) -in:draft", includeSpamTrash: undefined });
    expect(listThreadsQuery({ query: "in:draft marker" })).toEqual({ q: "in:draft marker", includeSpamTrash: undefined });
    expect(listThreadsQuery({ query: "marker", labelIds: ["DRAFT"] })).toEqual({ q: "marker", includeSpamTrash: undefined });
    expect(listThreadsQuery({ query: "marker", includeTrash: true })).toEqual({ q: "(marker) -in:draft -in:spam", includeSpamTrash: true });
    expect(listThreadsQuery({ query: "   " })).toEqual({ q: "-in:draft", includeSpamTrash: undefined });
  });

  it("defaults the page size to 20 and caps it at 50", () => {
    expect(listThreadsToolRequest({ pageSize: 500 }).query?.maxResults).toBe(50);
    expect(listThreadsToolRequest({ pageSize: 5, pageToken: "page-2-token" }).query).toMatchObject({ maxResults: 5, pageToken: "page-2-token" });
  });
});

describe("list_threads tool", () => {
  it("returns the same shape as search_threads", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/threads")) return json(THREAD_LIST);
      if (url.pathname.endsWith("/threads/18c0ffee00000000")) return json(THREAD_ONE);
      return json({ error: { code: 404 } }, 404);
    });
    const result = await listThreads.call({ labelIds: ["INBOX"] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual(searchThreadsResult(THREAD_LIST, [THREAD_ONE], {}).structuredContent);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
  });

  it("makes at most 51 requests at the maximum page size", async () => {
    const ids = Array.from({ length: 80 }, (_, index) => `t${index}`);
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/threads")
      ? json({ threads: ids.slice(0, Number(url.searchParams.get("maxResults"))).map((id) => ({ id })) })
      : json({ id: url.pathname.split("/").pop(), messages: [] })));
    const result = await listThreads.call({ pageSize: 1000 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { threads: unknown[] }).threads).toHaveLength(50);
    expect(calls).toHaveLength(51);
  });

  it("sends the query to Google as q", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/threads") ? json({ threads: [], resultSizeEstimate: 0 }) : json({}, 404)));
    const result = await listThreads.call({ query: "x" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("q")).toBe("(x) -in:draft");
  });

  it("refuses q, which is not one of its arguments, instead of listing every thread", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await listThreads.call({ q: "marker" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text",
      text: "Invalid arguments for list_threads: unknown argument \"q\". Accepted arguments: pageSize, pageToken, query, labelIds, includeTrash, view. Nothing was sent to Google." }] });
    expect(calls).toHaveLength(0);
  });

  it("refuses label IDs that are not Gmail IDs and too many labels", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    expect((await listThreads.call({ labelIds: ["a&b=c"] }, http)).isError).toBe(true);
    expect((await listThreads.call({ labelIds: Array.from({ length: 21 }, (_, index) => `Label_${index}`) }, http)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
