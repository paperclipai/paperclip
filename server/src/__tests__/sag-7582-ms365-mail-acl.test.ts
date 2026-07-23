import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({ name: `Graph ACL ${randomUUID()}`, issuePrefix: `GA${randomUUID().slice(0, 5).toUpperCase()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string, name: string) {
  return db
    .insert(agents)
    .values({ companyId, name, role: "engineer", adapterType: "claude_local", adapterConfig: {} })
    .returning()
    .then((rows) => rows[0]!);
}

// Mirrors server/scripts/seed-sag7582-ms365-mail-cto-acl.ts end to end, using the same
// toolAccessService entry points a real seed run would use, to prove the whole SAG-7582
// wiring (template -> connection -> catalog -> CTO-only install) actually works and
// that a non-allowlisted agent is denied.
describeEmbeddedPostgres("SAG-7582 ms365-mail-readonly CTO-only ACL", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sag-7582-ms365-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("wires a local_stdio ms365-mail-readonly connection scoped to exactly one agent", async () => {
    const company = await createCompany(db);
    const cto = await createAgent(db, company.id, "CTO");
    const otherAgent = await createAgent(db, company.id, "Some Other Agent");
    const svc = toolAccessService(db);

    const connection = await svc.createConnection(company.id, {
      applicationName: "Microsoft 365 Mail",
      name: "Microsoft 365 Mail (read-only, CTO)",
      transport: "local_stdio",
      status: "active",
      enabled: true,
      config: { templateId: "paperclip.ms365-mail-readonly" },
      credentialSecretRefs: [],
    });
    expect(connection.transport).toBe("local_stdio");
    expect(connection.config).toMatchObject({ templateId: "paperclip.ms365-mail-readonly" });

    const refresh = await svc.refreshCatalog(connection.id);
    const toolNames = refresh.catalog.map((entry) => entry.toolName).sort();
    expect(toolNames).toContain("list-mail-messages");
    expect(toolNames).toContain("get-mail-message");
    // Read-only preset: none of the write/destructive mail tools were registered.
    expect(toolNames).not.toContain("send-mail");
    expect(toolNames).not.toContain("delete-mail-message");

    await svc.putConnectionInstalls(connection.id, {
      installs: [{ targetType: "agent", targetId: cto.id }],
    });

    const ctoEffective = await svc.getEffectiveProfilesForAgent(company.id, cto.id);
    expect(ctoEffective.installedConnections.map((c) => c.id)).toContain(connection.id);

    // The MCP boundary: an agent with no install/binding for this connection must not
    // see it as installed, regardless of the connection's own catalog/profile state.
    const otherEffective = await svc.getEffectiveProfilesForAgent(company.id, otherAgent.id);
    expect(otherEffective.installedConnections.map((c) => c.id)).not.toContain(connection.id);
  });
});
