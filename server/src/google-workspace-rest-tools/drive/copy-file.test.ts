import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { copyFile, copyFileRequest } from "./copy-file.js";
import { DOC } from "./fixtures/drive-rest.js";

describe("copy_file request", () => {
  it.each([
    [{ fileId: "f1" }, {}],
    [{ fileId: "f1", title: "" }, {}],
    [{ fileId: "f1", title: "Copy", parentId: "folder1" }, { name: "Copy", parents: ["folder1"] }],
    [{ fileId: "f1", pregeneratedId: "gen1" }, { id: "gen1" }],
  ])("%#: copies %j with body %j", (input, body) => {
    expect(copyFileRequest(input)).toEqual({
      method: "POST",
      host: "www.googleapis.com",
      path: "/drive/v3/files/f1/copy",
      query: { fields: expect.stringContaining("webViewLink"), supportsAllDrives: true },
      body,
    });
  });
});

describe("copy_file tool", () => {
  it("returns the new copy", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ ...DOC, id: "copy0001synthetic", name: "Copy of Quarterly plan" }));
    const result = await copyFile.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["POST /drive/v3/files/doc0001synthetic/copy"]);
    expect(result.structuredContent).toMatchObject({ id: "copy0001synthetic", title: "Copy of Quarterly plan" });
  });

  it("explains that drive.file may not cover the source, and says nothing was copied", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 404, message: "File not found: f1." } }, 404));
    const result = await copyFile.call({ fileId: "f1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe(
      "Google could not find the file, or this connection cannot use it: with drive.file access it can only use files and folders that this app created or that were opened with it. Nothing was created.",
    );
    const denied = fakeGoogle(() => json({ error: { code: 403, message: "The user has not granted the app 99 write access", errors: [{ reason: "appNotAuthorizedToFile" }] } }, 403));
    const refused = await copyFile.call({ fileId: "f1", parentId: "p1" }, createGoogleHttp({ accessToken: "t", fetch: denied.fetch }));
    expect((refused.content[0] as { text: string }).text).toMatch(/^This connection can change only files that this app created/);
  });

  it("never retries a copy and warns that it may have happened", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 502 } }, 502));
    const result = await copyFile.call({ fileId: "f1" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("refuses bad IDs without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const args of [{}, { fileId: "../files" }, { fileId: "f1", parentId: "a b" }]) {
      expect((await copyFile.call(args, http)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});
