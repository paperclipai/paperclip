import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, projects as projectsTable } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { projectService, PROJECT_TREE_ERROR_CODES } from "../services/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("project tree service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let counter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-tree-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function company(name = "Tree Co") {
    counter += 1;
    return db.insert(companies).values({ name, issuePrefix: `TR${counter}` }).returning().then((rows) => rows[0]!);
  }

  async function rejectsCode(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject<HttpError>({ status: 409, details: { code } });
  }

  it("persists nullable parentProjectId and returns it naturally", async () => {
    const co = await company();
    const svc = projectService(db);
    const root = await svc.create(co.id, { name: "Root" });
    const child = await svc.create(co.id, { name: "Child", parentProjectId: root.id });
    expect(root.parentProjectId).toBeNull();
    expect(child.parentProjectId).toBe(root.id);
    expect((await svc.getById(child.id))?.parentProjectId).toBe(root.id);
  });

  it("rejects missing, cross-company, archived, and self parents", async () => {
    const a = await company("A");
    const b = await company("B");
    const svc = projectService(db);
    await rejectsCode(svc.create(a.id, { name: "Missing", parentProjectId: "11111111-1111-4111-8111-111111111111" }), PROJECT_TREE_ERROR_CODES.parentNotFound);
    const foreign = await svc.create(b.id, { name: "Foreign" });
    await rejectsCode(svc.create(a.id, { name: "Cross", parentProjectId: foreign.id }), PROJECT_TREE_ERROR_CODES.parentCompanyMismatch);
    const archived = await svc.create(a.id, { name: "Archived", archivedAt: new Date() });
    await rejectsCode(svc.create(a.id, { name: "Inactive child", parentProjectId: archived.id }), PROJECT_TREE_ERROR_CODES.parentArchived);
    const root = await svc.create(a.id, { name: "Root" });
    await rejectsCode(svc.update(root.id, { parentProjectId: root.id }), PROJECT_TREE_ERROR_CODES.selfParent);
  });

  it("enforces maximum depth three on create and subtree moves", async () => {
    const co = await company();
    const svc = projectService(db);
    const root = await svc.create(co.id, { name: "Root" });
    const level2 = await svc.create(co.id, { name: "Level 2", parentProjectId: root.id });
    const level3 = await svc.create(co.id, { name: "Level 3", parentProjectId: level2.id });
    await rejectsCode(svc.create(co.id, { name: "Level 4", parentProjectId: level3.id }), PROJECT_TREE_ERROR_CODES.depthExceeded);
    const subtree = await svc.create(co.id, { name: "Subtree" });
    await svc.create(co.id, { name: "Subtree child", parentProjectId: subtree.id });
    await rejectsCode(svc.update(subtree.id, { parentProjectId: level2.id }), PROJECT_TREE_ERROR_CODES.depthExceeded);
  });

  it("rejects cycles", async () => {
    const co = await company();
    const svc = projectService(db);
    const root = await svc.create(co.id, { name: "Root" });
    const child = await svc.create(co.id, { name: "Child", parentProjectId: root.id });
    await rejectsCode(svc.update(root.id, { parentProjectId: child.id }), PROJECT_TREE_ERROR_CODES.cycle);
  });

  it("serializes concurrent moves that would otherwise create a cycle", async () => {
    const co = await company();
    const svc = projectService(db);
    const left = await svc.create(co.id, { name: "Left" });
    const right = await svc.create(co.id, { name: "Right" });

    const results = await Promise.allSettled([
      svc.update(left.id, { parentProjectId: right.id }),
      svc.update(right.id, { parentProjectId: left.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { status: 409, details: { code: PROJECT_TREE_ERROR_CODES.cycle } },
    });

    const rows = await db.select().from(projectsTable).where(eq(projectsTable.companyId, co.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      const seen = new Set([row.id]);
      let current = row;
      while (current.parentProjectId) {
        expect(seen.has(current.parentProjectId)).toBe(false);
        seen.add(current.parentProjectId);
        current = byId.get(current.parentProjectId)!;
      }
    }
  });

  it("guards archive, unarchive, and hard delete lifecycle operations", async () => {
    const co = await company();
    const svc = projectService(db);
    const root = await svc.create(co.id, { name: "Root" });
    const child = await svc.create(co.id, { name: "Child", parentProjectId: root.id });
    await rejectsCode(svc.update(root.id, { archivedAt: new Date() }), PROJECT_TREE_ERROR_CODES.activeDescendants);
    await svc.update(child.id, { archivedAt: new Date() });
    await svc.update(root.id, { archivedAt: new Date() });
    await rejectsCode(svc.update(child.id, { archivedAt: null }), PROJECT_TREE_ERROR_CODES.archivedParent);
    await rejectsCode(svc.remove(root.id), PROJECT_TREE_ERROR_CODES.descendantsExist);
    await svc.remove(child.id);
    await expect(svc.remove(root.id)).resolves.toMatchObject({ id: root.id });
  });

  it("keeps plugin-managed projects at the root", async () => {
    const co = await company();
    const project = await projectService(db).create(co.id, { name: "Plugin root" });
    expect(project.parentProjectId).toBeNull();
  });
});
