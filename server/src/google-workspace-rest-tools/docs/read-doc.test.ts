import { describe, expect, it } from "vitest";
import { MAX_RESULT_BYTES } from "../documents-shared.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { MULTI_TAB_DOCUMENT, MULTI_TAB_TEXT, oneTab, text } from "./fixtures/docs-rest.js";
import { readDoc, readDocRequest } from "./read-doc.js";

describe("read_doc request", () => {
  it.each([
    [{ documentId: "1AbC-d_9" }, { includeTabsContent: true }],
    [{ documentId: "1AbC-d_9", commentsIncluded: false }, { includeTabsContent: true }],
    [{ documentId: "1AbC-d_9", commentsIncluded: true }, { includeTabsContent: true, commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED", suggestionsViewMode: "SUGGESTIONS_INLINE" }],
  ])("reads every tab of %j", (input, query) => {
    expect(readDocRequest(input)).toEqual({ method: "GET", host: "docs.googleapis.com", path: "/v1/documents/1AbC-d_9", query });
  });
});

describe("read_doc tool", () => {
  it("reads the document once and returns its text, structure and revision", async () => {
    const { fetch, calls } = fakeGoogle(() => json(MULTI_TAB_DOCUMENT));
    const result = await readDoc.call({ documentId: "doc-synthetic-multi" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.host}${call.url.pathname}${call.url.search}`)).toEqual([
      "GET docs.googleapis.com/v1/documents/doc-synthetic-multi?includeTabsContent=true",
    ]);
    const content = (result.structuredContent as { content: Record<string, unknown> }).content;
    expect(content).toMatchObject({ documentId: "doc-synthetic-multi", revisionId: "ALm37BV-synthetic-rev", text: MULTI_TAB_TEXT });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("refuses a malformed document ID without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const documentId of ["", "../x", "a/b", "a b", "a:batchUpdate", "x".repeat(257)]) {
      expect((await readDoc.call({ documentId }, http)).isError, documentId).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("returns Google's failures as tool errors", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 404 } }, 404));
    expect(await readDoc.call({ documentId: "gone" }, createGoogleHttp({ accessToken: "t", fetch }))).toEqual({
      isError: true, content: [{ type: "text", text: "Google could not find that item." }],
    });
  });

  it("refuses a result over the size limit with a clear error instead of cutting it short", async () => {
    const paragraph = "x".repeat(10_000);
    const big = oneTab(Array.from({ length: Math.ceil(MAX_RESULT_BYTES / 20_000) + 5 }, () => text(paragraph)));
    const { fetch } = fakeGoogle(() => json(big));
    const result = await readDoc.call({ documentId: "big" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^This document is too large to return in one result \(\d+\.\d MB; the limit is 1 MB\)\. Nothing was returned\./);
    expect(result.structuredContent).toBeUndefined();
  });
});
