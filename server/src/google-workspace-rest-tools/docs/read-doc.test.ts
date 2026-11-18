import { describe, expect, it } from "vitest";
import { FALLBACK_MAX_RESULT_BYTES } from "../tool.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { MULTI_TAB_DOCUMENT, MULTI_TAB_TEXT, oneTab, para, run, text } from "./fixtures/docs-rest.js";
import { readDoc, readDocRequest } from "./read-doc.js";
import { COMMENTS_UNAVAILABLE_NOTE, INLINE_NOTE, PREVIEW_NOTE } from "./render.js";

const INLINE = "?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE";
const INLINE_WITH_COMMENTS = `${INLINE}&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`;
const PREVIEW = "?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS";
const denied = () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } }, 403);
const SUGGESTED = oneTab([para([run("Keep "), run("new", { suggestedInsertionIds: ["s1"] }), run("\n")])]);
const PREVIEWED = oneTab([text("Keep")]);

function content(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent as { content: Record<string, unknown> }).content;
}

describe("read_doc request", () => {
  it.each([
    [{ documentId: "1AbC-d_9" }, undefined, { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" }],
    [{ documentId: "1AbC-d_9", commentsIncluded: false }, undefined, { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" }],
    [{ documentId: "1AbC-d_9", commentsIncluded: true }, undefined, { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE", commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED" }],
    [{ documentId: "1AbC-d_9" }, "PREVIEW_WITHOUT_SUGGESTIONS", { includeTabsContent: true, suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS" }],
    [{ documentId: "1AbC-d_9", commentsIncluded: true }, "PREVIEW_WITHOUT_SUGGESTIONS", { includeTabsContent: true, suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS" }],
  ] as const)("reads every tab of %j in view %s with an explicit suggestions view", (input, view, query) => {
    expect(readDocRequest(input, view)).toEqual({ method: "GET", host: "docs.googleapis.com", path: "/v1/documents/1AbC-d_9", query });
  });
});

describe("read_doc tool", () => {
  it("reads the document once with suggestions inline and returns its text, structure, view and revision", async () => {
    const { fetch, calls } = fakeGoogle(() => json(MULTI_TAB_DOCUMENT));
    const result = await readDoc.call({ documentId: "doc-synthetic-multi" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.host}${call.url.pathname}${call.url.search}`)).toEqual([
      `GET docs.googleapis.com/v1/documents/doc-synthetic-multi${INLINE}`,
    ]);
    expect(content(result)).toMatchObject({ documentId: "doc-synthetic-multi", revisionId: "ALm37BV-synthetic-rev", suggestionsViewMode: "SUGGESTIONS_INLINE", text: MULTI_TAB_TEXT });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("shows an editor's pending suggestions inline", async () => {
    const { fetch, calls } = fakeGoogle(() => json(SUGGESTED));
    const result = await readDoc.call({ documentId: "doc-1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(content(result)).toMatchObject({ suggestionsViewMode: "SUGGESTIONS_INLINE", text: "Keep {+new+}" });
    expect(content(result).notes).toEqual([INLINE_NOTE]);
  });

  it("reads a viewer's document without suggestions when Google refuses the inline view, and says so", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("suggestionsViewMode") === "SUGGESTIONS_INLINE" ? denied() : json(PREVIEWED)));
    const result = await readDoc.call({ documentId: "doc-1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.url.search)).toEqual([INLINE, PREVIEW]);
    expect(result.isError).toBeUndefined();
    expect(content(result)).toMatchObject({ suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS", text: "Keep", notes: [PREVIEW_NOTE] });
    expect(PREVIEW_NOTE).toMatch(/may not be valid for update_doc/);
  });

  it("returns a viewer's document without comments when comments were asked for, and says so", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("suggestionsViewMode") === "SUGGESTIONS_INLINE" ? denied() : json(PREVIEWED)));
    const result = await readDoc.call({ documentId: "doc-1", commentsIncluded: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.url.search)).toEqual([INLINE_WITH_COMMENTS, PREVIEW]);
    expect(content(result)).toMatchObject({
      suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
      text: "Keep\n\n[Comments]\nNot available with your access to this document.",
      notes: [PREVIEW_NOTE, COMMENTS_UNAVAILABLE_NOTE],
    });
  });

  it("returns the real access error when the document cannot be read in either view", async () => {
    const { fetch, calls } = fakeGoogle(denied);
    const result = await readDoc.call({ documentId: "doc-1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The caller does not have permission" }] });
    expect(calls.map((call) => call.url.search)).toEqual([INLINE, PREVIEW]);
  });

  it.each([
    ["a missing document", () => json({ error: { code: 404 } }, 404), "Google could not find that item."],
    ["a bad request", () => json({ error: { code: 400, message: "Invalid document." } }, 400), "Invalid document."],
    ["a disabled API", () => json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, 403), "This Google API is not enabled for the Google Cloud project behind this connection."],
  ])("does not fall back for %s", async (_name, answer, message) => {
    const { fetch, calls } = fakeGoogle(answer);
    const result = await readDoc.call({ documentId: "doc-1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: message }] });
    expect(calls).toHaveLength(1);
  });

  it("does not fall back when the grant lacks the Docs permission", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 403, details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403));
    await expect(readDoc.call({ documentId: "doc-1" }, createGoogleHttp({ accessToken: "t", fetch }))).rejects.toMatchObject({ reason: "insufficient_scope" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a malformed document ID without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const documentId of ["", "../x", "a/b", "a b", "a:batchUpdate", "x".repeat(257)]) {
      expect((await readDoc.call({ documentId }, http)).isError, documentId).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("measures the limit on the whole result, which carries the content twice", async () => {
    const under = (count: number) => oneTab(Array.from({ length: count }, () => text("z".repeat(1_000))));
    const perParagraph = 2 * 2 * 1_000;
    const fits = Math.floor(FALLBACK_MAX_RESULT_BYTES / perParagraph) - 10;
    const http = (doc: unknown) => createGoogleHttp({ accessToken: "t", fetch: fakeGoogle(() => json(doc)).fetch });
    const ok = await readDoc.call({ documentId: "d" }, http(under(fits)));
    expect(ok.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(ok), "utf8")).toBeLessThanOrEqual(FALLBACK_MAX_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(ok.structuredContent), "utf8")).toBeLessThan(FALLBACK_MAX_RESULT_BYTES / 2 + 1);
    expect((await readDoc.call({ documentId: "d" }, http(under(fits + 40)))).isError).toBe(true);
  });

  it("refuses a result over the size limit with a clear error instead of cutting it short", async () => {
    const paragraph = "x".repeat(10_000);
    const big = oneTab(Array.from({ length: Math.ceil(FALLBACK_MAX_RESULT_BYTES / 20_000) + 5 }, () => text(paragraph)));
    const { fetch } = fakeGoogle(() => json(big));
    const result = await readDoc.call({ documentId: "big" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^The result is [\d,]+ bytes, more than the 250,000 bytes this tool can return, so it was not returned\. This tool cannot read part of a document\./);
    expect(result.structuredContent).toBeUndefined();
  });
});
