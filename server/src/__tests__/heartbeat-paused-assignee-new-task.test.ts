import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping paused assignee new task tests: ${recoveryPostgresSupport.reason}`);

describePostgres("new task for a manually paused assignee", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const dispatched: string[] = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-paused-assignee-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-paused-assignee-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push(input.runId);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seed(holds: string[]) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `paused-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paused assignee fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Morgan", adapterType, adapterConfig: {},
      status: "paused", lifecycleState: "paused", lifecycleHolds: holds, pauseReason: holds[0] ?? null, pausedAt: new Date() });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task created while Morgan is paused", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId };
  }

  const runs = (f: { companyId: string; agentId: string }) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agentId)));

  it("keeps the task waiting while the pause lasts and starts it once on resume", async () => {
    const f = await seed(["manual"]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(waiting.status).toBe("todo");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    expect(await runs(f)).toHaveLength(0);

    await db.update(agents).set({ status: "idle", lifecycleState: "ready", lifecycleHolds: [], pauseReason: null, pausedAt: null })
      .where(eq(agents.id, f.agentId));
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const ids = new Set((await runs(f)).map(run => run.id));
    expect(dispatched.filter(id => ids.has(id))).toHaveLength(1);
    const [finished] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(finished.status).toBe("done");
  }, 180_000);

  it("still escalates a new task whose assignee is paused by something other than a person", async () => {
    const f = await seed(["budget"]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved.status).not.toBe("todo");
    expect(await runs(f)).toHaveLength(0);
  }, 180_000);
});
