// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// resolveWorkspaceTab logic
//
// Tests the tab-resolution logic extracted from WorkspaceDetail.tsx.
// The function determines the active tab based on the URL pathname's last
// path segment. If it's "git", the git tab is active; otherwise overview.
// ---------------------------------------------------------------------------

type WorkspaceTab = "overview" | "git";

function resolveWorkspaceTab(pathname: string): WorkspaceTab {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "git") return "git";
  return "overview";
}

describe("resolveWorkspaceTab", () => {
  describe("overview tab", () => {
    it("returns overview for the bare workspace URL", () => {
      expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1")).toBe("overview");
    });

    it("returns overview for the overview sub-path", () => {
      expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/overview")).toBe("overview");
    });

    it("returns overview for unknown sub-paths", () => {
      expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/files")).toBe("overview");
    });

    it("returns overview when pathname is the workspace ID itself (last segment is not 'git')", () => {
      expect(resolveWorkspaceTab("/projects/proj-1/workspaces/my-workspace-id")).toBe("overview");
    });

    it("returns overview for an empty pathname", () => {
      expect(resolveWorkspaceTab("")).toBe("overview");
    });

    it("returns overview for a root slash only", () => {
      expect(resolveWorkspaceTab("/")).toBe("overview");
    });
  });

  describe("git tab", () => {
    it("returns git when the last segment is 'git'", () => {
      expect(resolveWorkspaceTab("/projects/proj-1/workspaces/ws-1/git")).toBe("git");
    });

    it("returns git with a company-prefix route", () => {
      expect(resolveWorkspaceTab("/ACME/projects/proj-1/workspaces/ws-1/git")).toBe("git");
    });

    it("returns git even for deeply nested paths ending in git", () => {
      expect(resolveWorkspaceTab("/a/b/c/d/e/git")).toBe("git");
    });

    it("does NOT return git when 'git' appears in the middle of the path", () => {
      // e.g. a workspace ID that contains git in its name is not a false positive
      expect(resolveWorkspaceTab("/projects/git-project/workspaces/ws-1")).toBe("overview");
    });
  });
});

// ---------------------------------------------------------------------------
// handleTabChange URL construction logic
//
// Tests the URL suffix table used in WorkspaceDetail to navigate between tabs.
// ---------------------------------------------------------------------------

describe("workspace tab URL construction", () => {
  const PROJECT_ID = "proj-abc";
  const WORKSPACE_ID = "ws-xyz";
  const base = `/projects/${PROJECT_ID}/workspaces/${WORKSPACE_ID}`;
  const suffix: Record<WorkspaceTab, string> = { overview: "", git: "/git" };

  it("produces the base workspace URL for the overview tab", () => {
    const url = `${base}${suffix["overview"]}`;
    expect(url).toBe("/projects/proj-abc/workspaces/ws-xyz");
  });

  it("produces a /git-suffixed URL for the git tab", () => {
    const url = `${base}${suffix["git"]}`;
    expect(url).toBe("/projects/proj-abc/workspaces/ws-xyz/git");
  });

  it("round-trips: overview URL resolves back to overview tab", () => {
    const url = `${base}${suffix["overview"]}`;
    expect(resolveWorkspaceTab(url)).toBe("overview");
  });

  it("round-trips: git URL resolves back to git tab", () => {
    const url = `${base}${suffix["git"]}`;
    expect(resolveWorkspaceTab(url)).toBe("git");
  });
});
