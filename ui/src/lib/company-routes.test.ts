import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/routines")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/routines", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/routines",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/routines")).toBe(
      "/execution-workspaces/workspace-123/routines",
    );
  });

  it("treats /search as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/search")).toBe(true);
    expect(extractCompanyPrefixFromPath("/search")).toBeNull();
    expect(applyCompanyPrefix("/search", "PAP")).toBe("/PAP/search");
    expect(applyCompanyPrefix("/search?q=hello%20world", "PAP")).toBe("/PAP/search?q=hello%20world");
    expect(toCompanyRelativePath("/PAP/search?q=foo")).toBe("/search?q=foo");
  });

  // Regression for PAP-10257: Team Catalog navigation (auto-select + row/file
  // clicks) produces company-relative `/teams-catalog/<key>` paths. Without
  // `teams-catalog` in the board-route allowlist, `extractCompanyPrefixFromPath`
  // misread the first segment as a company prefix and `useNavigate` skipped the
  // rewrite, dropping the `/PAP/` prefix and crashing into "Company not found".
  it("re-prefixes team catalog routes so navigate preserves the company prefix", () => {
    expect(isBoardPathWithoutPrefix("/teams")).toBe(false);
    expect(isBoardPathWithoutPrefix("/teams-catalog")).toBe(true);
    expect(isBoardPathWithoutPrefix("/teams-catalog/core-exec-team")).toBe(true);
    expect(extractCompanyPrefixFromPath("/teams-catalog/core-exec-team")).toBeNull();

    // Auto-select effect: `/teams-catalog/<first-key>` must gain the `/PAP/` prefix.
    expect(applyCompanyPrefix("/teams-catalog/core-exec-team", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team",
    );
    // File-tree click: nested `/files/<encoded>` path is preserved under the prefix.
    expect(applyCompanyPrefix("/teams-catalog/core-exec-team/files/TEAM.md", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team/files/TEAM.md",
    );
    // Already-prefixed paths are left untouched (idempotent — no double prefix).
    expect(applyCompanyPrefix("/PAP/teams-catalog/core-exec-team", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team",
    );
    // Round-trips back to a company-relative path.
    expect(toCompanyRelativePath("/PAP/teams-catalog/core-exec-team")).toBe(
      "/teams-catalog/core-exec-team",
    );
  });

  it("treats /artifacts as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/artifacts")).toBe(true);
    expect(extractCompanyPrefixFromPath("/artifacts")).toBeNull();
    expect(applyCompanyPrefix("/artifacts", "PAP")).toBe("/PAP/artifacts");
    expect(toCompanyRelativePath("/PAP/artifacts")).toBe("/artifacts");
  });

  // Regression: a company whose issue prefix collides with a reserved board
  // route root (e.g. "ORG" shadows the `org` org-chart route) was double
  // prefixed. `App.tsx` redirects to `/ORG/dashboard`; `extractCompanyPrefixFromPath`
  // reported no prefix (first segment "org" is a board root), so `applyCompanyPrefix`
  // re-prepended the prefix and produced `/ORG/ORG/dashboard` → "Page not found".
  it("does not double-prefix paths for a company whose prefix shadows a route root", () => {
    // Already-prefixed board paths are left untouched (the bug).
    expect(applyCompanyPrefix("/ORG/dashboard", "ORG")).toBe("/ORG/dashboard");
    expect(applyCompanyPrefix("/ORG/board-chat", "ORG")).toBe("/ORG/board-chat");
    expect(applyCompanyPrefix("/org/dashboard", "ORG")).toBe("/org/dashboard");
    // Company-relative paths still get the prefix applied.
    expect(applyCompanyPrefix("/dashboard", "ORG")).toBe("/ORG/dashboard");
    // The bare org-chart route is company-relative and must still be prefixed.
    expect(applyCompanyPrefix("/org", "ORG")).toBe("/ORG/org");
    // Idempotent once prefixed: no triple prefix on the org-chart route.
    expect(applyCompanyPrefix("/ORG/org", "ORG")).toBe("/ORG/org");
  });

  it("preserves artifact deep-link anchors when applying the company prefix", () => {
    expect(applyCompanyPrefix("/issues/PAP-10205#work-product-wp-1", "PAP")).toBe(
      "/PAP/issues/PAP-10205#work-product-wp-1",
    );
    expect(applyCompanyPrefix("/issues/PAP-10306#attachment-att-1", "PAP")).toBe(
      "/PAP/issues/PAP-10306#attachment-att-1",
    );
    // Already-prefixed paths are returned untouched.
    expect(applyCompanyPrefix("/PAP/artifacts", "PAP")).toBe("/PAP/artifacts");
  });
});
