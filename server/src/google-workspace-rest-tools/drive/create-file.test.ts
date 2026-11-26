import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { createFile, createFileRequest, createPlan, decodeBase64, multipartBody, type CreateFileArgs } from "./create-file.js";

const DOC_TYPE = "application/vnd.google-apps.document";
const created = { id: "new0001synthetic", name: "Notes", mimeType: DOC_TYPE, parents: ["root0001"], webViewLink: "https://docs.example.test/d/new0001synthetic" };

describe("create plan", () => {
  it.each<[string, CreateFileArgs, unknown]>([
    ["an empty Google Doc", { title: "Notes", contentMimeType: DOC_TYPE }, { metadata: { name: "Notes", mimeType: DOC_TYPE } }],
    ["an empty Sheet via the deprecated mimeType", { title: "S", mimeType: "application/vnd.google-apps.spreadsheet" }, { metadata: { name: "S", mimeType: "application/vnd.google-apps.spreadsheet" } }],
    ["a folder in a parent, without inherited sharing", { title: "F", contentMimeType: "application/vnd.google-apps.folder", parentId: "parent1", inheritedPermissionsDisabled: true }, { metadata: { name: "F", mimeType: "application/vnd.google-apps.folder", parents: ["parent1"], inheritedPermissionsDisabled: true } }],
    ["a folder with a pregenerated ID", { title: "F", contentMimeType: "application/vnd.google-apps.folder", pregeneratedId: "gen1" }, { metadata: { name: "F", mimeType: "application/vnd.google-apps.folder", id: "gen1" } }],
    ["text converted to a Doc", { title: "T", contentMimeType: "text/plain", textContent: "hi" }, { metadata: { name: "T", mimeType: DOC_TYPE }, media: { contentType: "text/plain", data: Buffer.from("hi") } }],
    ["Markdown converted to a Doc", { title: "M", contentMimeType: "text/markdown", textContent: "# x" }, { metadata: { name: "M", mimeType: DOC_TYPE }, media: { contentType: "text/markdown", data: Buffer.from("# x") } }],
    ["CSV converted to a Sheet", { title: "C", contentMimeType: "text/csv", textContent: "a,b" }, { metadata: { name: "C", mimeType: "application/vnd.google-apps.spreadsheet" }, media: { contentType: "text/csv", data: Buffer.from("a,b") } }],
    ["text kept as text", { title: "T", contentMimeType: "text/plain", textContent: "hi", disableConversionToGoogleType: true }, { metadata: { name: "T", mimeType: "text/plain" }, media: { contentType: "text/plain", data: Buffer.from("hi") } }],
    ["bytes with no Google equivalent", { title: "P", contentMimeType: "image/png", base64Content: "iVBORw==" }, { metadata: { name: "P", mimeType: "image/png" }, media: { contentType: "image/png", data: Buffer.from("iVBORw==", "base64") } }],
    ["the deprecated content field", { title: "P", contentMimeType: "application/pdf", content: "JVBERg==" }, { metadata: { name: "P", mimeType: "application/pdf" }, media: { contentType: "application/pdf", data: Buffer.from("%PDF") } }],
    ["unconverted bytes with a pregenerated ID", { title: "P", contentMimeType: "image/png", base64Content: "AA==", pregeneratedId: "gen2", disableConversionToGoogleType: true }, { metadata: { name: "P", mimeType: "image/png", id: "gen2" }, media: { contentType: "image/png", data: Buffer.from([0]) } }],
  ])("plans %s", (_name, input, expected) => {
    expect(createPlan(input)).toEqual(expected);
  });

  it.each<[string, CreateFileArgs, RegExp]>([
    ["two contents", { title: "T", contentMimeType: "text/plain", textContent: "a", base64Content: "YQ==" }, /only one of/],
    ["no content and no type", { title: "T" }, /Without content, contentMimeType must be/],
    ["no content with a plain type", { title: "T", contentMimeType: "text/plain" }, /Without content/],
    ["content without a type", { title: "T", textContent: "a" }, /contentMimeType is required/],
    ["content typed as a Google file", { title: "T", contentMimeType: DOC_TYPE, textContent: "a" }, /not a Google file type/],
    ["a pregenerated ID for a Doc", { title: "T", contentMimeType: DOC_TYPE, pregeneratedId: "gen1" }, /pregeneratedId cannot be used/],
    ["a pregenerated ID with conversion", { title: "T", contentMimeType: "text/plain", textContent: "a", pregeneratedId: "gen1" }, /set disableConversionToGoogleType/],
    ["inherited sharing off for a Doc", { title: "T", contentMimeType: DOC_TYPE, inheritedPermissionsDisabled: true }, /folders only/],
    ["invalid base64", { title: "T", contentMimeType: "image/png", base64Content: "not base64!" }, /not valid base64/],
    ["content over 5 MB", { title: "T", contentMimeType: "text/plain", textContent: "é".repeat(2.5 * 1024 * 1024 + 1) }, /at most 5 MB/],
  ])("refuses %s", (_name, input, message) => {
    expect(() => createPlan(input)).toThrow(message);
  });

  it("decodes standard and URL-safe base64, ignoring whitespace", () => {
    expect(decodeBase64("aGVs\nbG8=")).toEqual(Buffer.from("hello"));
    expect(decodeBase64("-_8")).toEqual(Buffer.from([0xfb, 0xff]));
    expect(() => decodeBase64("abcde")).toThrow(/not valid base64/);
  });

  it("builds a multipart/related body with the metadata first and the bytes unchanged", () => {
    const body = multipartBody({ name: "x" }, { contentType: "image/png", data: Buffer.from([0, 255, 13, 10]) }, "BOUNDARY");
    expect(body).toEqual(Buffer.concat([
      Buffer.from("--BOUNDARY\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{\"name\":\"x\"}\r\n--BOUNDARY\r\nContent-Type: image/png\r\n\r\n"),
      Buffer.from([0, 255, 13, 10]),
      Buffer.from("\r\n--BOUNDARY--\r\n"),
    ]));
  });

  it("creates empty Google files with a metadata-only POST and uploads content to the upload path", () => {
    expect(createFileRequest(createPlan({ title: "N", contentMimeType: DOC_TYPE }), "b")).toMatchObject({
      method: "POST", host: "www.googleapis.com", path: "/drive/v3/files", body: { name: "N", mimeType: DOC_TYPE },
    });
    const upload = createFileRequest(createPlan({ title: "N", contentMimeType: "text/plain", textContent: "x" }), "b");
    expect(upload).toMatchObject({
      method: "POST", host: "www.googleapis.com", path: "/upload/drive/v3/files",
      query: { uploadType: "multipart", supportsAllDrives: true },
      upload: { contentType: "multipart/related; boundary=b" },
    });
    expect(upload.body).toBeUndefined();
  });
});

