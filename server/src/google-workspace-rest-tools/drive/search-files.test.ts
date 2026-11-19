import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { DOC, FOLDER } from "./fixtures/drive-rest.js";
import { searchFiles, searchFilesRequest, searchOrder } from "./search-files.js";

describe("search_files request", () => {
  it("builds one files.list request with a safe query, trash excluded, and the default page size", () => {
    expect(searchFilesRequest({ query: "title contains 'O\\'Brien'" })).toEqual({
      method: "GET",
      host: "www.googleapis.com",
      path: "/drive/v3/files",
      query: expect.objectContaining({
        q: "(name contains 'O\\'Brien') and trashed = false",
        orderBy: undefined,
        pageSize: 10,
        pageToken: undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    });
  });

  it.each([
    [undefined, 10],
    [1, 1],
    [100, 100],
    [500, 100],
  ])("pageSize %s becomes %i", (pageSize, expected) => {
    expect(searchFilesRequest({ pageSize }).query?.pageSize).toBe(expected);
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["modifiedTime", "modifiedTime desc"],
    ["modifiedTime desc", "modifiedTime desc"],
    ["modifiedTime asc", "modifiedTime"],
    ["viewedByMeTime", "viewedByMeTime desc"],
    [" viewedByMeTime asc ", "viewedByMeTime"],
  ])("orderBy %j becomes %j", (value, expected) => {
    expect(searchOrder(value)).toBe(expected);
  });

  it.each(["name", "modifiedTime sideways", "createdTime desc", "modifiedTime desc, name"])("refuses orderBy %j", (value) => {
    expect(() => searchOrder(value)).toThrow(/orderBy must be/);
  });

  it("asks for owner names, last modifier and sharing only with includeRichMetadata", () => {
    expect(String(searchFilesRequest({}).query?.fields)).not.toContain("lastModifyingUser");
    expect(String(searchFilesRequest({}).query?.fields)).toMatch(/^nextPageToken,incompleteSearch,files\(/);
    const rich = String(searchFilesRequest({ includeRichMetadata: true }).query?.fields);
    expect(rich).toContain("lastModifyingUser(displayName,emailAddress)");
    expect(rich).toContain("permissions(type,allowFileDiscovery)");
  });
});

describe("search_files tool", () => {
  it("returns Google's MCP file shape and the next page token", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ files: [DOC, FOLDER], nextPageToken: "next-1" }));
    const result = await searchFiles.call({ query: "fullText contains 'plan'" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("q")).toBe("(fullText contains 'plan') and trashed = false");
    expect(result.structuredContent).toEqual({
      files: [
        {
          id: "doc0001synthetic",
          title: "Quarterly plan",
          parentId: "folder0001synthetic",
          mimeType: "application/vnd.google-apps.document",
          description: "Synthetic test document",
          viewUrl: "https://docs.example.test/document/d/doc0001synthetic/edit",
          createdTime: "2026-10-01T09:00:00.000Z",
          modifiedTime: "2026-11-02T10:30:00.000Z",
          viewedByMeTime: "2026-11-03T08:00:00.000Z",
          owner: "owner@example.test",
          canAddChildren: false,
        },
        { id: "folder0001synthetic", title: "Projects", mimeType: "application/vnd.google-apps.folder", canAddChildren: true },
      ],
      nextPageToken: "next-1",
    });
  });

  it("adds rich metadata when asked", async () => {
    const { fetch } = fakeGoogle(() => json({ files: [{ ...DOC, permissions: [{ type: "user" }, { type: "anyone", allowFileDiscovery: false }] }] }));
    const result = await searchFiles.call({ includeRichMetadata: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { files: unknown[] }).files[0]).toMatchObject({
      ownerName: "Owner Example",
      lastModifyingUserName: "Editor Example",
      lastModifyingUserEmail: "editor@example.test",
      visibility: "anyoneWithLink",
    });
  });

  it("sends nothing for an invalid query or conflicting snippet options", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ files: [] }));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    const bad = await searchFiles.call({ query: "title contains 'x' or creator = 'me'" }, http);
    expect(bad).toEqual({ isError: true, content: [{ type: "text", text: "Invalid search query: the creator term is not supported by this implementation." }] });
    expect((await searchFiles.call({ excludeContentSnippets: true, snippetVerbosity: "BRIEF" }, http)).isError).toBe(true);
    expect((await searchFiles.call({ pageSize: 0 }, http)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a page whose result is over 250,000 bytes and says how to ask for less", async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ ...DOC, id: `doc${index}`, description: "d".repeat(2_000) }));
    const { fetch } = fakeGoogle(() => json({ files }));
    const result = await searchFiles.call({ pageSize: 100 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/more than the 250,000 bytes this tool can return, so it was not returned\. Ask for fewer files with a smaller pageSize/);
  });

  it("returns an empty list when nothing matches", async () => {
    const { fetch } = fakeGoogle(() => json({}));
    const result = await searchFiles.call({ query: "starred = true" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ files: [] });
  });

  it.each([
    [{ files: [DOC], incompleteSearch: true }, true],
    [{ files: [DOC], incompleteSearch: false }, undefined],
    [{ files: [DOC] }, undefined],
  ])("%#: says when Google's search was incomplete", async (answer, expected) => {
    const { fetch } = fakeGoogle(() => json(answer));
    const result = await searchFiles.call({ query: "fullText contains 'plan'" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.structuredContent as { incompleteSearch?: boolean }).incompleteSearch).toBe(expected);
  });
});
