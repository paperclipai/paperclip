import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  agents, chatEndpointResources, chatEndpoints, chatExternalPrincipals, chatIdentityLinks,
  companies, connectionGrants, createDb, toolApplications, toolCatalogEntries, toolConnections,
  toolPolicies, toolProfileBindings, toolProfileEntries, toolProfiles,
} from "@paperclipai/db";
import { slackAuthorizationRevision } from "../services/connectors/slack-revision.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("Slack authorization revision", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-slack-revision-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const companyId of companyIds.splice(0)) {
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: `Revision ${randomUUID()}`, issuePrefix: `SR${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    companyIds.push(company.id);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Revision agent" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: "Slack", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "mcp_remote" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: connection.id, assignedAgentId: agent.id, provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    const [resource] = await db.insert(chatEndpointResources).values({ companyId: company.id, endpointId: endpoint.id, type: "channel", providerResourceId: randomUUID(), label: "Allowed channel", enabled: true }).returning();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: company.id, provider: "slack", providerAccountId: randomUUID(), externalId: randomUUID() }).returning();
    const userId = randomUUID();
    const [link] = await db.insert(chatIdentityLinks).values({ companyId: company.id, endpointId: endpoint.id, principalId: principal.id, paperclipUserId: userId, status: "linked" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, subjectUserId: userId, kind: "user" }).returning();
    const [catalog] = await db.insert(toolCatalogEntries).values({ companyId: company.id, connectionId: connection.id, name: "Read", toolName: "read", versionHash: "version-one" }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: randomUUID(), name: "Allowed tools" }).returning();
    const [entry] = await db.insert(toolProfileEntries).values({ companyId: company.id, profileId: profile.id, selectorType: "connection", connectionId: connection.id, effect: "include" }).returning();
    const [binding] = await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id }).returning();
    const [policy] = await db.insert(toolPolicies).values({ companyId: company.id, name: "Read policy", policyType: "allow", selectors: { connectionId: connection.id } }).returning();
    const revision = (reader = db) => slackAuthorizationRevision(reader, company.id, endpoint.id, connection.id, agent.id, userId);
    return { company, agent, connection, endpoint, resource, link, grant, catalog, profile, entry, binding, policy, userId, revision };
  }

  it("returns one bounded digest in one SQL statement with 47,930 retained entries", async () => {
    const f = await fixture();
    for (let start = 1; start < 47_930; start += 1000) {
      await db.insert(toolProfileEntries).values(Array.from({ length: Math.min(1000, 47_930 - start) }, (_, offset) => ({
        companyId: f.company.id, profileId: f.profile.id, selectorType: "tool_name" as const,
        toolName: `tool_${start + offset}`, effect: "include" as const, conditions: { allowed: ["read", "inspect"], text: "λ" },
      })));
    }
    let reads = 0;
    const measured = drizzle(db.$client, { logger: { logQuery: () => { reads++; } } }) as typeof db;
    const cpu = process.cpuUsage();
    const started = performance.now();
    const revision = await f.revision(measured);
    console.info(JSON.stringify({ entries: 47_930, reads, elapsedMs: performance.now() - started, cpuMicros: process.cpuUsage(cpu) }));
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(reads).toBe(1);
    expect(await f.revision()).toBe(revision);
    const canceled = await db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '1ms'`);
      return f.revision(tx as unknown as typeof db);
    }).then(() => null, error => error.cause ?? error);
    expect(canceled).toMatchObject({ code: "57014" });
    expect(await f.revision()).toBe(revision);
  }, 30_000);

  it.each(["resource", "identity", "grant", "catalog", "policy", "profile", "entry", "binding"] as const)("invalidates after a %s authorization change", async kind => {
    const f = await fixture();
    const before = await f.revision();
    const changes = {
      resource: () => db.update(chatEndpointResources).set({ enabled: false }).where(eq(chatEndpointResources.id, f.resource.id)),
      identity: () => db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, f.link.id)),
      grant: () => db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id)),
      catalog: () => db.update(toolCatalogEntries).set({ quarantinedAt: new Date() }).where(eq(toolCatalogEntries.id, f.catalog.id)),
      policy: () => db.update(toolPolicies).set({ enabled: false }).where(eq(toolPolicies.id, f.policy.id)),
      profile: () => db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, f.profile.id)),
      entry: () => db.update(toolProfileEntries).set({ effect: "exclude" }).where(eq(toolProfileEntries.id, f.entry.id)),
      binding: () => db.update(toolProfileBindings).set({ priority: 1 }).where(eq(toolProfileBindings.id, f.binding.id)),
    };
    await changes[kind]();
    expect(await f.revision()).not.toBe(before);
  });

  it("ignores another company and other users' links, grants, and agent bindings", async () => {
    const own = await fixture();
    const before = await own.revision();
    const foreign = await fixture();
    await db.update(toolProfiles).set({ metadata: { changed: true } }).where(eq(toolProfiles.id, foreign.profile.id));
    const [otherPrincipal] = await db.insert(chatExternalPrincipals).values({ companyId: own.company.id, provider: "slack", providerAccountId: randomUUID(), externalId: randomUUID() }).returning();
    const otherUserId = randomUUID();
    await db.insert(chatIdentityLinks).values({ companyId: own.company.id, endpointId: own.endpoint.id, principalId: otherPrincipal.id, paperclipUserId: otherUserId, status: "linked" });
    await db.insert(connectionGrants).values({ companyId: own.company.id, connectionId: own.connection.id, subjectUserId: otherUserId, kind: "user" });
    await db.insert(toolProfileBindings).values({ companyId: own.company.id, profileId: own.profile.id, targetType: "agent", targetId: randomUUID() });
    expect(await own.revision()).toBe(before);
  });

  it("ignores message activity that cannot change authorization", async () => {
    const f = await fixture();
    const before = await f.revision();
    await db.update(chatEndpoints).set({ lastEventAt: new Date(), lastPublicationAt: new Date() }).where(eq(chatEndpoints.id, f.endpoint.id));
    await db.update(chatEndpointResources).set({ label: "Renamed channel", updatedAt: new Date() }).where(eq(chatEndpointResources.id, f.resource.id));
    expect(await f.revision()).toBe(before);
  });

  it("is stable across timezone, physical row order, and scan plans", async () => {
    const f = await fixture();
    const prefix = randomUUID().slice(0, -12);
    const timestamp = new Date("2026-10-01T00:00:00.000Z");
    const rows = [3, 1, 2].map(value => ({
      id: `${prefix}${String(value).padStart(12, "0")}`,
      companyId: f.company.id, profileId: f.profile.id,
      selectorType: "tool_name" as const, effect: "include" as const,
      toolName: `ordered_${value}`, createdAt: timestamp, updatedAt: timestamp,
    }));
    await db.insert(toolProfileEntries).values(rows);
    const before = await f.revision();
    await db.transaction(async tx => {
      await tx.execute(sql`set local time zone 'America/New_York'`);
      await tx.execute(sql`set local plan_cache_mode = force_custom_plan`);
      await tx.execute(sql`set local enable_indexscan = off`);
      await tx.execute(sql`set local enable_indexonlyscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const heapBefore = await tx.select({ id: toolProfileEntries.id }).from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, f.company.id));
      expect(await f.revision(tx as unknown as typeof db)).toBe(before);
      await tx.delete(toolProfileEntries).where(inArray(toolProfileEntries.id, rows.map(row => row.id)));
      await tx.insert(toolProfileEntries).values([...rows].reverse());
      const heapAfter = await tx.select({ id: toolProfileEntries.id }).from(toolProfileEntries)
        .where(eq(toolProfileEntries.companyId, f.company.id));
      expect(heapAfter).not.toEqual(heapBefore);
      expect(heapAfter.map(row => row.id).sort()).toEqual(heapBefore.map(row => row.id).sort());
      expect(await f.revision(tx as unknown as typeof db)).toBe(before);
      await tx.execute(sql`set local enable_indexscan = on`);
      await tx.execute(sql`set local enable_indexonlyscan = on`);
      await tx.execute(sql`set local enable_seqscan = off`);
      expect(await f.revision(tx as unknown as typeof db)).toBe(before);
    });
    expect(await f.revision()).toBe(before);
  });

  it("distinguishes null, empty, Unicode, and delimited authorization values", async () => {
    const f = await fixture();
    const revisions = [await f.revision()];
    for (const conditions of [{}, { text: "λ,{}" }, { text: "λ", other: "{}" }]) {
      await db.update(toolProfileEntries).set({ conditions }).where(eq(toolProfileEntries.id, f.entry.id));
      revisions.push(await f.revision());
    }
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it("distinguishes inserted and removed rows and repeats an empty snapshot", async () => {
    const f = await fixture();
    const before = await f.revision();
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.id, f.entry.id));
    expect(await f.revision()).not.toBe(before);
    const companyId = randomUUID();
    const empty = () => slackAuthorizationRevision(db, companyId, randomUUID(), randomUUID(), randomUUID(), randomUUID());
    expect(await empty()).toBe(await empty());
  });
});