describe("create_file tool", () => {
  it("uploads text and returns the new file", async () => {
    const { fetch, calls } = fakeGoogle(() => json(created));
    const result = await createFile.call({ title: "Notes", contentMimeType: "text/plain", textContent: "hello" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/upload/drive/v3/files");
    expect(calls[0]!.headers["content-type"]).toMatch(/^multipart\/related; boundary=[0-9a-f]{32}$/);
    const raw = calls[0]!.raw!.toString("utf8");
    expect(raw).toContain("{\"name\":\"Notes\",\"mimeType\":\"application/vnd.google-apps.document\"}");
    expect(raw).toContain("Content-Type: text/plain\r\n\r\nhello\r\n");
    expect(result.structuredContent).toEqual({
      id: "new0001synthetic", title: "Notes", parentId: "root0001", mimeType: DOC_TYPE, viewUrl: "https://docs.example.test/d/new0001synthetic", canAddChildren: false,
    });
  });

  it("never retries and says the file may exist after a failure once sent", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 503 } }, 503));
    const result = await createFile.call({ title: "N", contentMimeType: DOC_TYPE }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
    const network = fakeGoogle(() => { throw new TypeError("fetch failed"); });
    const dropped = await createFile.call({ title: "N", contentMimeType: "text/plain", textContent: "x" }, createGoogleHttp({ accessToken: "t", fetch: network.fetch, retryDelayMs: 0 }));
    expect(network.calls).toHaveLength(1);
    expect((dropped.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("explains a parent folder the app cannot use", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 404, message: "File not found: parent1." } }, 404));
    const result = await createFile.call({ title: "N", contentMimeType: DOC_TYPE, parentId: "parent1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe(
      "Google could not find the parent folder, or this connection cannot use it: with drive.file access it can only use files and folders that this app created or that were opened with it. Nothing was created.",
    );
  });

  it("sends nothing for invalid input", async () => {
    const { fetch, calls } = fakeGoogle(() => json(created));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const args of [{}, { title: "" }, { title: "T", contentMimeType: "text/plain\r\nX: y", textContent: "a" }, { title: "T", contentMimeType: DOC_TYPE, parentId: "../x" }]) {
      expect((await createFile.call(args, http)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
