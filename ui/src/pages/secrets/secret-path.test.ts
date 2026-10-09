import { describe, expect, it } from "vitest";
import {
  buildSecretPathBreadcrumbs,
  buildSecretPathListing,
  getSecretPathRowName,
  normalizeSecretPath,
  validateSecretFolderSegment,
  type SecretPathRow,
} from "./secret-path";

type TestRow = SecretPathRow & { id: string };

function companyRow(id: string, name: string): TestRow {
  return { id, kind: "company", secret: { name } };
}

function userRow(id: string, name: string): TestRow {
  return { id, kind: "user", definition: { name } };
}

describe("secret path normalization", () => {
  it("ignores leading, duplicate, and trailing slashes without changing stored names", () => {
    const rows = [
      companyRow("github", "/dev//github/"),
      companyRow("token", "//prod///api//token/"),
      userRow("standalone", "/standalone/"),
    ];

    expect(normalizeSecretPath("//dev///github/")).toBe("dev/github");
    expect(buildSecretPathListing(rows, "/")).toEqual({
      folders: [
        { name: "dev", path: "dev", secretCount: 1, folderCount: 0 },
        { name: "prod", path: "prod", secretCount: 1, folderCount: 1 },
      ],
      secrets: [rows[2]],
    });
    expect(getSecretPathRowName(rows[0])).toBe("/dev//github/");
  });

  it("keeps no-slash names at the root", () => {
    const rows = [companyRow("one", "alpha"), userRow("two", "beta")];

    expect(buildSecretPathListing(rows, "")).toEqual({ folders: [], secrets: rows });
  });
});

describe("buildSecretPathListing", () => {
  it("shows a name as both a direct secret and a folder when it is also a prefix", () => {
    const exact = companyRow("exact", "dev");
    const nested = companyRow("nested", "dev/oauth/token");

    expect(buildSecretPathListing([exact, nested], "")).toEqual({
      folders: [{ name: "dev", path: "dev", secretCount: 1, folderCount: 1 }],
      secrets: [exact],
    });
    expect(buildSecretPathListing([exact, nested], "dev")).toEqual({
      folders: [{ name: "oauth", path: "dev/oauth", secretCount: 1, folderCount: 0 }],
      secrets: [exact],
    });
  });

  it("groups case-sensitively while sorting case-insensitively", () => {
    const rows = [
      companyRow("lower-child", "dev/token"),
      companyRow("upper-child", "Dev/token"),
      companyRow("zebra", "zebra"),
      companyRow("alpha-upper", "Alpha"),
      companyRow("alpha-lower", "alpha"),
    ];
    const listing = buildSecretPathListing(rows, "");

    expect(listing.folders.map((folder) => folder.name)).toEqual(["dev", "Dev"]);
    expect(listing.secrets.map(getSecretPathRowName)).toEqual(["Alpha", "alpha", "zebra"]);
  });

  it("naturally sorts folders and secrets", () => {
    const rows = [
      companyRow("env10", "env10/token"),
      companyRow("env2", "env2/token"),
      companyRow("key10", "key10"),
      companyRow("key2", "key2"),
    ];
    const listing = buildSecretPathListing(rows, "");

    expect(listing.folders.map((folder) => folder.name)).toEqual(["env2", "env10"]);
    expect(listing.secrets.map(getSecretPathRowName)).toEqual(["key2", "key10"]);
  });

  it("preserves encoded and special characters in segments and breadcrumbs", () => {
    const row = companyRow("special", "team & ops/100%/api?key=a%2Fb");

    expect(buildSecretPathListing([row], "team & ops").folders).toEqual([
      {
        name: "100%",
        path: "team & ops/100%",
        secretCount: 1,
        folderCount: 0,
      },
    ]);
    expect(buildSecretPathBreadcrumbs("/team & ops//100%/api?key=a%2Fb/")).toEqual([
      { name: "team & ops", path: "team & ops" },
      { name: "100%", path: "team & ops/100%" },
      { name: "api?key=a%2Fb", path: "team & ops/100%/api?key=a%2Fb" },
    ]);
  });

  it("computes recursive secret and folder counts from the provided rows", () => {
    const allRows = [
      companyRow("direct", "dev/direct"),
      companyRow("a", "dev/a/token"),
      companyRow("b", "dev/b/token"),
      companyRow("deep", "dev/b/deep/token"),
      companyRow("filtered", "dev/c/hidden"),
    ];
    const filteredRows = allRows.filter((row) => row.id !== "filtered");

    expect(buildSecretPathListing(filteredRows, "").folders).toEqual([
      { name: "dev", path: "dev", secretCount: 4, folderCount: 3 },
    ]);
    expect(buildSecretPathListing(filteredRows, "dev")).toEqual({
      folders: [
        { name: "a", path: "dev/a", secretCount: 1, folderCount: 0 },
        { name: "b", path: "dev/b", secretCount: 2, folderCount: 1 },
      ],
      secrets: [allRows[0]],
    });
  });
});

describe("validateSecretFolderSegment", () => {
  it("rejects empty and slash-containing folder segments", () => {
    expect(validateSecretFolderSegment("   ")).toBe("Folder name is required.");
    expect(validateSecretFolderSegment("dev/prod")).toBe(
      "Folder name cannot contain slashes.",
    );
  });

  it("accepts trimmed and special-character segment names", () => {
    expect(validateSecretFolderSegment("  dev tools  ")).toBeNull();
    expect(validateSecretFolderSegment("100% & encoded%2Fvalue")).toBeNull();
  });
});
