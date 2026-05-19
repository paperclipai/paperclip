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

  it("treats /agent-os as a top-level product route, not a board route or company prefix (LET-415)", () => {
    // LET-415: /agent-os is the standalone Enterprise Agent OS surface and
    // must render full-screen without the Paperclip board Layout chrome. The
    // route is global — not auto-prefixed by company and not treated as a
    // board sub-path.
    expect(isBoardPathWithoutPrefix("/agent-os")).toBe(false);
    expect(extractCompanyPrefixFromPath("/agent-os")).toBeNull();
    expect(extractCompanyPrefixFromPath("/agent-os/goals")).toBeNull();
    expect(applyCompanyPrefix("/agent-os", "PAP")).toBe("/agent-os");
    expect(applyCompanyPrefix("/goals", "AGENT-OS")).toBe("/AGENT-OS/goals");
  });

  it("treats /eaos as a top-level product route, not a board route or company prefix (LET-415)", () => {
    // LET-415: /eaos is the canonical full-screen Enterprise Agent OS shell.
    // It must NOT be auto-prefixed by company — outer chrome (sidebar,
    // breadcrumb, LET frame) does not wrap it, and shell links such as
    // `/eaos/approvals` must stay unprefixed regardless of the active company.
    expect(isBoardPathWithoutPrefix("/eaos")).toBe(false);
    expect(extractCompanyPrefixFromPath("/eaos")).toBeNull();
    expect(extractCompanyPrefixFromPath("/eaos/runtime")).toBeNull();
    expect(extractCompanyPrefixFromPath("/EAOS")).toBeNull();
    expect(applyCompanyPrefix("/eaos", "PAP")).toBe("/eaos");
    expect(applyCompanyPrefix("/eaos?tab=leases", "PAP")).toBe("/eaos?tab=leases");
  });

  it("keeps EAOS shell sub-paths global so the shell renders full-screen (LET-415)", () => {
    // LET-372 nav-zones live under /eaos/* — they must inherit the same
    // full-screen, unprefixed behavior as /eaos itself.
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
      expect(isBoardPathWithoutPrefix(sub)).toBe(false);
      expect(extractCompanyPrefixFromPath(sub)).toBeNull();
      expect(applyCompanyPrefix(sub, "PAP")).toBe(sub);
    }
  });
});
