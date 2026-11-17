import { describe, expect, it } from "vitest";
import { GoogleToolError } from "../errors.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { FALLBACK_MAX_RESULT_BYTES, serializedResultBytes } from "../tool.js";
import { downloadPlan } from "./content.js";
import { downloadFileContent } from "./download-file-content.js";
import { READ_LESS, type RestFile } from "./file.js";
import { DOC, DRAWING, FOLDER, FORM, HUGE_PDF, PDF, SHEET, SLIDES, TEXT_FILE } from "./fixtures/drive-rest.js";

const plan = (file: RestFile, exportMimeType?: string, revision?: string) => downloadPlan(file.id!, file, exportMimeType, revision, READ_LESS.download, FALLBACK_MAX_RESULT_BYTES);
const target = (file: RestFile, exportMimeType?: string, revision?: string) => {
  const planned = plan(file, exportMimeType, revision);
  const query = Object.entries(planned.request.query ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]);
  return `${planned.request.path}?${new URLSearchParams(query).toString()} as ${planned.contentType}`;
};

describe("download plan", () => {
  it.each([
    [DOC, undefined, undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=text%2Fplain as text/plain"],
    [SHEET, undefined, undefined, "/drive/v3/files/sheet0001synthetic/export?mimeType=text%2Fcsv as text/csv"],
    [SLIDES, undefined, undefined, "/drive/v3/files/slides0001synthetic/export?mimeType=text%2Fplain as text/plain"],
    [DRAWING, undefined, undefined, "/drive/v3/files/draw0001synthetic/export?mimeType=image%2Fsvg%2Bxml as image/svg+xml"],
    [DOC, "application/pdf", undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=application%2Fpdf as application/pdf"],
    [DOC, "text/markdown", undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=text%2Fmarkdown as text/markdown"],
    [SHEET, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", undefined, "/drive/v3/files/sheet0001synthetic/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet as application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [PDF, undefined, undefined, "/drive/v3/files/pdf0001synthetic?alt=media&supportsAllDrives=true as application/pdf"],
    [PDF, "text/plain", undefined, "/drive/v3/files/pdf0001synthetic?alt=media&supportsAllDrives=true as application/pdf"],
    [TEXT_FILE, undefined, "rev0001", "/drive/v3/files/text0001synthetic/revisions/rev0001?alt=media as text/plain"],
    [HUGE_PDF, undefined, "rev0002", "/drive/v3/files/pdf0002synthetic/revisions/rev0002?alt=media as application/pdf"],
  ] as const)("%#: %s with export %s, revision %s", (file, exportMimeType, revision, expected) => {
    expect(target(file, exportMimeType, revision)).toBe(expected);
  });

  it.each([
    [FOLDER, undefined, undefined, /have no content to download/],
    [FORM, undefined, undefined, /have no content to download/],
    [DOC, undefined, "rev0001", /Earlier revisions/],
    [HUGE_PDF, undefined, undefined, /This file is 10,485,761 bytes, more than the 250,000 bytes/],
    [DOC, "image/png", undefined, /cannot be exported as image\/png. Use one of: text\/plain/],
    [SHEET, "text/plain", undefined, /cannot be exported as text\/plain/],
    [SLIDES, "application/x-anything", undefined, /cannot be exported/],
  ] as const)("%#: refuses %s", (file, exportMimeType, revision, message) => {
    expect(() => plan(file, exportMimeType, revision)).toThrow(GoogleToolError);
    expect(() => plan(file, exportMimeType, revision)).toThrow(message);
  });

  it("always addresses the file the caller named, not an ID from Google's answer", () => {
    expect(downloadPlan("callerFile1", { ...PDF, id: "otherFile9" }, undefined, undefined, "", FALLBACK_MAX_RESULT_BYTES).request.path).toBe("/drive/v3/files/callerFile1");
    expect(downloadPlan("callerFile1", { ...DOC, id: "otherFile9" }, undefined, undefined, "", FALLBACK_MAX_RESULT_BYTES).request.path).toBe("/drive/v3/files/callerFile1/export");
  });
});

describe("download_file_content tool", () => {
  it("reads metadata, downloads the bytes, and returns them as base64 with the file's type", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("alt") === "media"
      ? new Response(bytes, { headers: { "content-type": "application/pdf" } })
      : json(PDF)));
    const result = await downloadFileContent.call({ fileId: PDF.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.url.pathname)).toEqual(["/drive/v3/files/pdf0001synthetic", "/drive/v3/files/pdf0001synthetic"]);
    expect(calls[0]!.url.searchParams.get("fields")).toBe("id,name,mimeType,size");
    expect(calls[1]!.headers.accept).toBe("*/*");
    expect(result.structuredContent).toEqual({ id: PDF.id, title: "report.pdf", mimeType: "application/pdf", content: bytes.toString("base64") });
  });

  it("downloads only the file the caller named, even if Google's metadata names another", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("alt") === "media" ? new Response("x") : json({ ...TEXT_FILE, id: "otherFile9" })));
    const result = await downloadFileContent.call({ fileId: "callerFile1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.url.pathname)).toEqual(["/drive/v3/files/callerFile1", "/drive/v3/files/callerFile1"]);
    expect(result.structuredContent).toMatchObject({ id: "callerFile1" });
  });

  it("exports a Google Doc as plain text by default and reports the export type", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/export") ? new Response("Hello\n") : json(DOC)));
    const result = await downloadFileContent.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[1]!.url.searchParams.get("mimeType")).toBe("text/plain");
    expect(result.structuredContent).toMatchObject({ mimeType: "text/plain", content: Buffer.from("Hello\n").toString("base64") });
  });

  it("refuses a file whose stored size is over the cap without downloading it, and says what to do instead", async () => {
    const { fetch, calls } = fakeGoogle(() => json(HUGE_PDF));
    const result = await downloadFileContent.call({ fileId: HUGE_PDF.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: `This file is 10,485,761 bytes, more than the 250,000 bytes this tool can return, so nothing was returned. ${READ_LESS.download}` }] });
  });

  it("refuses an export that streams past the cap, and never returns a cut-short result", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.endsWith("/export")
      ? new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(FALLBACK_MAX_RESULT_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }))
      : json(SHEET)));
    const result = await downloadFileContent.call({ fileId: SHEET.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: `This file's content is more than the 250,000 bytes this tool can return, so nothing was returned. ${READ_LESS.download}` }] });
  });

  it("bounds the final serialized result: the largest file that fits is returned, one byte more is refused", async () => {
    const run = async (size: number) => {
      const { fetch } = fakeGoogle(({ url }) => (url.searchParams.get("alt") === "media"
        ? new Response(new Uint8Array(size).fill(0xff))
        : json({ ...PDF, size: String(size) })));
      return downloadFileContent.call({ fileId: PDF.id }, createGoogleHttp({ accessToken: "t", fetch }));
    };
    let largest = 0;
    for (let step = 1 << 17; step >= 1; step >>= 1) {
      if (!(await run(largest + step)).isError) largest += step;
    }
    const fits = await run(largest);
    expect(serializedResultBytes(fits)).toBeLessThanOrEqual(FALLBACK_MAX_RESULT_BYTES);
    expect(serializedResultBytes(fits)).toBeGreaterThan(FALLBACK_MAX_RESULT_BYTES - 16);
    const over = await run(largest + 3);
    expect((over.content[0] as { text: string }).text).toMatch(/^The result is [\d,]+ bytes, more than the 250,000 bytes this tool can return, so it was not returned\. This tool cannot return part of a file/);
  });

  it("reports Google's export size limit as too large", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.endsWith("/export")
      ? json({ error: { code: 403, errors: [{ reason: "exportSizeLimitExceeded" }] } }, 403)
      : json(DOC)));
    const result = await downloadFileContent.call({ fileId: DOC.id, exportMimeType: "application/pdf" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "This file is larger than Google's 10 MB export limit. Nothing was returned." }] });
  });

  it("does not follow a redirect to another host", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("alt") === "media"
      ? new Response(null, { status: 302, headers: { location: "https://content.example.test/blob" } })
      : json(PDF)));
    const result = await downloadFileContent.call({ fileId: PDF.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Google answered with a redirect, which is not followed." }] });
    expect(calls.every((call) => call.url.host === "www.googleapis.com")).toBe(true);
  });

  it("refuses bad arguments without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json(DOC));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const args of [{}, { fileId: "a/b" }, { fileId: DOC.id, exportMimeType: "text/plain\r\nX-Evil: 1" }, { fileId: DOC.id, revisionId: "../x" }]) {
      expect((await downloadFileContent.call(args, http)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
