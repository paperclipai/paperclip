import { describe, expect, it } from "vitest";
import { pendingNewToolsForProfile, profileCoversCatalogScope, profileEntryMatchesCatalog, type ProfileCatalogEntry } from "../services/tool-access/profiles/projection.js";
import type { toolProfiles, toolProfileEntries } from "@paperclipai/db";

type Input = Parameters<typeof pendingNewToolsForProfile>[0];
const date = new Date("2026-01-01T00:00:00Z");
const later = new Date("2026-01-02T00:00:00Z");
function profile(overrides: Partial<typeof toolProfiles.$inferSelect> = {}): typeof toolProfiles.$inferSelect {
  return { id: "profile", companyId: "company", profileKey: "selected", name: "Selected", description: null, status: "active", defaultAction: "deny", newToolsReviewedAt: null, metadata: {}, createdAt: date, updatedAt: date, ...overrides };
}
function rule(overrides: Partial<typeof toolProfileEntries.$inferSelect>): typeof toolProfileEntries.$inferSelect {
  return { id: "rule", companyId: "company", profileId: "profile", selectorType: "catalog_entry", effect: "include", applicationId: null, connectionId: null, catalogEntryId: null, toolName: null, riskLevel: null, conditions: null, createdAt: date, updatedAt: date, ...overrides };
}
function legacy(input: Input) {
  if (input.profile.status !== "active" || input.profile.defaultAction !== "deny") return [];
  const catalogById = new Map(input.catalog.map(entry => [entry.id, entry]));
  return input.catalog.filter(entry => (entry.status === "active" || entry.status === "quarantined")
    && entry.firstSeenAt > (input.profile.newToolsReviewedAt ?? input.profile.createdAt)
    && input.entries.some(rule => profileCoversCatalogScope({ entry: rule, catalogEntry: entry, catalogById }))
    && !input.entries.some(rule => profileEntryMatchesCatalog(rule, entry))).map(entry => ({
      catalogEntryId: entry.id, applicationId: entry.applicationId,
      applicationName: entry.applicationId ? input.applicationsById?.get(entry.applicationId)?.name ?? null : null,
      connectionId: entry.connectionId, connectionName: input.connectionsById?.get(entry.connectionId)?.name ?? null,
      toolName: entry.toolName, title: entry.title ?? null, description: entry.description ?? null,
      capability: entry.riskLevel, riskLevel: entry.riskLevel, addedAt: entry.firstSeenAt, firstSeenAt: entry.firstSeenAt,
    }));
}
const catalog: ProfileCatalogEntry[] = Array.from({ length: 48 }, (_, i): ProfileCatalogEntry => ({
  id: `tool-${i}`, applicationId: i % 3 ? `app-${i % 4}` : null,
  connectionId: `connection-${i % 6}`, toolName: i % 7 ? `name-${i}` : "quoted' path\\tool_🙂",
  riskLevel: i % 2 ? "read" : "write", status: i % 5 ? "active" : "quarantined",
  firstSeenAt: i % 11 ? later : date,
}));

describe("pending profile projection", () => {
  it("matches the previous ordered projection for every selector, effect, watermark and nullable scope", () => {
    const rules = catalog.flatMap(entry => (["include", "exclude"] as const).flatMap(effect => [
      rule({ effect, selectorType: "application", applicationId: entry.applicationId }),
      rule({ effect, selectorType: "connection", connectionId: entry.connectionId }),
      rule({ effect, selectorType: "catalog_entry", catalogEntryId: entry.id }),
      rule({ effect, selectorType: "tool_name", toolName: entry.toolName }),
      rule({ effect, selectorType: "risk_level", riskLevel: entry.riskLevel }),
    ]));
    const scopes = [rule({ selectorType: "application", applicationId: null }), rule({ selectorType: "connection", connectionId: "connection-1" }), rule({ catalogEntryId: "tool-2" }), rule({ catalogEntryId: "missing" })];
    for (const scope of scopes) for (const selected of [[], ...rules.map(entry => [entry]), rules.slice(0, 50), rules]) {
      const input = { profile: profile(), catalog, entries: [scope, ...selected], applicationsById: new Map([["app-1", { id: "app-1", name: "Application" }]]), connectionsById: new Map([["connection-1", { id: "connection-1", name: "Connection" }]]) };
      expect(pendingNewToolsForProfile(input)).toEqual(legacy(input));
    }
    for (const changes of [{ status: "archived" as const }, { defaultAction: "allow" as const }, { newToolsReviewedAt: later }]) {
      const input = { profile: profile(changes), catalog, entries: scopes };
      expect(pendingNewToolsForProfile(input)).toEqual(legacy(input));
    }
  });

  it("does not broaden an individual tool's null application scope to unrelated null applications", () => {
    const input = { profile: profile(), entries: [rule({ catalogEntryId: "tool-0" })], catalog };
    const ids = pendingNewToolsForProfile(input).map(entry => entry.catalogEntryId);
    expect(ids).toContain("tool-6");
    expect(ids).not.toContain("tool-3");
    expect(pendingNewToolsForProfile(input)).toEqual(legacy(input));
  });

  it("recomputes catalog references, exclusions and scope after the input changes", () => {
    const input = { profile: profile(), entries: [rule({ catalogEntryId: "tool-2" })], catalog };
    expect(pendingNewToolsForProfile(input).length).toBeGreaterThan(0);
    expect(pendingNewToolsForProfile({ ...input, catalog: catalog.filter(entry => entry.id !== "tool-2") })).toEqual([]);
    expect(pendingNewToolsForProfile({ ...input, entries: [rule({ catalogEntryId: "tool-2", effect: "exclude" })] })).toEqual([]);
  });
});
