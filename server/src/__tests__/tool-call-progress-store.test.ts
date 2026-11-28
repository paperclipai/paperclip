import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, toolInvocations, type Db } from "@paperclipai/db";
import { listToolCallProgress, saveToolCallProgress } from "../services/tool-call-progress.js";
import { assignedToolName } from "../services/native-runtime/assigned-mcp-tools.js";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";

describe("saved tool call progress", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("tool-call-progress-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function task(prefix: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: prefix });
    const [agent] = await db.insert(agents).values({ companyId, name: "Agent", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Export" });
    const call = async (values: Partial<typeof toolInvocations.$inferInsert> = {}) => (await db.insert(toolInvocations).values({
      companyId, issueId, runId: run!.id, agentId: agent!.id, toolName: "kv_demo__slow_with_progress",
      status: "executing", startedAt: new Date("2026-11-13T10:00:00Z"), ...values,
    }).returning())[0]!;
    return { companyId, issueId, runId: run!.id, call };
  }
  const progress = (value: number) => ({ progress: value, total: 10, message: "Exporting", updatedAt: "2026-11-13T10:00:05.000Z" });

  it("returns a task's running calls with their latest progress, and nothing from another company or task", async () => {
    const mine = await task("PRGA");
    const theirs = await task("PRGB");
    const running = await mine.call();
    await saveToolCallProgress(db, mine.companyId, running.id)(progress(3));
    await saveToolCallProgress(db, mine.companyId, running.id)(progress(4));
    const other = await theirs.call();
    await saveToolCallProgress(db, theirs.companyId, other.id)(progress(9));
    // A write naming the wrong company never lands.
    await saveToolCallProgress(db, mine.companyId, other.id)(progress(1));
    const now = new Date("2026-11-13T10:01:00Z");

    expect(await listToolCallProgress(db, mine.companyId, mine.issueId, now)).toEqual([{
      invocationId: running.id, runId: mine.runId, toolName: "kv_demo__slow_with_progress",
      nativeToolName: assignedToolName("kv_demo__slow_with_progress"),
      startedAt: "2026-11-13T10:00:00.000Z", progress: 4, total: 10, message: "Exporting",
      updatedAt: "2026-11-13T10:00:05.000Z", done: false,
    }]);
    expect(await listToolCallProgress(db, mine.companyId, theirs.issueId, now)).toEqual([]);
    expect(await listToolCallProgress(db, theirs.companyId, mine.issueId, now)).toEqual([]);
    expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, other.id)))[0]!.progress).toMatchObject({ progress: 9 });
  });

  it("never writes progress onto a finished call, and reports it as done", async () => {
    const mine = await task("PRGC");
    const running = await mine.call({ createdAt: new Date() });
    await saveToolCallProgress(db, mine.companyId, running.id)(progress(2));
    expect(await listToolCallProgress(db, mine.companyId, mine.issueId)).toHaveLength(1);
    await db.update(toolInvocations).set({ status: "succeeded", completedAt: new Date() }).where(eq(toolInvocations.id, running.id));
    // A late, throttled save after the result must not overwrite it.
    await saveToolCallProgress(db, mine.companyId, running.id)(progress(8));
    expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, running.id)))[0]!.progress).toMatchObject({ progress: 2 });
    // A chat that missed the end learns it; a call that never saved progress is reported too.
    const notSaved = await mine.call({ createdAt: new Date() });
    await db.update(toolInvocations).set({ status: "succeeded", completedAt: new Date() }).where(eq(toolInvocations.id, notSaved.id));
    const listed = await listToolCallProgress(db, mine.companyId, mine.issueId);
    expect(listed.map((entry) => [entry.invocationId, entry.done, entry.progress]).sort()).toEqual(
      [[running.id, true, 2], [notSaved.id, true, 0]].sort(),
    );
  });
});
