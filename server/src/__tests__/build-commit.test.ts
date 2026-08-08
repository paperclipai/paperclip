import { describe, expect, it, vi } from "vitest";
import { parseBuildCommit, readBuildCommit } from "../build-commit.js";

describe("parseBuildCommit", () => {
  it("normalizes a full deployment commit", () => {
    expect(parseBuildCommit("  ABCDEF0123456789ABCDEF0123456789ABCDEF01\n")).toBe(
      "abcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("rejects truncated and malformed commits", () => {
    expect(parseBuildCommit("abcdef0")).toBeNull();
    expect(parseBuildCommit("not-a-commit")).toBeNull();
  });
});

describe("readBuildCommit", () => {
  it("prefers an explicit environment commit", () => {
    const readTextFile = vi.fn(() => "ffffffffffffffffffffffffffffffffffffffff");

    expect(
      readBuildCommit({
        environmentCommit: "0123456789abcdef0123456789abcdef01234567",
        readTextFile,
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("reads the deployment marker when no environment commit is set", () => {
    expect(
      readBuildCommit({
        environmentCommit: null,
        buildCommitPath: "/app/.paperclip-build-commit",
        readTextFile: (path) => {
          expect(path).toBe("/app/.paperclip-build-commit");
          return "0123456789abcdef0123456789abcdef01234567\n";
        },
      }),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("uses the commit embedded in a git archive when no marker exists", () => {
    expect(
      readBuildCommit({
        environmentCommit: null,
        archiveCommit: "89abcdef0123456789abcdef0123456789abcdef",
        readTextFile: () => {
          throw new Error("missing deployment marker");
        },
      }),
    ).toBe("89abcdef0123456789abcdef0123456789abcdef");
  });

  it("ignores the unsubstituted git archive placeholder", () => {
    expect(
      readBuildCommit({
        environmentCommit: null,
        archiveCommit: "$Format:%H$",
        readTextFile: () => {
          throw new Error("missing deployment marker");
        },
      }),
    ).toBeNull();
  });
});
