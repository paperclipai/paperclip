import { describe, expect, it } from "vitest";
import { fakeGoogle, json, type RecordedCall } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { FALLBACK_MAX_RESULT_BYTES, serializedResultBytes } from "../tool.js";
import { READ_LESS, type RestFile } from "./file.js";
import { DOC, DRAWING, FOLDER, HUGE_PDF, JSON_FILE, PDF, SHEET, SLIDES, TEXT_FILE } from "./fixtures/drive-rest.js";
import { decodeText, readFileContent, readPlan, SHEET_NOTE, toCommentThread } from "./read-file-content.js";

describe("read plan", () => {
  it.each([
    [DOC, "/drive/v3/files/doc0001synthetic/export", "text/markdown"],
    [SLIDES, "/drive/v3/files/slides0001synthetic/export", "text/plain"],
    [SHEET, "/drive/v3/files/sheet0001synthetic/export", "text/csv"],
    [TEXT_FILE, "/drive/v3/files/text0001synthetic", "text/plain"],
    [JSON_FILE, "/drive/v3/files/json0001synthetic", "application/json"],
    [{ id: "x1", mimeType: "application/ld+json", size: "3" }, "/drive/v3/files/x1", "application/ld+json"],
  ] as const)("%#: reads %s from %s as %s", (file, path, contentType) => {
    const plan = readPlan(file.id!, file, FALLBACK_MAX_RESULT_BYTES);
    expect(plan?.request.path).toBe(path);
    expect(plan?.contentType).toBe(contentType);
  });

  it.each([PDF, FOLDER, DRAWING, { id: "i1", mimeType: "image/png" }, { id: "w1", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }])(
    "%#: has no text version of %s",
    (file: RestFile) => {
      expect(readPlan(file.id!, file, FALLBACK_MAX_RESULT_BYTES)).toBeNull();
    },
  );

  it("refuses a text file over the cap before downloading", () => {
    expect(() => readPlan("big1", { ...HUGE_PDF, mimeType: "text/plain" }, FALLBACK_MAX_RESULT_BYTES)).toThrow(/more than the 250,000 bytes/);
  });

  it("decodes UTF-8, drops a byte order mark, and rejects bytes that are not UTF-8", () => {
    expect(decodeText(Buffer.from("﻿café", "utf8"))).toBe("café");
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it.each([
    [{ id: "c1", content: "Why?", author: { displayName: "A" }, modifiedTime: "2026-11-01T00:00:00Z" }, { commentId: "c1", status: "OPEN", headPost: { postId: "c1", content: "Why?", authorName: "A", modifiedTime: "2026-11-01T00:00:00Z" }, replies: [] }],
    [{ id: "c2", content: "Done", resolved: true, replies: [{ id: "r1", content: "ok" }, { id: "r2", content: "", deleted: true }] }, { commentId: "c2", status: "RESOLVED", headPost: { postId: "c2", content: "Done" }, replies: [{ postId: "r1", content: "ok" }] }],
  ])("%#: maps a comment thread", (comment, expected) => {
    expect(toCommentThread(comment)).toEqual(expected);
  });
});

function route(file: RestFile, content: BodyInit | null, comments: (call: RecordedCall) => Response = () => json({ comments: [] })) {
  return fakeGoogle((call) => {
    if (call.url.pathname.endsWith("/comments")) return comments(call);
    if (call.url.pathname.endsWith("/export") || call.url.searchParams.get("alt") === "media") return new Response(content);
    return json(file);
  });
}

describe("read_file_content tool", () => {
  it("returns a Google Doc as Markdown", async () => {
    const { fetch, calls } = route(DOC, "# Plan\n\nShip it.\n");
    const result = await readFileContent.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[1]!.url.searchParams.get("mimeType")).toBe("text/markdown");
    expect(result.structuredContent).toEqual({ fileContent: "# Plan\n\nShip it.\n" });
  });

  it("says that a spreadsheet shows only its first sheet", async () => {
    const { fetch } = route(SHEET, "a,b\n1,2\n");
    const result = await readFileContent.call({ fileId: SHEET.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ fileContent: `${SHEET_NOTE}\na,b\n1,2\n` });
  });

  it("marks files with no text version, without downloading them", async () => {
    const { fetch, calls } = route(PDF, "%PDF");
    const result = await readFileContent.call({ fileId: PDF.id, includeComments: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(result.structuredContent).toEqual({
      fileContent: "", contentAnchoredComments: [], unanchoredComments: [], textFormattingNotSupported: true, commentsNotSupported: true,
    });
  });

  it("marks a text file that is not valid UTF-8 as having no text version", async () => {
    const { fetch } = route(TEXT_FILE, new Uint8Array([0xc3, 0x28]));
    const result = await readFileContent.call({ fileId: TEXT_FILE.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ fileContent: "", textFormattingNotSupported: true });
  });

  it("lists every comment thread across pages when asked", async () => {
    const { fetch, calls } = route(DOC, "text", ({ url }) => (url.searchParams.get("pageToken")
      ? json({ comments: [{ id: "c2", content: "second" }, { id: "c3", content: "gone", deleted: true }] })
      : json({ comments: [{ id: "c1", content: "first", resolved: true }], nextPageToken: "n" })));
    const result = await readFileContent.call({ fileId: DOC.id, includeComments: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.filter((call) => call.url.pathname.endsWith("/comments"))).toHaveLength(2);
    expect(result.structuredContent).toEqual({
      fileContent: "text",
      contentAnchoredComments: [],
      unanchoredComments: [
        { commentId: "c1", status: "RESOLVED", headPost: { postId: "c1", content: "first" }, replies: [] },
        { commentId: "c2", status: "OPEN", headPost: { postId: "c2", content: "second" }, replies: [] },
      ],
    });
  });

  it("refuses rather than returning some of a very long comment list", async () => {
    let page = 0;
    const { fetch } = route(SLIDES, "text", () => json({ comments: [{ id: `c${page}` }], nextPageToken: `p${++page}` }));
    const result = await readFileContent.call({ fileId: SLIDES.id, includeComments: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/more than 1000 comment threads/);
  });

  it("refuses content that grows past the cap while streaming", async () => {
    const { fetch } = route(SLIDES, new Uint8Array(FALLBACK_MAX_RESULT_BYTES + 1));
    const result = await readFileContent.call({ fileId: SLIDES.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: `This file's content is more than the 250,000 bytes this tool can return, so nothing was returned. ${READ_LESS.read}` }] });
  });

  it("bounds the final serialized result, including JSON escaping, with advice on reading less", async () => {
    const { fetch } = route(SLIDES, "\u0001".repeat(30_000));
    const result = await readFileContent.call({ fileId: SLIDES.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^The result is [\d,]+ bytes, more than the 250,000 bytes this tool can return, so it was not returned\. /);
    expect(text.endsWith(READ_LESS.read)).toBe(true);
    expect(Number(/[\d,]+/.exec(text)![0].replaceAll(",", ""))).toBeGreaterThan(2 * 6 * 30_000);
  });

  it("returns the largest text that fits and refuses one byte more", async () => {
    const run = async (size: number) => readFileContent.call({ fileId: SLIDES.id }, createGoogleHttp({ accessToken: "t", fetch: route(SLIDES, "a".repeat(size)).fetch }));
    let largest = 0;
    for (let step = 1 << 17; step >= 1; step >>= 1) if (!(await run(largest + step)).isError) largest += step;
    expect(serializedResultBytes(await run(largest))).toBeLessThanOrEqual(FALLBACK_MAX_RESULT_BYTES);
    expect(serializedResultBytes(await run(largest))).toBeGreaterThan(FALLBACK_MAX_RESULT_BYTES - 4);
    expect((await run(largest + 1)).isError).toBe(true);
  });
});
