import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentTaskSessions, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS, managedClaudeTranscriptExpirationService } from "../services/managed-claude-transcripts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres managed Claude transcript expiration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("managed Claude transcript expiration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let instanceRoot = "";
  const now = new Date();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-transcript-expiration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (instanceRoot) await fs.rm(instanceRoot, { recursive: true, force: true });
    instanceRoot = "";
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    issueStatus?: string;
    closedDaysAgo?: number;
    lastUsedDaysAgo?: number;
    runStatus?: string;
    withIssue?: boolean;
    withAgent?: boolean;
    withTaskFile?: boolean;
    companyId?: string;
  } = {}) {
    if (!instanceRoot) instanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-transcripts-"));
    const companyId = input.companyId ?? randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Transcripts", issuePrefix: `T${companyId.slice(0, 6)}` });
    const agentId = randomUUID();
    if (input.withAgent !== false) await db.insert(agents).values({ id: agentId, companyId, name: "Coder" });
    const issueStatus = input.issueStatus ?? "done";
    const closedAt = new Date(now.getTime() - (input.closedDaysAgo ?? 10) * DAY_MS);
    let taskKey = randomUUID();
    if (input.withIssue !== false) {
      const [issue] = await db.insert(issues).values({
        companyId,
        title: "Closed work",
        status: issueStatus,
        completedAt: issueStatus === "done" ? closedAt : null,
        cancelledAt: issueStatus === "cancelled" ? closedAt : null,
      }).returning();
      taskKey = issue!.id;
    }
    if (input.withAgent !== false) {
      const runStatus = input.runStatus ?? "succeeded";
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: runStatus,
        issueId: input.withIssue === false ? null : taskKey,
        finishedAt: ["queued", "running"].includes(runStatus) ? null : closedAt,
      });
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey,
        sessionParamsJson: { sessionId: randomUUID() },
      });
    }
    const transcriptsDir = path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-transcripts");
    const scopeDir = path.join(transcriptsDir, randomBytes(8).toString("hex"));
    await fs.mkdir(path.join(scopeDir, "projects", "-workspace"), { recursive: true });
    await fs.writeFile(path.join(scopeDir, "projects", "-workspace", "session.jsonl"), "turn");
    if (input.withTaskFile !== false) {
      const taskFile = path.join(scopeDir, "task.json");
      await fs.writeFile(taskFile, JSON.stringify({ taskKey }));
      const lastUsed = new Date(now.getTime() - (input.lastUsedDaysAgo ?? 9) * DAY_MS);
      await fs.utimes(taskFile, lastUsed, lastUsed);
    }
    return { companyId, agentId, taskKey, transcriptsDir, scopeDir };
  }

  function service() {
    return managedClaudeTranscriptExpirationService(db, { retentionDays: 7, now, instanceRoot });
  }

  async function taskSessionCount() {
    return (await db.select().from(agentTaskSessions)).length;
  }

  it.each(["done", "cancelled"])("expires transcripts of a %s issue after the window and clears its task session", async (issueStatus) => {
    const seeded = await seed({ issueStatus });

    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, expired: 1, clearedTaskSessions: 1, failed: 0 });
    expect(await exists(seeded.scopeDir)).toBe(false);
    expect(await fs.readdir(seeded.transcriptsDir)).toEqual([]);
    expect(await taskSessionCount()).toBe(0);
  });

  it.each([
    [{ issueStatus: "in_progress" }, "issue_open"],
    [{ closedDaysAgo: 2 }, "recently_closed"],
    [{ lastUsedDaysAgo: 2 }, "recently_used"],
    [{ runStatus: "running" }, "live_run"],
    [{ runStatus: "queued" }, "live_run"],
    [{ withTaskFile: false }, "task_unknown"],
  ] as const)("keeps transcripts when %o", async (input, reason) => {
    const seeded = await seed(input);

    const result = await service().tick();

    expect(result.expired).toBe(0);
    expect(result.skipped[reason]).toBe(1);
    expect(await exists(path.join(seeded.scopeDir, "projects", "-workspace", "session.jsonl"))).toBe(true);
    expect(await taskSessionCount()).toBe(1);
  });

  it("schedules the next pass for when a recently-closed issue's own window lifts", async () => {
    const closedDaysAgo = 2;
    await seed({ closedDaysAgo });

    const result = await service().tick();

    expect(result.skipped.recently_closed).toBe(1);
    expect(result.nextDueAt).toBe(now.getTime() - closedDaysAgo * DAY_MS + 7 * DAY_MS);
  });

  it.each([
    [{ issueStatus: "in_progress" }, "issue_open"],
    [{ runStatus: "running" }, "live_run"],
  ] as const)("rechecks after a day while a directory is held back by %o", async (input, reason) => {
    await seed(input);

    const result = await service().tick();

    expect(result.skipped[reason]).toBe(1);
    expect(result.nextDueAt).toBe(now.getTime() + DAY_MS);
  });

  it("keeps a held-back directory's recheck across a sweep split into batches", async () => {
    const held = await seed({ issueStatus: "in_progress", companyId: "00000000-0000-4000-8000-000000000001" });
    const expirable = await seed({ companyId: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    const sweep = managedClaudeTranscriptExpirationService(db, { retentionDays: 7, now, instanceRoot, maxEntries: 1 });

    const first = await sweep.tick();
    const second = await sweep.tick();

    expect([first.truncated, second.truncated]).toEqual([true, false]);
    expect(await exists(held.scopeDir)).toBe(true);
    expect(await exists(expirable.scopeDir)).toBe(false);
    expect(second.nextDueAt).toBe(now.getTime() + DAY_MS);
  });

  it("rechecks after a day when a closed issue has no closing time", async () => {
    const seeded = await seed();
    await db.update(issues).set({ completedAt: null, cancelledAt: null }).where(eq(issues.id, seeded.taskKey));

    const result = await service().tick();

    expect(result.skipped.recently_closed).toBe(1);
    expect(result.nextDueAt).toBe(now.getTime() + DAY_MS);
  });

  it("schedules nothing when no transcript directory is left", async () => {
    instanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-transcripts-"));
    expect((await service().tick()).nextDueAt).toBeNull();
  });

  it("expires transcripts whose issue or agent no longer exists once unused for the window", async () => {
    const withoutIssue = await seed({ withIssue: false });
    const withoutAgent = await seed({ withAgent: false });
    const recentWithoutIssue = await seed({ withIssue: false, lastUsedDaysAgo: 1 });

    const result = await service().tick();

    expect(result.expired).toBe(2);
    expect(await exists(withoutIssue.scopeDir)).toBe(false);
    expect(await exists(withoutAgent.scopeDir)).toBe(false);
    expect(await exists(recentWithoutIssue.scopeDir)).toBe(true);
  });

  it("finishes an interrupted removal and restores an unconfirmed one", async () => {
    const seeded = await seed({ issueStatus: "in_progress" });
    const scope = path.basename(seeded.scopeDir);
    const expired = path.join(seeded.transcriptsDir, `.expired-${randomUUID()}`);
    await fs.mkdir(expired);
    await fs.rename(seeded.scopeDir, path.join(seeded.transcriptsDir, `.retiring-${scope}.${randomUUID()}`));

    await service().tick();

    expect(await exists(expired)).toBe(false);
    expect(await fs.readdir(seeded.transcriptsDir)).toEqual([scope]);
    expect(await exists(path.join(seeded.scopeDir, "task.json"))).toBe(true);
  });

  it("keeps the task session while another transcript directory of the task is in use", async () => {
    const seeded = await seed();
    const recent = path.join(seeded.transcriptsDir, randomBytes(8).toString("hex"));
    await fs.mkdir(path.join(recent, "projects"), { recursive: true });
    await fs.writeFile(path.join(recent, "task.json"), JSON.stringify({ taskKey: seeded.taskKey }));

    const result = await service().tick();

    expect(result).toMatchObject({ expired: 1, clearedTaskSessions: 0 });
    expect(await exists(seeded.scopeDir)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await taskSessionCount()).toBe(1);
  });

  it("clears only the claude_local task session of the task", async () => {
    const seeded = await seed();
    await db.insert(agentTaskSessions).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      adapterType: "codex_local",
      taskKey: seeded.taskKey,
      sessionParamsJson: { sessionId: randomUUID() },
    });

    expect(await service().tick()).toMatchObject({ expired: 1, clearedTaskSessions: 1 });
    expect((await db.select().from(agentTaskSessions)).map((row) => row.adapterType)).toEqual(["codex_local"]);
  });

  it("drops a leftover retiring copy when the directory exists again", async () => {
    const seeded = await seed({ issueStatus: "in_progress" });
    const leftover = path.join(seeded.transcriptsDir, `.retiring-${path.basename(seeded.scopeDir)}.${randomUUID()}`);
    await fs.mkdir(leftover);

    await service().tick();

    expect(await exists(leftover)).toBe(false);
    expect(await exists(path.join(seeded.scopeDir, "task.json"))).toBe(true);
  });

  it("puts the transcripts back when the expiring transaction fails", async () => {
    const seeded = await seed();
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => run(new Proxy(tx, {
          get(innerTarget, innerProperty, innerReceiver) {
            if (innerProperty === "delete") throw new Error("injected delete failure");
            return Reflect.get(innerTarget, innerProperty, innerReceiver);
          },
        })));
      },
    });

    const result = await managedClaudeTranscriptExpirationService(failingDb, { retentionDays: 7, now, instanceRoot }).tick();

    expect(result).toMatchObject({ expired: 0, failed: 1, nextDueAt: now.getTime() + MANAGED_CLAUDE_TRANSCRIPT_CLEANUP_RETRY_MS });
    expect(await fs.readdir(seeded.transcriptsDir)).toEqual([path.basename(seeded.scopeDir)]);
    expect(await taskSessionCount()).toBe(1);
  });

  it("continues a bounded batch on the next tick", async () => {
    await seed();
    await seed();
    const sweep = managedClaudeTranscriptExpirationService(db, { retentionDays: 7, now, instanceRoot, maxEntries: 1 });

    expect(await sweep.tick()).toMatchObject({ checked: 1, expired: 1, truncated: true });
    expect(await sweep.tick()).toMatchObject({ checked: 1, expired: 1, truncated: false });
  });
});
