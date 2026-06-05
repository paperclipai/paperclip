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
});
