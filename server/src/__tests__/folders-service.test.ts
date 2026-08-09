import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  folderSlugSchema,
} from "@paperclipai/shared";
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
    const cleared = await svc.update(companyId, cleanup.id, { color: null });
    expect(cleared).toMatchObject({ id: cleanup.id, color: null });

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

  it("computes canonical paths and updates descendant paths after rename and move", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const root = await svc.create(companyId, { kind: "skill", name: "Engineering" });
    const child = await svc.create(companyId, { kind: "skill", parentId: root.id, name: "Code Review" });
    const destination = await svc.create(companyId, { kind: "skill", name: "Operations" });

    expect(child).toMatchObject({ path: "engineering/code-review", depth: 2 });
    await svc.update(companyId, root.id, { name: "Product Engineering" });
    expect(await svc.getFolder(companyId, child.id)).toMatchObject({
      path: "product-engineering/code-review",
      depth: 2,
    });

    await svc.moveFolder(companyId, child.id, { parentId: destination.id, position: 0 });
    expect(await svc.getFolder(companyId, child.id)).toMatchObject({
      parentId: destination.id,
      path: "operations/code-review",
      depth: 2,
    });
  });

  it("rejects invalid slugs, cycles, and folders deeper than four levels", async () => {
    expect(folderSlugSchema.safeParse("../escape").success).toBe(false);
    expect(folderSlugSchema.safeParse("Valid Slug").success).toBe(false);
    expect(folderSlugSchema.safeParse("valid-slug-2").success).toBe(true);

    const companyId = await seedCompany();
    const svc = folderService(db);
    const level1 = await svc.create(companyId, { kind: "skill", name: "Level 1" });
    const level2 = await svc.create(companyId, { kind: "skill", parentId: level1.id, name: "Level 2" });
    const level3 = await svc.create(companyId, { kind: "skill", parentId: level2.id, name: "Level 3" });
    const level4 = await svc.create(companyId, { kind: "skill", parentId: level3.id, name: "Level 4" });

    await expect(svc.create(companyId, {
      kind: "skill",
      parentId: level4.id,
      name: "Level 5",
    })).rejects.toMatchObject({ status: 422, message: "Folder depth cannot exceed 4" });
    await expect(svc.moveFolder(companyId, level1.id, {
      parentId: level3.id,
      position: 0,
    })).rejects.toMatchObject({ status: 422, message: "A folder cannot be moved into its own subtree" });
  });

  it("creates stable personal roots and protects bundled folders", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const personal = await svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace");
    const repeated = await svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace");
    const bundled = await svc.ensureBundledCategory(companyId, "software-development");

    expect(repeated.id).toBe(personal.id);
    expect(personal).toMatchObject({ systemKey: "my:user-1", path: "my/ada-lovelace", depth: 2 });
    expect(bundled.path).toBe("bundled/software-development");
    await expect(svc.create(companyId, {
      kind: "skill",
      parentId: bundled.id,
      name: "Nested",
    })).rejects.toMatchObject({ status: 403, message: "Bundled folders are read-only" });
    await expect(svc.update(companyId, bundled.id, { name: "Changed" })).rejects.toMatchObject({ status: 403 });
  });

  it("heals legacy bundled category names without changing folder identity", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const legacy = await svc.ensureBundledCategory(companyId, "software-development");

    const reconciled = await svc.ensureBundledCategory(companyId, "Software Development");

    expect(reconciled).toMatchObject({
      id: legacy.id,
      name: "Software Development",
      path: "bundled/software-development",
      systemKey: "bundled:software-development",
    });
  });

  it("creates reserved folders idempotently under concurrent requests", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);

    const [personalA, personalB] = await Promise.all([
      svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace"),
      svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace"),
    ]);
    const [projectA, projectB] = await Promise.all([
      svc.ensureProjectFolder(companyId, "project-1", "Core App"),
      svc.ensureProjectFolder(companyId, "project-1", "Core App"),
    ]);
    const [bundledA, bundledB] = await Promise.all([
      svc.ensureBundledCategory(companyId, "software-development"),
      svc.ensureBundledCategory(companyId, "software-development"),
    ]);

    expect(personalA.id).toBe(personalB.id);
    expect(projectA.id).toBe(projectB.id);
    expect(bundledA.id).toBe(bundledB.id);
  });

  it("reserves system skill roots from manual create, update, and move", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);

    for (const slug of ["bundled", "my", "projects"]) {
      await expect(svc.create(companyId, {
        kind: "skill",
        name: slug,
        slug,
      })).rejects.toMatchObject({ status: 403, message: "Reserved skill folders are system-managed" });
    }

    const editable = await svc.create(companyId, { kind: "skill", name: "Editable" });
    await expect(svc.update(companyId, editable.id, { slug: "bundled" })).rejects.toMatchObject({ status: 403 });

    const parent = await svc.create(companyId, { kind: "skill", name: "Parent" });
    const nestedReserved = await svc.create(companyId, { kind: "skill", parentId: parent.id, name: "Projects" });
    await expect(svc.moveFolder(companyId, nestedReserved.id, { parentId: null, position: 0 })).rejects.toMatchObject({
      status: 403,
      message: "Reserved skill folders are system-managed",
    });
  });

  it("allows only system helpers to create children under personal and project roots", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const personal = await svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace");
    const project = await svc.ensureProjectFolder(companyId, "project-1", "Core App");
    const myRoot = await svc.getFolder(companyId, personal.parentId!);
    const projectsRoot = await svc.getFolder(companyId, project.parentId!);
    const movable = await svc.create(companyId, { kind: "skill", name: "Movable" });

    expect(myRoot?.systemKey).toBe("my");
    expect(projectsRoot?.systemKey).toBe("projects");
    await expect(svc.create(companyId, {
      kind: "skill",
      parentId: myRoot!.id,
      name: "Spoofed User",
    })).rejects.toMatchObject({ status: 403 });
    await expect(svc.moveFolder(companyId, movable.id, {
      parentId: projectsRoot!.id,
      position: 0,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("moves squatted roots aside instead of adopting them as system containers", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const [squattedMy, squattedProjects] = await db.insert(folders).values([
      { companyId, kind: "skill", parentId: null, name: "Attacker My", slug: "my", position: 0 },
      { companyId, kind: "skill", parentId: null, name: "Attacker Projects", slug: "projects", position: 1 },
    ]).returning();

    const personal = await svc.ensureMyFolder(companyId, "user-1", "Ada Lovelace");
    const project = await svc.ensureProjectFolder(companyId, "project-1", "Core App");
    const myRoot = await svc.getFolder(companyId, personal.parentId!);
    const projectsRoot = await svc.getFolder(companyId, project.parentId!);
    const repairedMy = await svc.getFolder(companyId, squattedMy!.id);
    const repairedProjects = await svc.getFolder(companyId, squattedProjects!.id);

    expect(myRoot).toMatchObject({ slug: "my", systemKey: "my" });
    expect(projectsRoot).toMatchObject({ slug: "projects", systemKey: "projects" });
    expect(repairedMy).toMatchObject({ name: "Attacker My", systemKey: null });
    expect(repairedMy?.slug).toMatch(/^my-[a-f0-9]{8}$/);
    expect(repairedProjects).toMatchObject({ name: "Attacker Projects", systemKey: null });
    expect(repairedProjects?.slug).toMatch(/^projects-[a-f0-9]{8}$/);
  });

  it("suffixes system children when legacy rows squat personal and project slugs", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const initialPersonal = await svc.ensureMyFolder(companyId, "seed-user", "Seed User");
    const initialProject = await svc.ensureProjectFolder(companyId, "seed-project", "Seed Project");
    const myRootId = initialPersonal.parentId!;
    const projectsRootId = initialProject.parentId!;
    await db.insert(folders).values([
      { companyId, kind: "skill", parentId: myRootId, name: "Ada Squat", slug: "ada-lovelace", position: 1 },
      { companyId, kind: "skill", parentId: projectsRootId, name: "Core Squat", slug: "core-app", position: 1 },
    ]);

    const personal = await svc.ensureMyFolder(companyId, "user-12345678", "Ada Lovelace");
    const project = await svc.ensureProjectFolder(companyId, "project-12345678", "Core App");

    expect(personal).toMatchObject({ path: "my/ada-lovelace-user-12345678", systemKey: "my:user-12345678" });
    expect(project).toMatchObject({ path: "projects/core-app-project-12345678", systemKey: "project:project-12345678" });
  });

  it("does not adopt a legacy category row under the bundled root", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const initialCategory = await svc.ensureBundledCategory(companyId, "initial");
    const bundledRootId = initialCategory.parentId!;
    const [squatted] = await db.insert(folders).values({
      companyId,
      kind: "skill",
      parentId: bundledRootId,
      name: "User Software Development",
      slug: "software-development",
      position: 1,
    }).returning();

    const category = await svc.ensureBundledCategory(companyId, "software-development");

    expect(category).toMatchObject({
      path: "bundled/software-development-bundled",
      systemKey: "bundled:software-development",
    });
    expect(await svc.getFolder(companyId, squatted!.id)).toMatchObject({
      path: "bundled/software-development",
      systemKey: null,
    });
  });

  it("serializes concurrent system folder ensures", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    await db.insert(folders).values({
      companyId,
      kind: "skill",
      name: "Squatted My",
      slug: "my",
      position: 0,
    });

    const personalFolders = await Promise.all(
      Array.from({ length: 8 }, () => svc.ensureMyFolder(companyId, "user-123", "Ada Lovelace")),
    );

    expect(new Set(personalFolders.map((folder) => folder.id)).size).toBe(1);
    const rows = await db.select().from(folders).where(eq(folders.companyId, companyId));
    expect(rows.filter((row) => row.systemKey === "my")).toHaveLength(1);
    expect(rows.filter((row) => row.systemKey === "my:user-123")).toHaveLength(1);
    expect(rows.find((row) => row.systemKey === null)).toMatchObject({ name: "Squatted My" });
  });

  it("returns a 409 conflict (not an unhandled 500) when a real wrapped Postgres unique-violation hits the create() catch branch", async () => {
    // folders.ts used to have its own local isPostgresError that only
    // checked the top-level error's `.code`. drizzle-orm wraps the real pg
    // error on `.cause`, so that check never matched and this catch branch
    // was dead code. Now that isPostgresError walks the cause chain, this
    // branch is live for the first time. Bypass the per-company advisory
    // lock (by driving two `mutationLockHeld: true` service instances
    // directly, skipping the `withCompanyFolderLock` wrapper that normally
    // serializes creates) so two creates race past the app-level
    // `assertNoSlugConflict` pre-check concurrently, forcing the database's
    // unique index to reject the second insert with a genuine wrapped
    // `cause.code === "23505"` error, matching how drizzle actually wraps
    // Postgres errors (see built-in-agents.test.ts's equivalent race for
    // the same wrapping shape).
    //
    // Racing alone isn't enough to prove *which* code path produced the
    // 409, though: `assertNoSlugConflict`'s own pre-check throws an
    // identically-shaped 409 ("Folder slug already exists under this
    // parent"), and depending on scheduling it can win the race just as
    // easily as the INSERT-level catch this test is actually meant to
    // exercise. `assertNoSlugConflict` is a private closure inside
    // folders.ts (not exported), so it can't be spied on directly. Instead,
    // force it to be a no-op by intercepting its `db.select({ id:
    // folders.id })` conflict-check query -- within this test's call path
    // (a top-level `create()` with no `parentId`, so `validateParent` never
    // queries) that exact `{ id: folders.id }` select shape is unique to
    // `assertNoSlugConflict`, so making it always resolve to "no existing
    // row found" guarantees `assertNoSlugConflict` can never be the source
    // of the 409 -- any 409 that occurs must come from the real
    // database-level unique-constraint catch in the INSERT's try/catch.
    //
    // The `{ id: folders.id }` shape isn't actually unique to
    // `assertNoSlugConflict`, though -- e.g. `deleteFolder`'s child-row
    // check builds the exact same shape. If some other code path the test
    // doesn't intend to touch ever matched here, the mock would silently
    // fake-empty it instead of hitting the real DB, and the test could
    // still pass for the wrong reason. So this also counts every select
    // call, both matched and total, and asserts the exact counts implied by
    // this test's two racing `create()` calls (see the tally below) --
    // if the mock ever intercepts more or fewer calls than expected, this
    // fails loudly instead of silently passing.
    const companyId = await seedCompany();

    let matchedSelectCount = 0;
    let totalSelectCount = 0;
    const originalSelect = db.select.bind(db);
    const selectSpy = vi.spyOn(db, "select").mockImplementation((...args: unknown[]) => {
      totalSelectCount += 1;
      const fields = args[0] as { id?: unknown } | undefined;
      if (fields && Object.keys(fields).length === 1 && fields.id === folders.id) {
        // This is `assertNoSlugConflict`'s pre-check query -- force it to
        // see no conflicting row, so it can never itself throw the 409.
        matchedSelectCount += 1;
        return { from: () => ({ where: () => Promise.resolve([]) }) } as unknown as ReturnType<typeof db.select>;
      }
      return (originalSelect as (...args: unknown[]) => ReturnType<typeof db.select>)(...args);
    });

    // Uses `expect.soft()` for the outcome assertions below so a failure
    // among them does not abort the test before the mock-call-count guards
    // after them get a chance to run -- those guards must run
    // unconditionally (see the comment further down) and would otherwise
    // mask, or be skipped in favor of, whichever outcome assertion failed
    // first. `expect.soft()` records failures instead of throwing
    // immediately; vitest surfaces every recorded soft failure alongside any
    // later hard `expect()` failure once the test finishes, so nothing gets
    // silently hidden regardless of which assertions fail.
    try {
      const [first, second] = await Promise.allSettled([
        folderService(db, true).create(companyId, { kind: "routine", name: "Racer", slug: "racer" }),
        folderService(db, true).create(companyId, { kind: "routine", name: "Racer", slug: "racer" }),
      ]);

      const settled = [first, second];
      const fulfilled = settled.filter((result) => result.status === "fulfilled");
      const rejected = settled.filter((result) => result.status === "rejected");

      expect.soft(fulfilled).toHaveLength(1);
      expect.soft(rejected).toHaveLength(1);
      expect.soft((rejected[0] as PromiseRejectedResult | undefined)?.reason).toMatchObject({
        status: 409,
        message: "Folder slug already exists under this parent",
      });
    } finally {
      selectSpy.mockRestore();
    }

    // These count guards run after every `expect.soft()` failure above,
    // because `expect.soft()` records a failure instead of throwing --
    // execution falls through to here regardless of which soft assertions
    // failed, so the guards still get a chance to catch the mock
    // intercepting the wrong calls (exactly the kind of thing that could
    // *cause* a soft assertion above to fail in the first place). This is
    // NOT an unconditional guarantee, though: it only holds for `expect.soft()`
    // failures specifically. Any ordinary (non-soft) exception thrown inside
    // the `try` block above -- e.g. from `Promise.allSettled` itself, or a
    // bug in the mock implementation -- still propagates past the `finally`
    // and skips these guards entirely, same as it would without `expect.soft()`.

    // Each of the two racing `create()` calls hits `assertNoSlugConflict`
    // exactly once (no `parentId`, so `validateParent` never queries) --
    // that's the only place this exact shape should ever be produced in
    // this test. If it's ever more or less than 2, either this mock is
    // catching a call it shouldn't (masking a real bug) or the
    // implementation changed under it in a way this test no longer
    // validates.
    expect(matchedSelectCount).toBe(2);

    // Total selects: each racing call does 1 matched (assertNoSlugConflict)
    // + 1 unmatched (nextPosition's `{ value: max(...) }` select). The
    // winner additionally runs `getFolder` after its insert succeeds,
    // which issues 2 more unmatched selects (`getFolderRow`, `getRows`)
    // -- the loser's insert throws before it ever gets there. That's
    // (1 + 1) * 2 + 2 = 6 selects total, deterministically, regardless of
    // which call wins the race. A different total means either an
    // unexpected code path ran or this mock intercepted a call it
    // shouldn't have.
    expect(totalSelectCount).toBe(6);
  });

  it("rechecks nested folders after waiting for the company mutation lock", async () => {
    const companyId = await seedCompany();
    const svc = folderService(db);
    const parent = await svc.create(companyId, { kind: "routine", name: "Parent" });
    let releaseLock!: () => void;
    let markLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { markLockAcquired = resolve; });
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockKey = `paperclip:folders:${companyId}`;
    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      markLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    const deletion = svc.deleteFolder(companyId, parent.id);
    await db.insert(folders).values({
      companyId,
      kind: "routine",
      parentId: parent.id,
      name: "Child",
      slug: "child",
      position: 0,
    });
    releaseLock();
    await blocker;

    await expect(deletion).rejects.toMatchObject({
      status: 409,
      message: "Move or delete nested folders first",
    });
    await expect(svc.getFolder(companyId, parent.id)).resolves.toMatchObject({ id: parent.id });
  });
});
