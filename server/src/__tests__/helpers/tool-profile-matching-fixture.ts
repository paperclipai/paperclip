import { randomUUID } from "node:crypto";
import { agents, companies, toolApplications, toolCatalogEntries, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";

export async function createToolProfileMatchingFixture(db: Db) {
  const [company] = await db.insert(companies).values({ name: "Synthetic profile matching", issuePrefix: `BM${randomUUID().slice(0, 6)}` }).returning();
  const companyAgents = await db.insert(agents).values(Array.from({ length: 12 }, (_, i) => ({ companyId: company.id, name: `Agent ${i}` }))).returning();
  const agent = companyAgents[0]!;
  const [app] = await db.insert(toolApplications).values({ companyId: company.id, name: "Synthetic app", type: "mcp_http" }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: app.id, name: "Synthetic connection", uid: randomUUID(), transport: "mcp_remote" }).returning();
  const catalog = await db.insert(toolCatalogEntries).values(Array.from({ length: 1890 }, (_, i) => ({ companyId: company.id, applicationId: app.id, connectionId: connection.id, name: `tool_${i}`, toolName: `tool_${i}`, versionHash: `v${i}`, riskLevel: "read" as const }))).returning();
  const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: "selected", name: "Selected tools", defaultAction: "deny" }).returning();
  await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
  await db.insert(toolProfileEntries).values(catalog.slice(0, 1575).map((entry, i) => ({ companyId: company.id, profileId: profile.id, selectorType: "catalog_entry" as const, catalogEntryId: entry.id, effect: i % 5 === 0 ? "exclude" as const : "include" as const })));
  return { company, agent };
}
