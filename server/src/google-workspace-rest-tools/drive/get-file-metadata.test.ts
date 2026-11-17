import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { visibility } from "./file.js";
import { DOC, FOLDER } from "./fixtures/drive-rest.js";
import { getFileMetadata } from "./get-file-metadata.js";

describe("visibility", () => {
  it.each([
    [undefined, undefined],
    [[], "limited"],
    [[{ type: "user" }, { type: "group" }], "limited"],
    [[{ type: "domain" }], "domainWithLink"],
    [[{ type: "domain", allowFileDiscovery: true }], "domainCanFind"],
    [[{ type: "domain", allowFileDiscovery: true }, { type: "anyone" }], "anyoneWithLink"],
    [[{ type: "anyone", allowFileDiscovery: true }], "anyoneCanFind"],
    [[{ type: "anyone", deleted: true }], "limited"],
  ])("permissions %j are %s", (permissions, expected) => {
    expect(visibility(permissions)).toBe(expected);
  });
});

describe("get_file_metadata", () => {
  it("reads one file with the fields the MCP shape needs", async () => {
    const { fetch, calls } = fakeGoogle(() => json(DOC));
    const result = await getFileMetadata.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.pathname).toBe("/drive/v3/files/doc0001synthetic");
    expect(calls[0]!.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calls[0]!.url.searchParams.get("fields")).toContain("webViewLink");
    expect(result.structuredContent).toMatchObject({ id: DOC.id, title: "Quarterly plan", owner: "owner@example.test", viewUrl: DOC.webViewLink });
    expect(result.structuredContent).not.toHaveProperty("ownerName");
    expect(result.structuredContent).not.toHaveProperty("contentSnippet");
  });

  it("reports canAddChildren for folders only", async () => {
    const { fetch } = fakeGoogle(() => json(FOLDER));
    const result = await getFileMetadata.call({ fileId: FOLDER.id, includeRichMetadata: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toMatchObject({ canAddChildren: true });
    const { fetch: docFetch } = fakeGoogle(() => json({ ...DOC, capabilities: { canAddChildren: true } }));
    expect((await getFileMetadata.call({ fileId: DOC.id }, createGoogleHttp({ accessToken: "t", fetch: docFetch }))).structuredContent)
      .toMatchObject({ canAddChildren: false });
  });

  it("returns a tool error for a missing file and sends nothing for a bad ID", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 404 } }, 404));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    expect(await getFileMetadata.call({ fileId: "missing1" }, http)).toEqual({ isError: true, content: [{ type: "text", text: "Google could not find that item." }] });
    for (const fileId of ["../about", "a/b", "a?alt=media", "", "x".repeat(257)]) {
      expect((await getFileMetadata.call({ fileId }, http)).isError, fileId).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });
});
