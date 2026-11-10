import { randomUUID } from "node:crypto";
import { agents, companies, toolApplications, toolCatalogEntries, toolConnections, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";

export async function createProfileProjectionFixture(db: Db, options: { profiles?: number; tools?: number; rules?: number } = {}) {
  const profileCount = options.profiles ?? 200, toolCount = options.tools ?? 1900, ruleCount = options.rules ?? 380, maxRuleCount = options.rules ?? 695;
  const [company] = await db.insert(companies).values({ name: "Profile projection fixture", issuePrefix: `PP${randomUUID().slice(0, 6)}` }).returning();
  await db.insert(agents).values(Array.from({ length: 12 }, (_, i) => ({ companyId: company.id, name: `Agent ${i}` })));
  const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Projection application", type: "mcp_http" }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Projection connection", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok" }).returning();
  const catalog = await db.insert(toolCatalogEntries).values(Array.from({ length: toolCount + maxRuleCount }, (_, i) => ({
    companyId: company.id, applicationId: application.id, connectionId: connection.id,
    name: `tool_${i}`, toolName: `tool_${i}`, versionHash: `v${i}`, riskLevel: "read" as const,
    status: i < toolCount ? "active" as const : "removed" as const,
    firstSeenAt: new Date(i < toolCount ? "2026-01-03T00:00:00Z" : "2026-01-01T00:00:00Z"),
  }))).returning();
  const profiles = await db.insert(toolProfiles).values(Array.from({ length: profileCount }, (_, i) => ({
    companyId: company.id, profileKey: `selected-${i}`, name: `Selected profile ${i}`, defaultAction: "deny" as const,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  }))).returning();
  for (let i = 0; i < profiles.length; i++) {
    const count = i % 4 < 2 ? maxRuleCount : 2 * ruleCount - maxRuleCount;
    const rules = (i % 2 ? catalog.slice(toolCount, toolCount + count) : catalog.slice(0, count)).map(entry => ({
      companyId: company.id, profileId: profiles[i]!.id, selectorType: "catalog_entry" as const,
      effect: "include" as const, catalogEntryId: entry.id,
    }));
    for (let offset = 0; offset < rules.length; offset += 500) await db.insert(toolProfileEntries).values(rules.slice(offset, offset + 500));
  }
  return { company, application, connection, catalog: catalog.slice(0, toolCount), profiles };
}
