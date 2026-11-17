import { describe, expect, it } from "vitest";
import { GoogleToolError } from "../errors.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { downloadPlan } from "./content.js";
import { downloadFileContent } from "./download-file-content.js";
import { MAX_CONTENT_BYTES, type RestFile } from "./file.js";
import { DOC, DRAWING, FOLDER, FORM, HUGE_PDF, PDF, SHEET, SLIDES, TEXT_FILE } from "./fixtures/drive-rest.js";

const target = (file: RestFile, exportMimeType?: string, revision?: string) => {
  const plan = downloadPlan(file, exportMimeType, revision);
  return `${plan.request.path}?${new URLSearchParams(Object.entries(plan.request.query ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString()} as ${plan.contentType}`;
};

describe("download plan", () => {
  it.each([
    [DOC, undefined, undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=text%2Fplain as text/plain"],
    [SHEET, undefined, undefined, "/drive/v3/files/sheet0001synthetic/export?mimeType=text%2Fcsv as text/csv"],
    [SLIDES, undefined, undefined, "/drive/v3/files/slides0001synthetic/export?mimeType=text%2Fplain as text/plain"],
    [DRAWING, undefined, undefined, "/drive/v3/files/draw0001synthetic/export?mimeType=image%2Fsvg%2Bxml as image/svg+xml"],
    [DOC, "application/pdf", undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=application%2Fpdf as application/pdf"],
    [DOC, "text/markdown", undefined, "/drive/v3/files/doc0001synthetic/export?mimeType=text%2Fmarkdown as text/markdown"],
    [PDF, undefined, undefined, "/drive/v3/files/pdf0001synthetic?alt=media&supportsAllDrives=true as application/pdf"],
    [PDF, "text/plain", undefined, "/drive/v3/files/pdf0001synthetic?alt=media&supportsAllDrives=true as application/pdf"],
    [TEXT_FILE, undefined, "rev0001", "/drive/v3/files/text0001synthetic/revisions/rev0001?alt=media as text/plain"],
    [HUGE_PDF, undefined, "rev0002", "/drive/v3/files/pdf0002synthetic/revisions/rev0002?alt=media as application/pdf"],
  ] as const)("%#: %s with export %s, revision %s", (file, exportMimeType, revision, expected) => {
    expect(target(file, exportMimeType, revision)).toBe(expected);
  });

  it.each([
    [FOLDER, undefined, /have no content to download/],
    [FORM, undefined, /have no content to download/],
    [DOC, "rev0001", /Earlier revisions/],
    [HUGE_PDF, undefined, /larger than 10 MB/],
  ] as const)("%#: refuses %s", (file, revision, message) => {
    expect(() => downloadPlan(file, undefined, revision)).toThrow(GoogleToolError);
    expect(() => downloadPlan(file, undefined, revision)).toThrow(message);
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

  it("exports a Google Doc as plain text by default and reports the export type", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.pathname.endsWith("/export") ? new Response("Hello\n") : json(DOC)));
    const result = await downloadFileContent.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[1]!.url.searchParams.get("mimeType")).toBe("text/plain");
    expect(result.structuredContent).toMatchObject({ mimeType: "text/plain", content: Buffer.from("Hello\n").toString("base64") });
  });

  it("refuses a file whose stored size is over the cap without downloading it", async () => {
    const { fetch, calls } = fakeGoogle(() => json(HUGE_PDF));
    const result = await downloadFileContent.call({ fileId: HUGE_PDF.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^This file is 10485761 bytes, larger than 10 MB/);
  });

  it("refuses an export that streams past the cap, and never returns a cut-short result", async () => {
    const { fetch } = fakeGoogle(({ url }) => (url.pathname.endsWith("/export")
      ? new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_CONTENT_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }))
      : json(SHEET)));
    const result = await downloadFileContent.call({ fileId: SHEET.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The content is larger than 10 MB, the most this tool returns. Nothing was returned." }] });
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
