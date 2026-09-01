import { afterEach, describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  registerPluginRouteRoots,
  resetPluginRouteRoots,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  afterEach(() => {
    resetPluginRouteRoots();
  });

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

  it("rewrites company package paths with the active prefix", () => {
    expect(applyCompanyPrefix("/company/export", "NEU")).toBe("/NEU/company/export");
    expect(applyCompanyPrefix("/company/import", "NEU")).toBe("/NEU/company/import");
    expect(applyCompanyPrefix("/org", "NEU")).toBe("/NEU/org");
  });

  it("does not double-apply the company prefix", () => {
    expect(applyCompanyPrefix("/NEU/company/export", "NEU")).toBe("/NEU/company/export");
  });

  it("normalizes prefixed company export file URLs for parsing", () => {
    expect(toCompanyRelativePath("/NEU/company/export/files/agents/ceo/AGENTS.md")).toBe(
      "/company/export/files/agents/ceo/AGENTS.md",
    );
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

  it("treats /audit as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/audit")).toBe(true);
    expect(extractCompanyPrefixFromPath("/audit")).toBeNull();
    expect(applyCompanyPrefix("/audit", "PAP")).toBe("/PAP/audit");
    expect(toCompanyRelativePath("/PAP/audit")).toBe("/audit");
  });

  it("treats /tools routes as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/tools")).toBe(true);
    expect(isBoardPathWithoutPrefix("/tools/runtime")).toBe(true);
    expect(extractCompanyPrefixFromPath("/tools")).toBeNull();
    expect(applyCompanyPrefix("/tools", "PAP")).toBe("/PAP/tools");
    expect(applyCompanyPrefix("/tools/runtime", "PAP")).toBe("/PAP/tools/runtime");
    expect(applyCompanyPrefix("/PAP/tools/runtime", "PAP")).toBe("/PAP/tools/runtime");
    expect(toCompanyRelativePath("/PAP/tools/runtime")).toBe("/tools/runtime");
  });

  it("recognizes Decisions without retaining the legacy attention route", () => {
    expect(isBoardPathWithoutPrefix("/decisions")).toBe(true);
    expect(extractCompanyPrefixFromPath("/decisions")).toBeNull();
    expect(applyCompanyPrefix("/decisions", "PAP")).toBe("/PAP/decisions");

    expect(isBoardPathWithoutPrefix("/attention")).toBe(false);
    expect(extractCompanyPrefixFromPath("/attention")).toBe("ATTENTION");
  });

  it("treats /timeline as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/timeline")).toBe(true);
    expect(extractCompanyPrefixFromPath("/timeline")).toBeNull();
    expect(applyCompanyPrefix("/timeline", "PAP")).toBe("/PAP/timeline");
    expect(toCompanyRelativePath("/PAP/timeline")).toBe("/timeline");
  });

  it("treats Skill Studio create mode as an unprefixed board route", () => {
    expect(isBoardPathWithoutPrefix("/skills/studio/new")).toBe(true);
    expect(extractCompanyPrefixFromPath("/skills/studio/new")).toBeNull();
    expect(applyCompanyPrefix("/skills/studio/new?forkFrom=skill-1", "PAP")).toBe(
      "/PAP/skills/studio/new?forkFrom=skill-1",
    );
    expect(toCompanyRelativePath("/PAP/skills/studio/new?forkFrom=skill-1")).toBe(
      "/skills/studio/new?forkFrom=skill-1",
    );
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

  // Regression for #11670: a plugin page route root (e.g. the bundled LLM Wiki
  // plugin's "/wiki") is not in the build-time BOARD_ROUTE_ROOTS set, so
  // `toCompanyRelativePath("/PAP/wiki")` used to leave the company prefix in place.
  // Per-company page memory then stored "/PAP/wiki" and, on company switch, re-applied
  // the prefix, navigating to "/PAP/PAP/wiki". Registering the route at runtime makes
  // it strip like any board route.
  it("strips a registered plugin route root when normalizing to a company-relative path", () => {
    registerPluginRouteRoots(["wiki"]);
    expect(toCompanyRelativePath("/PAP/wiki")).toBe("/wiki");
    expect(toCompanyRelativePath("/PAP/wiki/spaces")).toBe("/wiki/spaces");
    expect(toCompanyRelativePath("/PAP/wiki?tab=all#top")).toBe("/wiki?tab=all#top");
  });

  it("does not strip an unregistered second segment", () => {
    // Over-broadening guard: only registered plugin roots (and board roots) strip.
    expect(toCompanyRelativePath("/PAP/definitely-not-a-route")).toBe(
      "/PAP/definitely-not-a-route",
    );
  });

  it("normalizes registered roots (leading slash, case, nested segment)", () => {
    registerPluginRouteRoots(["/Wiki/spaces", "  DEMO-PLUGIN  "]);
    expect(toCompanyRelativePath("/PAP/wiki")).toBe("/wiki");
    expect(toCompanyRelativePath("/PAP/demo-plugin")).toBe("/demo-plugin");
  });

  // Registering a plugin route root must NOT change company-prefix classification, so
  // a cross-company absolute link whose destination prefix collides with a registered
  // plugin root is left intact (not re-prefixed under the active company).
  it("preserves a cross-company link whose prefix collides with a registered plugin root", () => {
    registerPluginRouteRoots(["wiki"]);
    // "WIKI" here is another company's prefix, not the "wiki" plugin route.
    expect(extractCompanyPrefixFromPath("/WIKI/inbox")).toBe("WIKI");
    expect(applyCompanyPrefix("/WIKI/inbox", "PAP")).toBe("/WIKI/inbox");
    // A company-relative board route still gets the active prefix (unchanged behavior).
    expect(applyCompanyPrefix("/inbox", "PAP")).toBe("/PAP/inbox");
  });
});
