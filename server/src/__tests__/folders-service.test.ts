import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySkills,
  createDb,
  folders,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { folderService } from "../services/folders.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("folder service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-folders-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(routines);
    await db.delete(folders);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedRoutine(companyId: string, title: string, folderId?: string | null) {
    const [routine] = await db
      .insert(routines)
      .values({
        companyId,
        title,
        folderId: folderId ?? null,
        responsibleUserId: "responsible-user",
      })
      .returning();
    return routine!;
  }

  async function seedSkill(companyId: string, slug: string, folderId?: string | null) {
    const [skill] = await db
      .insert(companySkills)
      .values({
        companyId,
        folderId: folderId ?? null,
        key: `company/${companyId}/${slug}`,
        slug,
        name: slug,
        markdown: `# ${slug}`,
      })
      .returning();
    return skill!;
  }

  it("creates, updates, reorders, and lists routine folders with counts", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);

    const reporting = await svc.create(companyId, {
      kind: "routine",
      name: "Reporting",
      color: "green",
    });
    const cleanup = await svc.create(companyId, {
      kind: "routine",
      name: "Cleanup",
      color: null,
    });
    await seedRoutine(companyId, "Filed", reporting.id);
    await seedRoutine(companyId, "Unfiled");

    const renamed = await svc.update(companyId, cleanup.id, { name: "Ops", color: "cyan" });
    expect(renamed).toMatchObject({ id: cleanup.id, name: "Ops", color: "cyan" });

    const movedFolder = await svc.moveFolder(companyId, reporting.id, { position: 10 });
    expect(movedFolder).toMatchObject({ id: reporting.id, position: 10 });

    const listed = await svc.list(companyId, "routine");
    expect(listed.allCount).toBe(2);
    expect(listed.unfiledCount).toBe(1);
    expect(listed.folders).toEqual([
      expect.objectContaining({ id: cleanup.id, name: "Ops", itemCount: 0 }),
      expect.objectContaining({ id: reporting.id, name: "Reporting", itemCount: 1 }),
    ]);
  });

  it("moves routines and skills to folders and back to virtual Unfiled", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const routineFolder = await svc.create(companyId, { kind: "routine", name: "Reports" });
    const skillFolder = await svc.create(companyId, { kind: "skill", name: "Runtime" });
    const routine = await seedRoutine(companyId, "Daily report");
    const skill = await seedSkill(companyId, "review");

    await expect(svc.moveItem(companyId, {
      kind: "routine",
      itemId: routine.id,
      folderId: routineFolder.id,
    })).resolves.toEqual({ kind: "routine", itemId: routine.id, folderId: routineFolder.id });
    await expect(svc.moveItem(companyId, {
      kind: "skill",
      itemId: skill.id,
      folderId: skillFolder.id,
    })).resolves.toEqual({ kind: "skill", itemId: skill.id, folderId: skillFolder.id });

    await expect(svc.moveItem(companyId, {
      kind: "routine",
      itemId: routine.id,
      folderId: null,
    })).resolves.toEqual({ kind: "routine", itemId: routine.id, folderId: null });

    const [updatedRoutine] = await db.select().from(routines).where(eq(routines.id, routine.id));
    const [updatedSkill] = await db.select().from(companySkills).where(eq(companySkills.id, skill.id));
    expect(updatedRoutine?.folderId).toBeNull();
    expect(updatedSkill?.folderId).toBe(skillFolder.id);
  });

  it("rejects moving an item into a folder of the wrong kind", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const skillFolder = await svc.create(companyId, { kind: "skill", name: "Runtime" });
    const routine = await seedRoutine(companyId, "Daily report");

    await expect(svc.moveItem(companyId, {
      kind: "routine",
      itemId: routine.id,
      folderId: skillFolder.id,
    })).rejects.toMatchObject({
      status: 422,
      message: "Folder kind must match item kind",
    });
  });

  it("deletes folders without deleting contents by moving items to Unfiled", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const folder = await svc.create(companyId, { kind: "routine", name: "Reports" });
    const routine = await seedRoutine(companyId, "Daily report", folder.id);

    const deleted = await svc.deleteFolder(companyId, folder.id);
    expect(deleted).toMatchObject({ id: folder.id, name: "Reports" });

    const [updatedRoutine] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(updatedRoutine?.folderId).toBeNull();
    expect(await db.select().from(folders).where(eq(folders.id, folder.id))).toHaveLength(0);
  });
});
