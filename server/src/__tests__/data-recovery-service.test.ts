import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dataRecoveryService } from "../services/data-recovery.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres data recovery service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dataRecoveryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-data-recovery-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("marks a terminated agent as non-restorable when its shortname was reused", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    const replacementAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Recovery Test Agent",
        status: "terminated",
        updatedAt: new Date("2026-05-15T12:00:00.000Z"),
      },
      {
        id: replacementAgentId,
        companyId,
        name: "Recovery Test Agent",
        status: "idle",
      },
    ]);

    const items = await dataRecoveryService(db).list();
    const terminatedAgent = items.find((item) => item.type === "agent" && item.id === terminatedAgentId);

    expect(terminatedAgent).toMatchObject({
      id: terminatedAgentId,
      name: "Recovery Test Agent",
      restoreBlockedReason: expect.stringContaining(replacementAgentId.slice(0, 8)),
    });
  });

  it("blocks restoring a terminated agent when its shortname was reused", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Recovery Test Agent",
        status: "terminated",
      },
      {
        id: randomUUID(),
        companyId,
        name: "Recovery Test Agent",
        status: "idle",
      },
    ]);

    await expect(dataRecoveryService(db).restore("agent", terminatedAgentId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already uses this shortname"),
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, terminatedAgentId));
    expect(agent?.status).toBe("terminated");
  });

  it("returns details for a terminated agent without using route shortnames", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Recovery Test Agent",
      role: "developer",
      title: "Recovery Tester",
      status: "terminated",
      adapterType: "codex_local",
    });

    const response = await dataRecoveryService(db).details("agent", terminatedAgentId);

    expect(response.item).toMatchObject({ id: terminatedAgentId, type: "agent" });
    expect(response.details).toContainEqual({ label: "ID", value: terminatedAgentId });
    expect(response.details).toContainEqual({ label: "Adapter type", value: "codex_local" });
  });

  it("permanently deletes a terminated agent", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Recovery Test Agent",
      status: "terminated",
    });

    const item = await dataRecoveryService(db).deletePermanent("agent", terminatedAgentId);

    expect(item).toMatchObject({ id: terminatedAgentId, type: "agent" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, terminatedAgentId));
    expect(agent).toBeUndefined();
  });

  it("renames a terminated agent so it can be restored after a shortname collision", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Recovery Test Agent",
        status: "terminated",
      },
      {
        id: randomUUID(),
        companyId,
        name: "Recovery Test Agent",
        status: "idle",
      },
    ]);

    const renamed = await dataRecoveryService(db).renameAgent(terminatedAgentId, "Recovery Test Agent Old");

    expect(renamed).toMatchObject({
      id: terminatedAgentId,
      name: "Recovery Test Agent Old",
      href: null,
      restoreBlockedReason: null,
    });

    const restored = await dataRecoveryService(db).restore("agent", terminatedAgentId);
    expect(restored).toMatchObject({
      id: terminatedAgentId,
      name: "Recovery Test Agent Old",
      removedAt: null,
    });
  });

  it("permanently deletes an archived project after detaching its issues", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Test Company",
      issuePrefix: "RTC",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Recovery Test Project",
      archivedAt: new Date("2026-05-15T12:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Recovery Test Issue",
      status: "backlog",
    });

    const item = await dataRecoveryService(db).deletePermanent("project", projectId);

    expect(item).toMatchObject({ id: projectId, type: "project" });
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project).toBeUndefined();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.projectId).toBeNull();
  });
});
