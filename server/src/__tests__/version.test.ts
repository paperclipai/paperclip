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

  it("keeps the package version when git describe output is unparseable", () => {
    expect(
      resolveServerVersion({
        buildCommit: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => "canary/v2026.706.0-canary.1",
        debugLog: vi.fn(),
      }),
    ).toBe("2026.706.0");
  });

  it("keeps the formal version for an exact release tag even when build metadata exists", () => {
    expect(
      resolveServerVersion({
        buildCommit: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => "v2026.706.0-0-g012345678\n",
        debugLog: vi.fn(),
      }),
    ).toBe("2026.706.0");
  });

  it("falls back to package version without throwing when git is unavailable", () => {
    const debugLog = vi.fn();
    const cause = new Error("spawn git ENOENT");
    const err = Object.assign(new Error("fatal: not a git repository"), {
      code: 128,
      stderr: Buffer.from("fatal: not a git repository\n"),
      stdout: "",
      cause,
    });

    expect(
      resolveServerVersion({
        buildCommit: null,
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => {
          throw err;
        },
        debugLog,
      }),
    ).toBe("2026.706.0");
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          cause: expect.objectContaining({ message: "spawn git ENOENT" }),
          code: 128,
          message: "fatal: not a git repository",
          stderr: "fatal: not a git repository\n",
          stdout: "",
          stack: expect.any(String),
        }),
        reason: "git_describe_unavailable",
      }),
      "falling back to package version for server version",
    );
  });

  it("uses deployment commit metadata when a source build has no git directory", () => {
    expect(
      resolveServerVersion({
        buildCommit: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.706.0",
        gitDescribeCommand: () => {
          throw new Error("fatal: not a git repository");
        },
        debugLog: vi.fn(),
      }),
    ).toBe("2026.706.0+0.git.0123456");
  });

  it("skips git metadata probing for packaged installs under node_modules", () => {
    const debugLog = vi.fn();

    expect(
      resolveServerVersion({
        buildCommit: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.707.0-canary.12",
        debugLog,
        packageRoot: "/tmp/npm/_npx/example/node_modules/@paperclipai/server",
      }),
    ).toBe("2026.707.0-canary.12");

    expect(debugLog).toHaveBeenCalledWith(
      { reason: "packaged_install" },
      "falling back to package version for server version",
    );
  });

  it("uses git metadata for source checkouts whose path contains node_modules", () => {
    const debugLog = vi.fn();
    const gitDescribeCommand = vi.fn(() => "v2026.626.0-58-g518fc71ce\n");

    expect(
      resolveServerVersion({
        buildCommit: null,
        packageVersion: "2026.707.0-canary.12",
        debugLog,
        gitDescribeCommand,
        packageRoot: "/tmp/node_modules/source/paperclip/server",
        pathExists: (path) => path === "/tmp/node_modules/source/paperclip/.git",
        realpath: (path) => path,
      }),
    ).toBe("2026.626.0+58.git.518fc71ce");

    expect(gitDescribeCommand).toHaveBeenCalledOnce();
    expect(debugLog).not.toHaveBeenCalled();
  });

  it("keeps fallback diagnostics quiet by default", () => {
    const previousDebugFlag = process.env.PAPERCLIP_DEBUG_VERSION_RESOLUTION;
    delete process.env.PAPERCLIP_DEBUG_VERSION_RESOLUTION;
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

    try {
      expect(
        resolveServerVersion({
          buildCommit: null,
          packageVersion: "2026.706.0",
          gitDescribeCommand: () => {
            throw new Error("fatal: not a git repository");
          },
        }),
      ).toBe("2026.706.0");

      expect(consoleDebug).not.toHaveBeenCalled();
    } finally {
      consoleDebug.mockRestore();
      if (previousDebugFlag === undefined) {
        delete process.env.PAPERCLIP_DEBUG_VERSION_RESOLUTION;
      } else {
        process.env.PAPERCLIP_DEBUG_VERSION_RESOLUTION = previousDebugFlag;
      }
    }
  });
});
