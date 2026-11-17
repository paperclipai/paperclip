import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { PDF } from "./fixtures/drive-rest.js";
import { listRecentFiles, listRecentFilesRequest, recentOrder } from "./list-recent-files.js";

describe("list_recent_files request", () => {
  it.each([
    [undefined, "recency desc"],
    ["recency", "recency desc"],
    ["lastModified", "modifiedTime desc"],
    ["lastModifiedByMe", "modifiedByMeTime desc"],
    ["name", "recency desc"],
    ["toString", "recency desc"],
    ["", "recency desc"],
  ])("orderBy %j sorts by %s", (orderBy, expected) => {
    expect(recentOrder(orderBy)).toBe(expected);
  });

  it("lists files that are not trashed, 10 by default and at most 100", () => {
    const request = listRecentFilesRequest({ pageToken: "p2" });
    expect(request).toMatchObject({ method: "GET", host: "www.googleapis.com", path: "/drive/v3/files" });
    expect(request.query).toMatchObject({ q: "trashed = false", orderBy: "recency desc", pageSize: 10, pageToken: "p2" });
    expect(listRecentFilesRequest({ pageSize: 1000 }).query?.pageSize).toBe(100);
  });
});

describe("list_recent_files tool", () => {
  it("returns one page of files", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ files: [PDF] }));
    const result = await listRecentFiles.call({ orderBy: "lastModified", pageSize: 5 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(calls[0]!.url.searchParams.get("pageSize")).toBe("5");
    expect(result.structuredContent).toEqual({
      files: [{ id: "pdf0001synthetic", title: "report.pdf", mimeType: "application/pdf", fileSize: "2048", fileExtension: "pdf", canAddChildren: false }],
    });
  });

  it("turns Google failures into tool errors", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, 403));
    const result = await listRecentFiles.call({}, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toMatchObject({ isError: true });
  });
});
