import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
});
