import { randomUUID } from "node:crypto";
import { toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { createProfileProjectionFixture } from "./tool-profile-projection-fixture.js";

export async function createConnectionReviewCountsFixture(db: Db, large = false) {
  const f = await createProfileProjectionFixture(db, large ? {} : { profiles: 4, tools: 12, rules: 4 });
  const [sibling] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: f.application.id, name: "Sibling", uid: randomUUID(), transport: "mcp_remote", status: "active", healthStatus: "error" }).returning();
  await db.insert(toolCatalogEntries).values([f.connection, sibling].flatMap(connection => Array.from({ length: 3 }, (_, i) => ({ companyId: f.company.id, connectionId: connection.id, name: `quarantine_${i}`, toolName: `quarantine_${i}`, versionHash: "v1", status: "quarantined" as const }))));
  const [invocation, siblingInvocation, nullInvocation] = await db.insert(toolInvocations).values([f.connection.id, sibling.id, null].map(connectionId => ({ companyId: f.company.id, connectionId, toolName: "review_me" }))).returning();
  const request = (invocationId: string, signedArguments: string | null, status: "pending" | "rejected" = "pending") => ({ companyId: f.company.id, invocationId, signedArguments, status, canonicalArgumentsHash: "hash", canonicalArgumentsSummary: { summary: "Synthetic review request" } });
  const requests = await db.insert(toolActionRequests).values([
    request(invocation.id, "signed"), request(invocation.id, ""), request(invocation.id, null), request(invocation.id, "signed", "rejected"),
    request(siblingInvocation.id, "signed"), request(nullInvocation.id, "signed"),
  ]).returning();
  if (large) await db.insert(toolInvocations).values(Array.from({ length: 2000 }, () => ({ companyId: f.company.id, connectionId: sibling.id, toolName: "history", status: "succeeded" as const })));
  return { ...f, sibling, invocation, requests };
}
