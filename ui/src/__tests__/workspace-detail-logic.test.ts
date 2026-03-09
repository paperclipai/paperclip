// @vitest-environment node
//
// Unit tests for pure utility functions in WorkspaceDetail.tsx.
//
// WorkspaceDetail.tsx contains two testable pure functions:
//
//   • resolveWorkspaceTab(pathname)  – derive active tab from URL pathname
//   • pathSegments(filePath)         – breadcrumb construction from file path
//
// pathSegments logic is already covered in file-tree-logic.test.ts (because the
// same split/filter pattern is used in FileTree and WorkspaceDetail). This file
// focuses on resolveWorkspaceTab which is specific to WorkspaceDetail.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// resolveWorkspaceTab — mirrored from WorkspaceDetail.tsx
// ---------------------------------------------------------------------------

type WorkspaceTab = "overview" | "git";

function resolveWorkspaceTab(pathname: string): WorkspaceTab {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "git") return "git";
  return "overview";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveWorkspaceTab", () => {
  // --- Overview tab ---

  it("returns overview for the workspace root URL", () => {
    expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1")).toBe(
      "overview",
    );
  });

  it("returns overview for a URL with a trailing slash", () => {
    expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/")).toBe(
      "overview",
    );
  });

  it("returns overview when the last segment is the workspace ID", () => {
    // The workspace ID is a UUID — not 'git', so overview wins.
    expect(
      resolveWorkspaceTab(
        "/projects/abc/workspaces/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("overview");
  });

  it("returns overview for an empty pathname", () => {
    // Edge case: no segments → segments[segments.length - 1] is undefined
    // undefined === 'git' is false → falls through to 'overview'
    expect(resolveWorkspaceTab("")).toBe("overview");
  });

  it("returns overview for the root pathname '/'", () => {
    expect(resolveWorkspaceTab("/")).toBe("overview");
  });

  it("returns overview when the last segment is a non-tab keyword", () => {
    expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/files")).toBe(
      "overview",
    );
    expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/overview")).toBe(
      "overview",
    );
    expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/settings")).toBe(
      "overview",
    );
  });

  it("returns overview (not git) when 'git' appears in a non-final segment", () => {
    // 'git' appears as a directory name, not the last segment
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/git/ws-1"),
    ).toBe("overview");
  });

  // --- Git tab ---

  it("returns git for the /git sub-path", () => {
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/git"),
    ).toBe("git");
  });

  it("returns git even with a trailing slash after /git", () => {
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/git/"),
    ).toBe("git");
  });

  it("is case-sensitive: 'Git' (capital G) is not recognised as the git tab", () => {
    // The check is strict string equality: last === 'git'
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/Git"),
    ).toBe("overview");
  });

  it("is case-sensitive: 'GIT' is not recognised as the git tab", () => {
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/GIT"),
    ).toBe("overview");
  });

  // --- Segment-based check guarantees ---

  it("uses the LAST path segment (not a substring match)", () => {
    // A workspace ID that happens to contain 'git' in the middle should be 'overview'
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/git-abc123"),
    ).toBe("overview"); // last segment is 'git-abc123', not 'git'
  });

  it("does not match partial segment 'gitX'", () => {
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/gitx"),
    ).toBe("overview");
  });

  it("does not match partial segment 'xgit'", () => {
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/xgit"),
    ).toBe("overview");
  });

  // --- Realistic routing scenarios ---

  it("handles a companyPrefix-prefixed URL for overview tab", () => {
    expect(
      resolveWorkspaceTab("/acme/projects/proj-1/workspaces/ws-1"),
    ).toBe("overview");
  });

  it("handles a companyPrefix-prefixed URL for git tab", () => {
    expect(
      resolveWorkspaceTab("/acme/projects/proj-1/workspaces/ws-1/git"),
    ).toBe("git");
  });

  it("handles query strings being stripped before passing (pathname only)", () => {
    // In practice, pathname from useLocation() does not contain query strings.
    // But defensively test a URL-like string with ? — it goes to overview since
    // the last slash-delimited segment would be 'ws-1?foo=bar'.
    expect(
      resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1?tab=git"),
    ).toBe("overview"); // '?' is not a path separator
  });

  // --- Return type exhaustiveness ---

  it("always returns one of the two valid tab values", () => {
    const validTabs: WorkspaceTab[] = ["overview", "git"];
    const testPaths = [
      "/projects/p/workspaces/w",
      "/projects/p/workspaces/w/git",
      "/projects/p/workspaces/w/unknown",
      "",
      "/",
    ];
    for (const path of testPaths) {
      expect(validTabs).toContain(resolveWorkspaceTab(path));
    }
  });
});

// ---------------------------------------------------------------------------
// pathSegments — breadcrumb construction (mirrored from WorkspaceDetail.tsx)
// These are included here as a short regression guard; comprehensive coverage
// lives in file-tree-logic.test.ts.
// ---------------------------------------------------------------------------

function pathSegments(filePath: string | null): string[] {
  if (!filePath) return [];
  return filePath.split("/").filter(Boolean);
}

describe("pathSegments (WorkspaceDetail breadcrumb helper)", () => {
  it("returns empty array for null", () => {
    expect(pathSegments(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(pathSegments("")).toEqual([]);
  });

  it("returns single-element array for root-level file", () => {
    expect(pathSegments("index.ts")).toEqual(["index.ts"]);
  });

  it("splits nested path into breadcrumb segments", () => {
    expect(pathSegments("src/components/Button.tsx")).toEqual([
      "src",
      "components",
      "Button.tsx",
    ]);
  });

  it("the last segment is the file name", () => {
    const segs = pathSegments("a/b/c/file.json");
    expect(segs[segs.length - 1]).toBe("file.json");
  });

  it("filters out empty segments from paths with leading slashes", () => {
    expect(pathSegments("/src/index.ts")).toEqual(["src", "index.ts"]);
  });
});
