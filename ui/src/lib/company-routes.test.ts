import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isGlobalPath,
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
});

describe("board route roots stay in sync with the router", () => {
  // extractCompanyPrefixFromPath treats an unrecognised first segment as a
  // company prefix, so any company-scoped route missing from BOARD_ROUTE_ROOTS
  // silently stops being prefixed and 404s as an unknown company. This sweep
  // reads the routes actually registered in App.tsx, so adding a board route
  // without allowlisting it fails here instead of in someone's browser.
  const appSource = readFileSync(
    fileURLToPath(new URL("../App.tsx", import.meta.url)),
    "utf8",
  );
  // Match any `path="..."` attribute rather than only one that directly follows
  // `<Route`, so the sweep still covers a route whose attributes are reordered
  // or split across lines. A guard that silently stops covering a route is worse
  // than no guard, because it keeps passing while the drift it exists to catch
  // goes unnoticed.
  //
  // Nested paths ("company/settings", "agents/:id") contribute their first
  // segment, which is what the prefix logic keys on. Global routes (auth,
  // invite, instance, ...) are intentionally never prefixed and are excluded
  // rather than asserted on.
  const registeredRoots = Array.from(
    new Set(
      Array.from(appSource.matchAll(/path="([^"]+)"/g))
        .map((m) => m[1]!.split("/").filter(Boolean)[0])
        .filter((root): root is string => Boolean(root) && /^[a-z0-9-]+$/.test(root)),
    ),
  )
    .filter((root) => !isGlobalPath(`/${root}`))
    // Not company-scoped, so intentionally never prefixed:
    //   ux-lab  — registered only in the global tree, beside invite/cli-auth
    //   tests   — DEV-only, and also registered in the global tree
    //   dev     — DEV-only scaffolding (dev/task-chat-lab)
    // Listed explicitly rather than narrowing the regex, so an exclusion is
    // visible in review instead of hidden in a pattern.
    .filter((root) => !["ux-lab", "tests", "dev"].includes(root));

  it("finds routes to check", () => {
    expect(registeredRoots.length).toBeGreaterThan(20);
  });

  it.each(registeredRoots)("prefixes /%s", (root) => {
    expect(applyCompanyPrefix(`/${root}`, "PAP")).toBe(`/PAP/${root}`);
  });

  it("does not mistake a board route root for a company prefix", () => {
    for (const root of registeredRoots) {
      expect(extractCompanyPrefixFromPath(`/${root}`)).toBeNull();
    }
  });

  it("regression: audit and cases are prefixed (paperclipai/paperclip#10870)", () => {
    expect(applyCompanyPrefix("/audit", "PAP")).toBe("/PAP/audit");
    expect(applyCompanyPrefix("/cases", "PAP")).toBe("/PAP/cases");
    expect(applyCompanyPrefix("/cases/PAP-C5", "PAP")).toBe("/PAP/cases/PAP-C5");
  });

  it("still leaves an already-prefixed path alone", () => {
    expect(applyCompanyPrefix("/PAP/audit", "PAP")).toBe("/PAP/audit");
    expect(applyCompanyPrefix("/VER/cases", "PAP")).toBe("/VER/cases");
  });
});
