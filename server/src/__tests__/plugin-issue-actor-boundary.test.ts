import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) } as any;

describeDb("plugin issue actor boundary", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-issue-actor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("rejects forged claims without writes, while plugin-origin writes and reads stay scoped", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Test tenant", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other tenant", issuePrefix: `T${otherCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    const pluginId = "plugin-record-id";
    const services = buildHostServices(db, pluginId, "paperclip.test-plugin", eventBus);
    const forged = randomUUID();
    for (const key of ["actorUserId", "actorAgentId", "actorRunId", "originRunId", "actorResponsibleUserId", "responsibleUserId", "trustExplicitResponsibleUserId", "watchdogActorRunId", "authorizationActor", "options", "workspaceSelectionActor", "workspaceSelection", "conversationHandoff"]) {
      await expect(services.issues.create({ companyId, title: "Rejected", [key]: forged } as any)).rejects.toThrow("not authenticated");
    }
    await expect(services.issues.create({ companyId, title: "Rejected", workspaceSelectionActor: { type: "board", userId: forged } } as any)).rejects.toThrow("not authenticated");
    expect(await db.select().from(issues)).toEqual([]);
    expect(await db.select().from(activityLog)).toEqual([]);
    const [before] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(before?.issueCounter).toBe(0);

    const issue = await services.issues.create({ companyId, title: "Plugin issue" });
    expect(issue).toMatchObject({ companyId, createdByAgentId: null, createdByUserId: null, originRunId: null });
    const eventsBefore = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(eventsBefore).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: "plugin", actorId: pluginId })]));
    for (const key of ["actorUserId", "actorAgentId", "actorRunId", "actorRunStopId", "actorPrincipalType", "responsibleUserId", "originRunId", "createdByUserId", "companyId", "companyGuard", "expectedExecutionPolicy", "expectedStatusVersion", "authorizationActor", "options", "workspaceSelectionActor", "caseHandoffId"]) {
      await expect(services.issues.update({ companyId, issueId: issue.id, patch: { title: "Rejected", [key]: forged } })).rejects.toThrow("not authenticated");
    }
    await expect(services.issues.update({ companyId, issueId: issue.id, patch: { workspaceSelectionActor: { type: "board", userId: forged } } })).rejects.toThrow("not authenticated");
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id))).toEqual(eventsBefore);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ title: "Plugin issue", companyId });
    await expect(services.issues.update({ companyId: otherCompanyId, issueId: issue.id, patch: { title: "Wrong tenant" } })).rejects.toThrow();
    await expect(services.issues.get({ companyId: otherCompanyId, issueId: issue.id })).resolves.toBeNull();
    await expect(services.issues.update({ companyId, issueId: issue.id, patch: { title: "Updated" } })).resolves.toMatchObject({ title: "Updated", companyId });
    await expect(services.issues.get({ companyId, issueId: issue.id })).resolves.toMatchObject({ title: "Updated" });
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", responsibleUserId: "parent-user" });
    const child = await services.issues.create({ companyId, parentId, title: "Child" });
    expect(child.responsibleUserId).toBe("parent-user");
    await expect(services.issues.update({ companyId, issueId: child.id, patch: { title: "Child updated", responsibleUserId: null } })).resolves.toMatchObject({ title: "Child updated", responsibleUserId: "parent-user" });
    services.dispose();
  });
});
