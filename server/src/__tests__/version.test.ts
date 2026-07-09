import { describe, expect, it, vi } from "vitest";
import { parseGitDescribeVersion, resolveServerVersion } from "../version.js";

describe("parseGitDescribeVersion", () => {
  it("reports drift from the nearest release tag as a PEP 440 local version", () => {
    expect(parseGitDescribeVersion("v2026.626.0-58-g518fc71ce\n")).toBe(
      "2026.626.0+58.git.518fc71ce",
    );
  });

  it("collapses clean on-tag checkouts to the release version", () => {
    expect(parseGitDescribeVersion("v2026.626.0-0-g012345678\n")).toBe("2026.626.0");
  });

  it("adds dirty state to the local version segment", () => {
    expect(parseGitDescribeVersion("v2026.626.0-58-g518fc71ce-dirty\n")).toBe(
      "2026.626.0+58.git.518fc71ce.dirty",
    );
  });

  it("returns null for unparseable describe output so callers can fall back", () => {
    expect(parseGitDescribeVersion("canary/v2026.706.0-canary.1")).toBeNull();
  });

  it("appends dirty suffix even when on-tag (zero commits since tag)", () => {
    expect(parseGitDescribeVersion("v2026.626.0-0-g012345678-dirty\n")).toBe(
      "2026.626.0+0.git.012345678.dirty",
    );
  });
});

describe("resolveServerVersion", () => {
  it("returns the parsed git-derived version when git describe succeeds", () => {
    expect(
      resolveServerVersion({
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => "v2026.626.0-58-g518fc71ce\n",
        debugLog: vi.fn(),
      }),
    ).toBe("2026.626.0+58.git.518fc71ce");
  });

  it("falls back to package version without throwing when git is unavailable", () => {
    const debugLog = vi.fn();

    expect(
      resolveServerVersion({
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => {
          throw new Error("fatal: not a git repository");
        },
        debugLog,
      }),
    ).toBe("2026.706.0");
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "git_describe_unavailable" }),
      "falling back to package version for server version",
    );
  });
});
