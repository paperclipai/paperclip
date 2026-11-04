import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped, LEGACY_ADAPTER_NOT_ENTERED_RECEIPT } from "./agent-execution-stop.js";
import { readProcessStartedAt } from "./hot-restart.js";

const beforeAnyBoot = new Date("2000-01-01T00:00:00.000Z");

describe.skipIf(process.platform === "win32")("agent execution stop proof", () => {
  const externalUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const groups: number[] = [];
  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("agent-execution-stop-");
    db = createDb(externalUrl ?? temporary!.connectionString);
  }, 30_000);
  afterEach(() => {
    for (const group of groups.splice(0)) {
      try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
    }
  });
  afterAll(async () => { await temporary?.cleanup(); if (externalUrl) await closeRegisteredClients(externalUrl); });

  async function agentWithRun(run: Partial<typeof heartbeatRuns.$inferInsert>) {
    const [company] = await db.insert(companies).values({ name: "Stop proof", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "claude_local" }).returning();
    const [inserted] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      invocationSource: "on_demand", runtimeMode: "legacy", ...run } as typeof heartbeatRuns.$inferInsert).returning();
    return { agentId: agent.id, runId: inserted.id };
  }

  /** A cancelled legacy run stopped before spawn: started, never given a process. */
  const cancelledBeforeSpawn = (finishedAt = new Date()) => ({
    status: "cancelled", startedAt: finishedAt, finishedAt, executionStage: "settled", errorCode: "issue_reassigned",
    runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    resultJson: { stopReason: "cancelled", reassignmentStopConfirmed: true },
  });

  async function detachedGroup(leaderExits: boolean): Promise<number> {
    const child: ChildProcess = spawn("sh", ["-c", leaderExits ? "sleep 30 & exit 0" : "sleep 30"],
      { detached: true, stdio: "ignore" });
    child.unref();
    const group = child.pid!;
    groups.push(group);
    if (leaderExits) await new Promise(resolve => child.once("exit", resolve));
    return group;
  }

  it("keeps a conversation run cancelled before spawn live until its executor records the receipt", async () => {
    const { agentId, runId } = await agentWithRun(cancelledBeforeSpawn());
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ resultJson: { ...cancelledBeforeSpawn().resultJson,
      [LEGACY_ADAPTER_NOT_ENTERED_RECEIPT]: new Date().toISOString() } }).where(eq(heartbeatRuns.id, runId));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("does not accept the receipt before the executor has settled", async () => {
    const { agentId } = await agentWithRun({ ...cancelledBeforeSpawn(), executionStage: "preparing",
      resultJson: { [LEGACY_ADAPTER_NOT_ENTERED_RECEIPT]: new Date().toISOString() } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("treats a conversation run that finished before host boot as stopped", async () => {
    const { agentId } = await agentWithRun(cancelledBeforeSpawn(beforeAnyBoot));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("ignores a recycled process group whose identity was recorded before host boot", async () => {
    const group = await detachedGroup(true);
    const { agentId, runId } = await agentWithRun({ status: "succeeded", startedAt: beforeAnyBoot,
      processPid: group, processGroupId: group, processStartedAt: beforeAnyBoot });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Without a finish time, a group recorded after boot cannot be ruled out.
    await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 10_000),
      processStartedAt: new Date(Date.now() - 10_000) }).where(eq(heartbeatRuns.id, runId));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("keeps a live leader with its recorded start time", async () => {
    const group = await detachedGroup(false);
    const { agentId } = await agentWithRun({ status: "succeeded", startedAt: new Date(), finishedAt: new Date(Date.now() - 10_000),
      processPid: group, processGroupId: group, processStartedAt: new Date(await readProcessStartedAt(group)) });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("treats a dead leader's group made only of later processes as reused", async () => {
    const before = new Date(Date.now() - 10_000);
    const group = await detachedGroup(true);
    const { agentId, runId } = await agentWithRun({ status: "succeeded", startedAt: before, finishedAt: before,
      processPid: group, processGroupId: group, processStartedAt: before });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // A member that was alive when the run finished keeps the group live.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, runId));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });
});
