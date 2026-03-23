import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  toCompanyRelativePath,
} from "./company-routes";

describe("company route helpers", () => {
  it("does not treat built-in board routes as company prefixes", () => {
    for (const pathname of [
      "/skills",
      "/routines",
      "/settings",
      "/onboarding",
      "/plugins/example",
      "/execution-workspaces/ws-1",
      "/tests/ux/runs",
    ]) {
      expect(extractCompanyPrefixFromPath(pathname)).toBeNull();
    }
  });

  it("applies the active company prefix to built-in board routes", () => {
    expect(applyCompanyPrefix("/skills", "BEA")).toBe("/BEA/skills");
    expect(applyCompanyPrefix("/routines", "BEA")).toBe("/BEA/routines");
    expect(applyCompanyPrefix("/execution-workspaces/ws-1", "BEA")).toBe("/BEA/execution-workspaces/ws-1");
  });

  it("normalizes prefixed board routes back to company-relative paths", () => {
    expect(toCompanyRelativePath("/BEA/skills")).toBe("/skills");
    expect(toCompanyRelativePath("/BEA/routines")).toBe("/routines");
    expect(toCompanyRelativePath("/BEA/plugins/example")).toBe("/plugins/example");
    expect(toCompanyRelativePath("/BEA/execution-workspaces/ws-1")).toBe("/execution-workspaces/ws-1");
    expect(toCompanyRelativePath("/BEA/tests/ux/runs")).toBe("/tests/ux/runs");
  });
});
