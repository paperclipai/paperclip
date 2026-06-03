import { describe, expect, it } from "vitest";
import { catalogManifest, catalogTeams, resolveCatalogTeamRef } from "./index.js";
import type { CatalogTeam } from "./types.js";

const EXPECTED_BUNDLED_KEYS = [
  "paperclipai/bundled/company-defaults/core-exec-team",
  "paperclipai/bundled/product/product-design",
  "paperclipai/bundled/software-development/product-engineering",
];

const EXPECTED_OPTIONAL_KEYS = [
  "paperclipai/optional/content/content-machine",
];

describe("shipped teams catalog", () => {
  it("ships the expected bundled and optional team fixtures", () => {
    const bundledKeys = catalogTeams
      .filter((team) => team.kind === "bundled")
      .map((team) => team.key)
      .sort();
    const optionalKeys = catalogTeams
      .filter((team) => team.kind === "optional")
      .map((team) => team.key)
      .sort();

    expect(bundledKeys).toEqual(EXPECTED_BUNDLED_KEYS);
    expect(optionalKeys).toEqual(EXPECTED_OPTIONAL_KEYS);
  });

  it("keeps every shipped team free of executable scripts and external sources in Phase B", () => {
    const risky = catalogTeams.filter(
      (team) => team.trustLevel === "scripts_executables" || team.trustLevel === "external_sources",
    );
    expect(risky, formatViolations("script-bearing or external-source teams require later security review", risky)).toEqual([]);
  });

  it("populates browse/search-relevant fields for every shipped team", () => {
    const issues: string[] = [];
    for (const team of catalogTeams) {
      if (team.compatibility !== "compatible") {
        issues.push(`${team.key} compatibility=${team.compatibility}`);
      }
      if (!team.description || team.description.length < 40) {
        issues.push(`${team.key} description must be at least 40 characters for catalog browse/search`);
      }
      if (team.recommendedForCompanyTypes.length === 0) {
        issues.push(`${team.key} must list recommendedForCompanyTypes`);
      }
      if (team.tags.length === 0) {
        issues.push(`${team.key} must list tags`);
      }
      if (team.rootAgentSlugs.length === 0) {
        issues.push(`${team.key} must list a root agent slug`);
      }
    }
    expect(issues).toEqual([]);
  });

  it("uses canonical paperclipai keys derived from kind/category/slug", () => {
    const violations: string[] = [];
    for (const team of catalogTeams) {
      const expectedKey = `paperclipai/${team.kind}/${team.category}/${team.slug}`;
      const expectedId = `paperclipai:${team.kind}:${team.category}:${team.slug}`;
      if (team.key !== expectedKey) violations.push(`${team.key} should be ${expectedKey}`);
      if (team.id !== expectedId) violations.push(`${team.id} should be ${expectedId}`);
    }
    expect(violations).toEqual([]);
  });

  it("exposes a stable manifest header for downstream consumers", () => {
    expect(catalogManifest.schemaVersion).toBe(1);
    expect(catalogManifest.packageName).toBe("@paperclipai/teams-catalog");
    expect(catalogTeams.length).toBe(EXPECTED_BUNDLED_KEYS.length + EXPECTED_OPTIONAL_KEYS.length);
  });

  it("resolves shipped teams by id, key, and unique slug", () => {
    const sample = catalogTeams.find((team) => team.key === "paperclipai/bundled/company-defaults/core-exec-team");
    expect(sample, "expected core-exec-team to ship in the bundled catalog").toBeDefined();
    if (!sample) return;

    expect(resolveCatalogTeamRef(sample.id)).toMatchObject({ key: sample.key });
    expect(resolveCatalogTeamRef(sample.key)).toMatchObject({ key: sample.key });
    expect(resolveCatalogTeamRef(sample.slug)).toMatchObject({ key: sample.key });
  });
});

function formatViolations(label: string, teams: CatalogTeam[]) {
  if (teams.length === 0) return label;
  const detail = teams.map((team) => `${team.key} (${team.trustLevel})`).join(", ");
  return `${label}: ${detail}`;
}
