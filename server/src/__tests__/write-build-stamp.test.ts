import { describe, expect, it } from "vitest";

import { normalizeBuildCommit, resolveBuildCommit } from "../../scripts/write-build-stamp.mjs";

describe("write-build-stamp", () => {
  it("normalizes only full commit SHAs", () => {
    expect(normalizeBuildCommit(" ABCDEF0123456789ABCDEF0123456789ABCDEF01\n")).toBe(
      "abcdef0123456789abcdef0123456789abcdef01",
    );
    expect(normalizeBuildCommit("abcdef0")).toBeNull();
  });

  it("prefers a valid checkout commit and falls back to the supplied SHA", () => {
    const gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const suppliedCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(resolveBuildCommit(gitCommit, suppliedCommit)).toBe(gitCommit);
    expect(resolveBuildCommit(null, suppliedCommit)).toBe(suppliedCommit);
    expect(resolveBuildCommit("short", "invalid")).toBeNull();
  });
});
