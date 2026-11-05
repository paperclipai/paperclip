import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, goals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { goalService } from "../services/goals.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Goal parent company tests unsupported: ${support.reason}`);

describeDatabase("goal parent company validation", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sequence = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-goal-parent-company-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(goals);
    await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function company() {
    const [row] = await db.insert(companies).values({
      name: "Synthetic goal boundary fixture", issuePrefix: `GP${++sequence}`,
    }).returning();
    return row.id;
  }

  it("keeps same-company team/task hierarchy and achieved updates usable", async () => {
    const companyId = await company();
    const service = goalService(db);
    const parent = await service.create(companyId, { title: "Team", level: "team" });
    const child = await service.create(companyId, { title: "Task", level: "task", parentId: parent.id });
    const updated = await service.update(child.id, { title: "Checked", description: "Synthetic", status: "achieved" });
    expect(updated).toMatchObject({ companyId, parentId: parent.id, status: "achieved", title: "Checked" });
    const replacement = await service.create(companyId, { title: "Replacement", level: "team", status: "achieved" });
    expect(await service.update(child.id, { parentId: replacement.id })).toMatchObject({ parentId: replacement.id });
    expect(await service.update(child.id, { title: "Title only" })).toMatchObject({ parentId: replacement.id, title: "Title only" });
    expect(await service.update(child.id, { parentId: null })).toMatchObject({ parentId: null });
  });

  it("rejects a foreign parent before inserting a child", async () => {
    const home = await company();
    const foreign = await company();
    const service = goalService(db);
    const parent = await service.create(foreign, { title: "Foreign parent" });
    const failure = await service.create(home, { title: "Must not exist", parentId: parent.id })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(422);
    expect((failure as Error).message).toBe("Parent goal not found in this company");
    expect(await service.list(home)).toEqual([]);
    expect(await service.getById(parent.id)).toMatchObject({ companyId: foreign });
  });

  it("rejects a foreign parent update atomically and preserves the existing hierarchy", async () => {
    const home = await company();
    const foreign = await company();
    const service = goalService(db);
    const parent = await service.create(home, { title: "Home parent" });
    const child = await service.create(home, { title: "Original", parentId: parent.id });
    const other = await service.create(foreign, { title: "Foreign parent" });
    const failure = await service.update(child.id, { title: "Must not change", parentId: other.id })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(422);
    expect((failure as Error).message).toBe("Parent goal not found in this company");
    const [stored] = await db.select().from(goals).where(eq(goals.id, child.id));
    expect(stored).toMatchObject({ companyId: home, title: "Original", parentId: parent.id });
  });

  it("uses the same denial for missing parents on create and update without changing rows", async () => {
    const companyId = await company();
    const service = goalService(db);
    const child = await service.create(companyId, { title: "Original" });
    const parentId = "db7da378-99a6-43ea-964f-000000000000";
    for (const write of [
      () => service.create(companyId, { title: "Must not exist", parentId }),
      () => service.update(child.id, { title: "Must not change", parentId }),
    ]) {
      const failure = await write().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HttpError);
      expect((failure as HttpError).status).toBe(422);
      expect((failure as Error).message).toBe("Parent goal not found in this company");
    }
    expect(await service.list(companyId)).toMatchObject([{ id: child.id, title: "Original", parentId: null }]);
  });

  it("keeps a missing update target as null", async () => {
    expect(await goalService(db).update("db7da378-99a6-43ea-964f-000000000000", { title: "Missing" })).toBeNull();
  });

  it("rejects raw plugin patches that move the goal to another company", async () => {
    const home = await company();
    const foreign = await company();
    const service = goalService(db);
    const parent = await service.create(home, { title: "Home parent" });
    const child = await service.create(home, { title: "Original", parentId: parent.id });
    // The plugin host forwards params.patch as any, outside the REST validator.
    const patch = { companyId: foreign, parentId: parent.id, title: "Must not change" };
    const failure = await service.update(child.id, patch as any)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(422);
    expect(await service.getById(child.id)).toMatchObject({ companyId: home, title: "Original", parentId: parent.id });
  });

  it("keeps runtime identity fields out of allowed same-company updates", async () => {
    const companyId = await company();
    const service = goalService(db);
    const goal = await service.create(companyId, { title: "Original" });
    const unwantedId = "db7da378-99a6-43ea-964f-000000000000";
    const patch = { id: unwantedId, companyId, title: "Allowed" };
    expect(await service.update(goal.id, patch as any)).toMatchObject({ id: goal.id, companyId, title: "Allowed" });
    expect(await service.getById(unwantedId)).toBeNull();
  });

  it("allows concurrent parent edits without conflicting with foreign-key checks", async () => {
    const companyId = await company();
    const service = goalService(db);
    const first = await service.create(companyId, { title: "First" });
    const second = await service.create(companyId, { title: "Second" });
    // Pause both real UPDATEs after their service row locks, before the FK
    // checks. This exposes incompatible row locks without relying on timing.
    await db.execute(sql`create function goal_parent_test_gate() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock_shared(hashtextextended(current_database() || 'goal-parent-test', 0));
        return new;
      end $$`);
    await db.execute(sql`create trigger goal_parent_test_gate before update on goals
      for each row execute function goal_parent_test_gate()`);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const gateReady = new Promise<number>((resolve) => { ready = resolve; });
    const gate = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(current_database() || 'goal-parent-test', 0))`);
      const [owner] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready(owner.pid);
      await released;
    });
    const ownerPid = await gateReady;
    const edits = Promise.allSettled([
      service.update(first.id, { parentId: second.id }),
      service.update(second.id, { parentId: first.id }),
    ]);
    try {
      await expect.poll(async () => {
        const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count
          from pg_locks where locktype = 'advisory' and not granted
          and ${ownerPid} = any(pg_blocking_pids(pid))`);
        return waiting.count;
      }, { timeout: 5_000 }).toBe(2);
      release();
      await gate;
      const failures = (await edits).flatMap((result) => result.status === "rejected"
        ? [result.reason?.cause?.code ?? result.reason?.code ?? String(result.reason)]
        : []);
      expect(failures).toEqual([]);
      expect(await service.getById(first.id)).toMatchObject({ parentId: second.id });
      expect(await service.getById(second.id)).toMatchObject({ parentId: first.id });
    } finally {
      release();
      await gate;
      await edits;
      await db.execute(sql`drop trigger goal_parent_test_gate on goals`);
      await db.execute(sql`drop function goal_parent_test_gate()`);
    }
  });
});
