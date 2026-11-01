import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  closeRegisteredClients,
  connectionGrants,
  createDb,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { errorHandler } from "../middleware/index.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TOOL_ACCESS_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

function createRouteApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", toolAccessRoutes(db));
  app.use(errorHandler);
  return app;
}

describeDatabase("connection install permission preservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      db = createDb(externalDatabaseUrl);
      return;
    }
    database = await startEmbeddedPostgresTestDatabase("paperclip-install-permissions-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    if (externalDatabaseUrl) await closeRegisteredClients(externalDatabaseUrl);
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: "Install permission fixture",
      issuePrefix: `IP${randomUUID().slice(0, 6)}`,
    }).returning();
    const companyId = company.id;
    const agentIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(agents).values(agentIds.map(id => ({
      id, companyId, name: id, status: "active", adapterType: "process",
    })));
    const [application] = await db.insert(toolApplications).values({
      companyId, name: "Fixture app", type: "mcp_http",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application.id, name: "Fixture connection",
      uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true,
    }).returning();
    await db.insert(connectionGrants).values({
      companyId, connectionId: connection.id, kind: "organization", status: "active", isDefault: true,
    });
    const catalog = await db.insert(toolCatalogEntries).values([
      { name: "read_email", riskLevel: "read" as const, isReadOnly: true, isWrite: false },
      { name: "send_email", riskLevel: "write" as const, isReadOnly: false, isWrite: true },
    ].map(tool => ({
      ...tool, toolName: tool.name, companyId, applicationId: application.id,
      connectionId: connection.id, versionHash: "fixture-v1",
    }))).returning();
    const [appProfile] = await db.insert(toolProfiles).values({
      companyId, profileKey: `app:${connection.id}`, name: "Fixture app access",
      defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id },
    }).returning();
    await db.insert(toolProfileEntries).values(catalog.map(entry => ({
      companyId, profileId: appProfile.id, selectorType: "catalog_entry" as const,
      catalogEntryId: entry.id, connectionId: connection.id,
    })));
    const [limitedProfile] = await db.insert(toolProfiles).values({
      companyId, profileKey: "read-only", name: "Read email only", defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId, profileId: limitedProfile.id, selectorType: "catalog_entry", catalogEntryId: catalog[0].id,
    });
    const app = createRouteApp(db);
    const service = toolAccessService(db);
    const policy = toolAccessPolicyService(db);
    const putTargets = (installs: Array<{ targetType: "agent" | "company"; targetId: string }>) => request(app)
      .put(`/api/tool-connections/${connection.id}/installs`)
      .send({ installs })
      .expect(response => expect(response.status, JSON.stringify(response.body)).toBe(200));
    const putInstalls = (ids: string[]) => putTargets(ids.map(targetId => ({ targetType: "agent", targetId })));
    const appBindings = () => db.select().from(toolProfileBindings)
      .where(and(eq(toolProfileBindings.companyId, companyId), eq(toolProfileBindings.profileId, appProfile.id)));
    const extensions = () => db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_connection.install_access_extended"),
    ));
    const decide = (agentId: string, toolName: string) => policy.decide({
      companyId, actor: { actorType: "agent", actorId: agentId, agentId },
      request: {
        connectionId: connection.id, catalogEntryId: catalog.find(entry => entry.toolName === toolName)!.id,
        toolName, arguments: {},
      },
    });
    return { companyId, agentIds, connection, catalog, appProfile, limitedProfile, service, putTargets, putInstalls, appBindings, extensions, decide };
  }

  it.each(["adding an agent", "removing an agent", "saving the same list"])(
    "preserves removed app grants when %s",
    async change => {
      const f = await fixture();
      const [first, second, fullAccess, added] = f.agentIds;
      await f.putInstalls([first, second, fullAccess]);
      for (const agentId of [first, second]) {
        await expect(f.decide(agentId, "send_email")).resolves.toMatchObject({ decision: "allow" });
        await f.service.bindProfile(f.limitedProfile.id, { targetType: "agent", targetId: agentId });
        await f.service.unbindProfile(f.appProfile.id, { targetType: "agent", targetId: agentId });
        await expect(f.decide(agentId, "read_email")).resolves.toMatchObject({ decision: "allow" });
        await expect(f.decide(agentId, "send_email")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_default" });
      }
      const priorBindings = await f.appBindings();
      const priorEvents = await f.extensions();
      const desired = change === "adding an agent" ? [first, second, fullAccess, added]
        : change === "removing an agent" ? [first, second] : [first, second, fullAccess];

      await f.putInstalls(desired);

      for (const agentId of [first, second]) {
        await expect(f.decide(agentId, "read_email")).resolves.toMatchObject({ decision: "allow" });
        await expect(f.decide(agentId, "send_email")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_default" });
        const effective = await f.service.getEffectiveProfilesForAgent(f.companyId, agentId);
        expect(effective.installedConnections.map(connection => connection.id)).toContain(f.connection.id);
      }
      const bindings = await f.appBindings();
      expect(bindings.map(binding => binding.targetId).sort()).toEqual(
        desired.filter(id => id !== first && id !== second).sort(),
      );
      expect((await f.service.listConnectionInstalls(f.connection.id)).map(install => install.targetId).sort())
        .toEqual([...desired].sort());
      const newEvents = (await f.extensions()).filter(event => !priorEvents.some(prior => prior.id === event.id));
      expect(newEvents.map(event => event.details?.targetId)).toEqual(change === "adding an agent" ? [added] : []);
      if (change !== "removing an agent") {
        expect(bindings.find(binding => binding.targetId === fullAccess)).toEqual(priorBindings[0]);
        await expect(f.decide(fullAccess, "send_email")).resolves.toMatchObject({ decision: "allow" });
      }
      if (change === "adding an agent") {
        await expect(f.decide(added, "send_email")).resolves.toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
      }
    },
  );

  it.each(["saving the same list", "removing an agent"])(
    "removes legacy connection-wide includes when %s",
    async change => {
      const f = await fixture();
      const [first, second] = f.agentIds;
      await f.putInstalls([first, second]);
      const writeEntry = f.catalog.find(entry => entry.toolName === "send_email")!;
      await db.delete(toolProfileEntries).where(and(
        eq(toolProfileEntries.profileId, f.appProfile.id), eq(toolProfileEntries.catalogEntryId, writeEntry.id),
      ));
      await db.insert(toolProfileEntries).values({
        companyId: f.companyId, profileId: f.appProfile.id, selectorType: "connection",
        effect: "include", connectionId: f.connection.id,
      });
      await expect(f.decide(first, "send_email")).resolves.toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
      const priorBindings = await f.appBindings();
      const priorEvents = await f.extensions();
      const desired = change === "removing an agent" ? [first] : [first, second];

      await f.putInstalls(desired);

      await expect(f.decide(first, "read_email")).resolves.toMatchObject({ decision: "allow" });
      await expect(f.decide(first, "send_email")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_default" });
      expect(await db.select().from(toolProfileEntries).where(and(
        eq(toolProfileEntries.profileId, f.appProfile.id), eq(toolProfileEntries.selectorType, "connection"),
      ))).toEqual([]);
      expect((await f.appBindings()).sort((a, b) => a.targetId.localeCompare(b.targetId))).toEqual(
        priorBindings.filter(binding => desired.includes(binding.targetId)).sort((a, b) => a.targetId.localeCompare(b.targetId)),
      );
      expect(await f.extensions()).toEqual(priorEvents);
    },
  );

  it("preserves a removed company app grant when saving a company install", async () => {
    const f = await fixture();
    const input = { installs: [{ targetType: "company" as const, targetId: f.companyId }] };
    await f.putTargets(input.installs);
    await f.service.unbindProfile(f.appProfile.id, { targetType: "company", targetId: f.companyId });
    const priorEvents = await f.extensions();

    await f.putTargets(input.installs);

    await expect(f.decide(f.agentIds[0], "send_email")).resolves.toMatchObject({ decision: "deny", reasonCode: "deny_default" });
    expect(await f.appBindings()).toEqual([]);
    expect(await f.extensions()).toEqual(priorEvents);
    expect(await f.service.listConnectionInstalls(f.connection.id)).toEqual([
      expect.objectContaining({ targetType: "company", targetId: f.companyId }),
    ]);
  });
});
