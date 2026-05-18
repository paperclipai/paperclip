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

  it("treats /observability as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/observability")).toBe(true);
    expect(extractCompanyPrefixFromPath("/observability")).toBeNull();
    expect(applyCompanyPrefix("/observability", "PAP")).toBe("/PAP/observability");
    expect(toCompanyRelativePath("/PAP/observability")).toBe("/observability");
  });

  it("treats /agent-os as a board route, not as a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/agent-os")).toBe(true);
    expect(extractCompanyPrefixFromPath("/agent-os")).toBeNull();
    expect(extractCompanyPrefixFromPath("/agent-os/goals")).toBeNull();
    expect(applyCompanyPrefix("/agent-os", "PAP")).toBe("/PAP/agent-os");
    expect(applyCompanyPrefix("/goals", "AGENT-OS")).toBe("/AGENT-OS/goals");
    expect(toCompanyRelativePath("/PAP/agent-os")).toBe("/agent-os");
  });

  it("treats /eaos as a board route, not as a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/eaos")).toBe(true);
    expect(extractCompanyPrefixFromPath("/eaos")).toBeNull();
    expect(extractCompanyPrefixFromPath("/eaos/runtime")).toBeNull();
    expect(extractCompanyPrefixFromPath("/EAOS")).toBeNull();
    expect(applyCompanyPrefix("/eaos", "PAP")).toBe("/PAP/eaos");
    expect(applyCompanyPrefix("/eaos?tab=leases", "PAP")).toBe("/PAP/eaos?tab=leases");
    expect(applyCompanyPrefix("/PAP/eaos", "PAP")).toBe("/PAP/eaos");
    expect(toCompanyRelativePath("/PAP/eaos")).toBe("/eaos");
    expect(toCompanyRelativePath("/PAP/eaos?tab=leases")).toBe("/eaos?tab=leases");
  });

  it("treats LET-372 /eaos shell sub-routes as board paths under the active company prefix", () => {
    // Canonical shell zones (LET-181/LET-334 nav-zones) must keep working
    // as board sub-paths so /<companyPrefix>/eaos/sandbox etc. resolve into
    // the EaosShell child <Outlet/> instead of being treated as a company
    // prefix.
    for (const sub of [
      "/eaos/sandbox",
      "/eaos/projects",
      "/eaos/missions",
      "/eaos/agents",
      "/eaos/runs",
      "/eaos/approvals",
      "/eaos/capabilities",
      "/eaos/knowledge",
      "/eaos/admin",
    ]) {
      expect(isBoardPathWithoutPrefix(sub)).toBe(true);
      expect(extractCompanyPrefixFromPath(sub)).toBeNull();
      expect(applyCompanyPrefix(sub, "PAP")).toBe(`/PAP${sub}`);
      expect(toCompanyRelativePath(`/PAP${sub}`)).toBe(sub);
    }
  });
});
