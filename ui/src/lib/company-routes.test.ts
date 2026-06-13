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

  it("strips known company prefixes from plugin-contributed routes", () => {
    // Plugin pages are not in BOARD_ROUTE_ROOTS — the second-segment check
    // left the prefix in place, so remembered paths accumulated a new prefix
    // on every company switch.
    const known = ["ACME", "BETA"];
    expect(toCompanyRelativePath("/ACME/my-plugin", known)).toBe("/my-plugin");
    expect(toCompanyRelativePath("/ACME/my-plugin/sub?tab=x", known)).toBe("/my-plugin/sub?tab=x");
  });

  it("self-heals remembered paths corrupted by prefix accumulation", () => {
    const known = ["ACME", "BETA"];
    expect(toCompanyRelativePath("/BETA/ACME/my-plugin", known)).toBe("/my-plugin");
    expect(toCompanyRelativePath("/ACME/BETA/ACME/my-plugin", known)).toBe("/my-plugin");
  });

  it("never strips plugin roots that are not known prefixes", () => {
    expect(toCompanyRelativePath("/ACME/my-plugin/sub", ["ACME"])).toBe("/my-plugin/sub");
    expect(toCompanyRelativePath("/my-plugin/sub", ["ACME"])).toBe("/my-plugin/sub");
  });

  it("leaves global and unprefixed board paths untouched (with and without known prefixes)", () => {
    expect(toCompanyRelativePath("/docs/getting-started", ["ACME"])).toBe("/docs/getting-started");
    expect(toCompanyRelativePath("/issues/ABC-1", ["ACME"])).toBe("/issues/ABC-1");
    expect(toCompanyRelativePath("/dashboard", ["ACME"])).toBe("/dashboard");
    expect(toCompanyRelativePath("/PAP/issues/PAP-1")).toBe("/issues/PAP-1");
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
