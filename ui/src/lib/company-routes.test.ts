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

  /**
   * Regression test for https://github.com/paperclipai/paperclip/issues/3264
   *
   * Plugin page routes (e.g. youtube-trends) are not in BOARD_ROUTE_ROOTS.
   * toCompanyRelativePath must still strip the company prefix from these
   * paths so that company-switch navigation does not double the prefix.
   */
  it("strips company prefix from plugin page routes", () => {
    expect(toCompanyRelativePath("/ACM/youtube-trends")).toBe("/youtube-trends");
    expect(toCompanyRelativePath("/HAR/youtube-insights")).toBe("/youtube-insights");
    expect(toCompanyRelativePath("/PAP/my-custom-plugin-page")).toBe("/my-custom-plugin-page");
  });

  it("still strips company prefix from board routes", () => {
    expect(toCompanyRelativePath("/PAP/dashboard")).toBe("/dashboard");
    expect(toCompanyRelativePath("/PAP/issues")).toBe("/issues");
    expect(toCompanyRelativePath("/PAP/routines")).toBe("/routines");
  });

  it("does not strip global route roots", () => {
    expect(toCompanyRelativePath("/auth/login")).toBe("/auth/login");
    expect(toCompanyRelativePath("/docs/guide")).toBe("/docs/guide");
  });
});
