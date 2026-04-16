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
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/issues")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/issues", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/issues",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/configuration")).toBe(
      "/execution-workspaces/workspace-123/configuration",
    );
  });

  /**
   * Regression tests for https://github.com/paperclipai/paperclip/issues/2910
   *
   * The Export and Import links on the Company Settings page used plain
   * `<a href="/company/export">` anchors which bypass the router's Link
   * wrapper. Without the wrapper, the company prefix is never applied and
   * the links resolve to `/company/export` instead of `/:prefix/company/export`,
   * producing a "Company not found" error.
   *
   * The fix replaces the `<a>` elements with the prefix-aware `<Link>` from
   * `@/lib/router`. These tests assert that the underlying `applyCompanyPrefix`
   * utility (used by that Link) correctly rewrites the export/import paths.
   */
  it("applies company prefix to /company/export", () => {
    expect(applyCompanyPrefix("/company/export", "PAP")).toBe("/PAP/company/export");
  });

  it("applies company prefix to /company/import", () => {
    expect(applyCompanyPrefix("/company/import", "PAP")).toBe("/PAP/company/import");
  });

  it("does not double-apply the prefix if already present", () => {
    expect(applyCompanyPrefix("/PAP/company/export", "PAP")).toBe("/PAP/company/export");
  });
});
