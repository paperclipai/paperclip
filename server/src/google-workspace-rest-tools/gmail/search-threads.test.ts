import { describe, expect, it } from "vitest";
import { GoogleWorkspaceAuthError } from "../errors.js";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { THREAD_LIST, THREAD_ONE } from "./fixtures/gmail-rest.js";
import { effectiveQuery, listThreadsRequest, searchThreads, searchThreadsResult } from "./search-threads.js";

describe("search_threads request", () => {
  it("excludes drafts unless the query asks for them", () => {
    expect(effectiveQuery({})).toBe("-in:draft");
    expect(effectiveQuery({ query: "from:avery@example.test" })).toBe("(from:avery@example.test) -in:draft");
    expect(effectiveQuery({ query: "from:a@example.test OR from:b@example.test" })).toBe("(from:a@example.test OR from:b@example.test) -in:draft");
    expect(effectiveQuery({ query: "in:draft subject:plan" })).toBe("in:draft subject:plan");
    expect(effectiveQuery({ query: "-in:draft is:unread" })).toBe("-in:draft is:unread");
    expect(effectiveQuery({ query: "in:anywhere plan" })).toBe("in:anywhere plan");
  });

  it("ignores operator-looking text inside quotes", () => {
    expect(effectiveQuery({ query: "subject:\"go in:draft mode\"" })).toBe("(subject:\"go in:draft mode\") -in:draft");
    expect(effectiveQuery({ query: "\"in:spam\" report", includeTrash: true })).toBe("(\"in:spam\" report) -in:draft -in:spam");
    expect(effectiveQuery({ query: "\"quoted\" in:draft" })).toBe("\"quoted\" in:draft");
  });

  it("adds trash but not spam for includeTrash", () => {
    expect(effectiveQuery({ includeTrash: true })).toBe("-in:draft -in:spam");
    expect(listThreadsRequest({ includeTrash: true }).query).toMatchObject({ includeSpamTrash: true });
    expect(listThreadsRequest({}).query?.includeSpamTrash).toBeUndefined();
  });

  it("defaults the page size to 20 and caps it at 50", () => {
    expect(listThreadsRequest({}).query?.maxResults).toBe(20);
    expect(listThreadsRequest({ pageSize: 500 }).query?.maxResults).toBe(50);
    expect(listThreadsRequest({ pageSize: 5, pageToken: "page-2-token" }).query).toMatchObject({ maxResults: 5, pageToken: "page-2-token" });
  });
});

describe("search_threads result", () => {
  it("maps threads to Google's MCP SearchThreadsResponse", () => {
    const result = searchThreadsResult(THREAD_LIST, [THREAD_ONE, null], {});
    expect(result.structuredContent).toEqual({
      threads: [{
        id: "18c0ffee00000000",
        messages: [
          {
            id: "18c0ffee00000001", snippet: "Here is the quarterly plan we discussed", subject: "Quarterly plan",
            sender: "avery@example.test", toRecipients: ["blake@example.test", "casey@example.test"],
            ccRecipients: ["drew@example.test"], date: "2025-11-17", labelIds: ["INBOX", "UNREAD", "Label_42"],
          },
          {
            id: "18c0ffee00000002", snippet: "Thanks, looks good", subject: "Re: Quarterly plan", sender: "blake@example.test",
            toRecipients: ["avery@example.test"], ccRecipients: [], date: "2025-11-18", labelIds: ["SENT"],
          },
        ],
      }],
      nextPageToken: "page-2-token",
      resultCountEstimate: "201",
    });
  });

  it("leaves snippet and subject out of THREAD_VIEW_METADATA_ONLY", () => {
    const result = searchThreadsResult(THREAD_LIST, [THREAD_ONE], { view: "THREAD_VIEW_METADATA_ONLY" });
    const message = (result.structuredContent as { threads: Array<{ messages: Array<Record<string, unknown>> }> }).threads[0]!.messages[0]!;
    expect(message).not.toHaveProperty("snippet");
    expect(message).not.toHaveProperty("subject");
    expect(message.sender).toBe("avery@example.test");
  });

  it("returns an empty page without nextPageToken", () => {
    expect(searchThreadsResult({ resultSizeEstimate: 0 }, [], {}).structuredContent).toEqual({ threads: [], resultCountEstimate: "0" });
  });
});

describe("search_threads tool", () => {
  it("lists, then reads each thread's metadata, skipping a thread deleted in between", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/threads")) return json(THREAD_LIST);
      if (url.pathname.endsWith("/threads/18c0ffee00000000")) return json(THREAD_ONE);
      return json({ error: { code: 404 } }, 404);
    });
    const result = await searchThreads.call({ query: "plan" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { threads: unknown[] }).threads).toHaveLength(1);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /gmail/v1/users/me/threads",
      "GET /gmail/v1/users/me/threads/18c0ffee00000000",
      "GET /gmail/v1/users/me/threads/18c0ffee00000010",
    ]);
    expect(calls[1]!.url.searchParams.get("format")).toBe("metadata");
  });

  it("surfaces an auth failure on a thread read instead of a partial page", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.endsWith("/threads") ? json(THREAD_LIST) : json({}, 401)));
    await expect(searchThreads.call({}, createGoogleHttp({ accessToken: "t", fetch }))).rejects.toBeInstanceOf(GoogleWorkspaceAuthError);
  });
});
