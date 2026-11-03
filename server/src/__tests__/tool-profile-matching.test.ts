import { describe, expect, it } from "vitest";
import { profileCatalogMatcher, profileEntryMatchesCatalog, type ProfileCatalogMatch, type ProfileEntryMatch } from "../services/tool-access/profiles/projection.js";

describe("indexed profile catalog matching", () => {
  it("preserves all selector kinds, null matches and exact strings in mixed rule sets", () => {
    const catalog: ProfileCatalogMatch[] = Array.from({ length: 75 }, (_, index) => ({
      id: `tool-${index}`, applicationId: index % 3 ? `app-${index % 5}` : null,
      connectionId: `connection-${index % 7}`, toolName: index % 4 ? `tool-${index}` : "quoted' path\\tool_🙂",
      riskLevel: index % 2 ? "read" : "write",
    }));
    const selectors = ["application", "connection", "catalog_entry", "tool_name", "risk_level", "unknown"];
    const rules: ProfileEntryMatch[] = catalog.flatMap(entry => selectors.map(selectorType => ({
      selectorType, applicationId: entry.applicationId, connectionId: entry.connectionId,
      catalogEntryId: entry.id, toolName: entry.toolName, riskLevel: entry.riskLevel,
    })));
    for (const selected of [[], ...rules.map(rule => [rule]), rules.slice(0, 25), rules]) {
      const matches = profileCatalogMatcher(selected);
      expect(catalog.filter(matches)).toEqual(catalog.filter(entry => selected.some(rule => profileEntryMatchesCatalog(rule, entry))));
    }
  });
});
