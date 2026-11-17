import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { getFilePermissions, permissionsRequest, toMcpPermission } from "./get-file-permissions.js";

describe("get_file_permissions mapping", () => {
  it.each([
    [{ id: "p1", type: "user", role: "owner", emailAddress: "owner@example.test", displayName: "Owner" }, { role: "owner", type: "user", emailAddress: "owner@example.test", displayName: "Owner" }],
    [{ type: "group", role: "writer", emailAddress: "team@example.test", displayName: "Team" }, { role: "writer", type: "group", emailAddress: "team@example.test", displayName: "Team" }],
    [{ type: "domain", role: "reader", domain: "example.test" }, { role: "reader", type: "domain", displayName: "example.test" }],
    [{ type: "anyone", role: "reader", view: "published" }, { role: "reader", type: "anyone", view: "published" }],
  ])("maps %j", (permission, expected) => {
    expect(toMcpPermission(permission)).toEqual(expected);
  });

  it("reads 100 at a time across shared drives", () => {
    expect(permissionsRequest("file1", "tok")).toMatchObject({
      method: "GET",
      path: "/drive/v3/files/file1/permissions",
      query: { pageSize: 100, pageToken: "tok", supportsAllDrives: true },
    });
  });
});

describe("get_file_permissions tool", () => {
  it("follows pages and leaves out deleted permissions", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("pageToken")
      ? json({ permissions: [{ type: "anyone", role: "reader" }, { type: "user", role: "reader", deleted: true }] })
      : json({ permissions: [{ type: "user", role: "owner", emailAddress: "owner@example.test" }], nextPageToken: "p2" })));
    const result = await getFilePermissions.call({ fileId: "file1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(2);
    expect(result.structuredContent).toEqual({
      permissions: [{ role: "owner", type: "user", emailAddress: "owner@example.test" }, { role: "reader", type: "anyone" }],
    });
  });

  it("refuses rather than returning part of a very long list", async () => {
    let page = 0;
    const { fetch, calls } = fakeGoogle(() => json({ permissions: [{ type: "user", role: "reader" }], nextPageToken: `p${++page}` }));
    const result = await getFilePermissions.call({ fileId: "file1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(10);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "This file has more than 1000 permissions, more than this tool returns." }] });
  });

  it("passes on Google's refusal when the user may not see sharing", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 403, message: "The user does not have sufficient permissions for this file." } }, 403));
    const result = await getFilePermissions.call({ fileId: "file1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "The user does not have sufficient permissions for this file." }] });
  });
});
