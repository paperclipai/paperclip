import { skillPackageWork } from "../services/skill-package-work.js";
import * as packageCache from "../services/skill-package-cache.js";
import * as recovery from "../services/skill-package-recovery.js";
import type { GitHubRead } from "../services/github-skill-source.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkills, companySkillVersions, companySkillRepositorySnapshots as snapshots,
  skillPackageDeletions, createDb, withDedicatedDbConnection } from "@paperclipai/db";
import * as dbModule from "@paperclipai/db";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { companySkillService } from "../services/company-skills.js";
import { skillPackageStore, skillPackagePaths, withSkillPackageReadScope } from "../services/skill-package-store.js";
import { skillPackageMaintenance } from "../services/skill-package-maintenance.js";
import { skillPackageManifest, validateSkillPackageManifest, writeSkillPackageArchive, extractSkillPackageArchive,
  verifySkillPackageDirectory } from "../services/skill-package-files.js";
import { skillFileBytes, skillSnapshotHash } from "../services/skill-snapshot.js";
import { readCustomerSuccessResource } from "../services/customer-success-inspection.js";
import { repositorySkillProjection } from "../services/skill-repository-package.js";
import { hasRestorableSnapshot } from "../services/skill-version-cache.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("external skill packages", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let storage: storageModule.StorageService;
  const previousHome = process.env.PAPERCLIP_HOME;
  const files: CompanySkillVersionFileInventoryEntry[] = [
    { path: "skills/one/SKILL.md", kind: "skill", content: "---\nname: one\ndescription: Test one\n---\nUse ../../shared/run.sh\n" },
    { path: "skills/two/SKILL.md", kind: "skill", content: "---\nname: two\ndescription: Test two\n---\nUse ../../shared/run.sh\n" },
    { path: "shared/run.sh", kind: "script", content: "#!/bin/sh\necho original\n", executable: true },
    { path: "assets/binary", kind: "reference", content: Buffer.from([0, 255, 7]).toString("base64"), encoding: "base64" },
    { path: "assets/base64-text", kind: "reference", content: Buffer.from("text encoded explicitly").toString("base64"), encoding: "base64" },
  ];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-packages-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-packages-"));
    process.env.PAPERCLIP_HOME = home;
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Package test", issuePrefix: `P${id.slice(0, 6)}` });
    return id;
  }
  async function fixture(recoverable = false) {
    const companyId = await company();
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    const store = skillPackageStore(db, storage);
    const recipe = recoverable ? { version: 1 as const, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40), skillPath: null, manifest: skillPackageManifest(files) } : undefined;
    const id = await store.prepare(companyId, files, false, undefined, recipe);
    const skills = [];
    for (const name of ["one", "two"]) {
      const [skill] = await db.insert(companySkills).values({ companyId, key: `company/${companyId}/${name}`, slug: name,
        name, markdown: files.find(file => file.path === `skills/${name}/SKILL.md`)!.content, sourceType: "github",
        metadata: { skillSourceId: randomUUID(), snapshotHash: "saved" } }).returning();
      const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 1,
        repositorySnapshotId: id, repositorySkillPath: `skills/${name}/SKILL.md`, packageSnapshotId: id, migrationAt: null,
        packageFileMap: [{ path: "SKILL.md", kind: "skill", sourcePath: `skills/${name}/SKILL.md` }] }).returning();
      await db.update(companySkills).set({ currentVersionId: version!.id }).where(eq(companySkills.id, skill!.id));
      skills.push({ skill: skill!, version: version! });
    }
    const service = companySkillService(db);
    const resolve = () => service.listRuntimeSkillEntries(companyId, { onlyKeys: new Set(skills.map(({ skill }) => skill.key)), snapshotLatest: true });
    return { companyId, id, store, skills, service, resolve };
  }

  it("orders skill and package locks consistently with an edit's dedicated upload connection", async () => {
    const f = await fixture();
    const skill = f.skills[0]!.skill;
    const options = { skill, skipInventoryRefresh: true, fileInventory: files, packageSnapshotId: f.id };
    let waitingOnSkill!: () => void;
    const waiting = new Promise<void>(resolve => { waitingOnSkill = resolve; });
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => {
      if (query.includes('from "company_skills"') && query.includes('for update')) waitingOnSkill();
    };
    let saving: Promise<unknown> | undefined;
    try {
      await withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        // updateFile owns this lock before its package is prepared separately.
        await tx.select({ id: companySkills.id }).from(companySkills).where(eq(companySkills.id, skill.id)).for("update");
        saving = f.service.createVersion(f.companyId, skill.id, {}, null, options);
        await waiting;
        await withDedicatedDbConnection(db, async upload => {
          // A regression fails promptly and releases the outer lock instead of
          // leaving a hidden cross-connection wait cycle hanging the suite.
          await upload.execute(sql`set statement_timeout = '3s'`);
          expect(await skillPackageStore(upload, storage).prepare(f.companyId, files)).toBe(f.id);
        });
        await f.service.createVersion(f.companyId, skill.id, {}, null, { ...options, database: tx });
      }));
      await saving;
      expect(await f.service.listVersions(f.companyId, skill.id)).toHaveLength(3);
    } finally { db.$client.options.debug = debug; await saving; }
  }, 15_000);

  it("follows a package published between version metadata and summary reads", async () => {
    const companyId = await company();
    const [skill] = await db.insert(companySkills).values({ companyId, key: "summary", slug: "summary", name: "Summary", markdown: files[0]!.content }).returning();
    const [stale] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 1, fileInventory: files }).returning();
    await skillPackageMaintenance(db, storage).migrateVersions({ id: stale!.id, apply: true, clearLegacy: true });
    expect(await skillPackageStore(db, storage).versionInventory(stale!)).toEqual(files.map(({ path, kind }) => ({ path, kind })));
  });

  it("forks a packaged repository inside an outer transaction with a one-connection pool", async () => {
    const f = await fixture();
    const fork = await db.transaction(tx => companySkillService(tx as unknown as typeof db, { packageDb: db })
      .createLocalSkill(f.companyId, { name: "Idempotent fork", slug: "idempotent-fork", forkedFromSkillId: f.skills[0]!.skill.id }));
    const saved = await f.service.getVersion(f.companyId, fork.id, fork.currentVersionId!);
    expect(saved!.fileInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".paperclip-repository/shared/run.sh", content: files[2]!.content }),
    ]));
  }, 15_000);

  it("lists version metadata without reading archives, while inspection reads the requested historical bytes", async () => {
    const f = await fixture();
    const { skill, version } = f.skills[0]!;
    await db.update(companySkills).set({ markdown: "New current markdown" }).where(eq(companySkills.id, skill.id));
    const read = vi.spyOn(storage, "getObject");
    const history = await f.service.listVersions(f.companyId, skill.id);
    expect(history[0]!.fileInventory).toEqual([{ path: "SKILL.md", kind: "skill" }]);
    expect(read.mock.calls.filter(call => call[1].endsWith("files.tar.gz"))).toHaveLength(0);
    await db.update(companySkillVersions).set({ packageFileMap: [
      ...version.packageFileMap!, { path: "run.sh", kind: "script", sourcePath: "shared/run.sh" },
    ] }).where(eq(companySkillVersions.id, version.id));
    const script = await readCustomerSuccessResource(db, storage, {
      operation: "skills.file", companyId: f.companyId, resourceId: skill.id, versionId: version.id, path: "run.sh",
    }) as { content: string };
    expect(Buffer.from(script.content, "base64").toString()).toBe(files[2]!.content);
    const result = await readCustomerSuccessResource(db, storage, {
      operation: "skills.file", companyId: f.companyId, resourceId: skill.id, versionId: version.id, path: "SKILL.md",
    }) as { content: string };
    expect(Buffer.from(result.content, "base64").toString()).toBe(files[0]!.content);
    const missing = await readCustomerSuccessResource(db, storage, {
      operation: "skills.file", companyId: f.companyId, resourceId: skill.id, versionId: version.id, path: "not-saved.md",
    });
    expect(missing).toEqual({ available: false, reason: "skill_file_not_snapshotted" });
  });

  it("does not block a warm turn behind a paused archive read for retention", async () => {
    const f = await fixture();
    await f.resolve();
    await fs.rm(skillPackagePaths(f.companyId, f.id).directory, { recursive: true, force: true });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const original = storage.getObject.bind(storage);
    vi.spyOn(storage, "getObject").mockImplementation(async (companyId, key, options) => {
      if (key.endsWith("files.tar.gz")) { entered(); await blocked; }
      return original(companyId, key, options);
    });
    const cleanup = hasRestorableSnapshot(db, f.companyId, f.skills[0]!.version.id);
    try {
      await reading;
      const warm = await f.resolve();
      expect(warm.map(entry => entry.sourceStatus)).toEqual(["available", "available"]);
    } finally { release(); await cleanup; }
    expect(await fs.stat(skillPackagePaths(f.companyId, f.id).directory).catch(() => null)).toBeNull();
  }, 15_000);

  it("skips an in-flight publication without waiting on its row or the warm preparation lock", async () => {
    const f = await fixture(true);
    await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.companyId, f.companyId));
    await db.update(snapshots).set({ createdAt: new Date(0), maintenanceAt: new Date(0) }).where(eq(snapshots.id, f.id));
    let retirementStarted!: () => void;
    const waiting = new Promise<void>(resolve => { retirementStarted = resolve; });
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => {
      if (query.includes('company_skill_repository_snapshots') && query.includes('for update')) retirementStarted();
    };
    let sweep: Promise<void> | undefined;
    try {
      await withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        await tx.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.id, f.id)).for("update");
        await tx.update(companySkills).set({ currentVersionId: f.skills[0]!.version.id }).where(eq(companySkills.id, f.skills[0]!.skill.id));
        sweep = skillPackageWork(db, storage).tick(new AbortController().signal);
        await waiting;
        await sweep;
      }));
      await sweep;
      expect((await f.store.descriptor(f.companyId, f.id)).storage).not.toBeNull();
    } finally { db.$client.options.debug = debug; await sweep; }
  }, 15_000);

  it("refuses to publish a package retired before the publication row lock", async () => {
    const f = await fixture(true);
    await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.companyId, f.companyId));
    await db.update(snapshots).set({ storage: null }).where(eq(snapshots.id, f.id));
    await expect(f.service.createVersion(f.companyId, f.skills[0]!.skill.id, {}, null, {
      skill: f.skills[0]!.skill, skipInventoryRefresh: true, fileInventory: files,
      packageSnapshotId: f.id, repositorySnapshotId: f.id, repositorySkillPath: files[0]!.path,
    })).rejects.toThrow(/changed during publication/);
    const [skill] = await db.select().from(companySkills).where(eq(companySkills.id, f.skills[0]!.skill.id));
    expect(skill!.currentVersionId).toBeNull();
  });

  it("converts a legacy fork with the scanner's deepest accepted repository path", async () => {
    const companyId = await company();
    const deep = [...Array(63).fill("d"), "SKILL.md"].join("/");
    const projected = repositorySkillProjection([{ ...files[0]!, path: deep }], deep);
    const [skill] = await db.insert(companySkills).values({ companyId, key: "deep", slug: "deep", name: "Deep", markdown: projected[0]!.content }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 1, fileInventory: projected }).returning();
    await skillPackageMaintenance(db, storage).migrateVersions({ id: version!.id, apply: true, clearLegacy: true });
    const [saved] = await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, version!.id));
    expect(saved!.migrationAt).toBeNull();
    expect(await skillPackageStore(db, storage).versionFiles(saved!)).toEqual(projected);
  });

  it("automatically converts legacy rows, clears verified payloads and preserves version identities", async () => {
    const companyId = await company();
    const [snapshot] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const [skill] = await db.insert(companySkills).values({ companyId, key: "legacy", slug: "legacy", name: "Legacy", markdown: files[0]!.content }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 7,
      repositorySnapshotId: snapshot!.id, repositorySkillPath: files[0]!.path,
      fileInventory: [{ ...files[0]!, path: "SKILL.md" }] }).returning();
    const work = skillPackageWork(db, storage);
    await work.tick(new AbortController().signal);
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.id, snapshot!.id));
    const [converted] = await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, version!.id));
    expect(saved!.fileInventory).toEqual([]);
    expect(saved!.migrationAt).toBeNull();
    expect(saved!.storage).not.toBeNull();
    expect(converted!.fileInventory).toEqual([]);
    expect(converted!.migrationAt).toBeNull();
    expect(converted!.packageSnapshotId).toBe(snapshot!.id);
    expect(converted!.revisionNumber).toBe(7);
    expect(await skillPackageStore(db, storage).versionFiles(converted!)).toEqual([{ ...files[0]!, path: "SKILL.md" }]);
  });

  it.each(["file", "folder"] as const)("restores a deleted %s when the replacement package upload fails", async target => {
    const companyId = await company();
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Delete rollback", slug: "delete-rollback", markdown: "# Keep the skill\n" });
    const binary = Buffer.from([0, 255, 7, 128]);
    await service.updateFile(companyId, skill.id, "bundle/probe.sh", "#!/bin/sh\nprintf kept\n", null, { executable: true });
    await service.updateFile(companyId, skill.id, "bundle/nested/data.bin", binary.toString("base64"), null, { encoding: "base64" });
    await service.updateFile(companyId, skill.id, "keep.txt", "Unrelated file\n");
    const root = skill.sourceLocator!;
    await fs.chmod(path.join(root, "bundle/probe.sh"), 0o751);
    await fs.mkdir(path.join(root, "bundle/empty"));
    await fs.mkdir(path.join(root, "bundle/.git"));
    await fs.writeFile(path.join(root, "bundle/.git/local-state"), "Unlisted bytes\n");
    const [before] = await db.select().from(companySkills).where(eq(companySkills.id, skill.id));
    const versionsBefore = await db.select({ id: companySkillVersions.id }).from(companySkillVersions)
      .where(eq(companySkillVersions.companySkillId, skill.id));
    const input = { path: target === "file" ? "bundle/probe.sh" : "bundle", target };
    const upload = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("Object storage unavailable"));
    try {
      await expect(service.deleteFile(companyId, skill.id, input)).rejects.toThrow("Object storage unavailable");
      expect(upload).toHaveBeenCalled();
    } finally { upload.mockRestore(); }
    expect(await fs.readFile(path.join(root, "bundle/probe.sh"), "utf8")).toBe("#!/bin/sh\nprintf kept\n");
    expect((await fs.stat(path.join(root, "bundle/probe.sh"))).mode & 0o777).toBe(0o751);
    expect(await fs.readFile(path.join(root, "bundle/nested/data.bin"))).toEqual(binary);
    expect((await fs.stat(path.join(root, "bundle/empty"))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(root, "bundle/.git/local-state"), "utf8")).toBe("Unlisted bytes\n");
    const [after] = await db.select().from(companySkills).where(eq(companySkills.id, skill.id));
    expect(after).toEqual(before);
    expect(await db.select({ id: companySkillVersions.id }).from(companySkillVersions)
      .where(eq(companySkillVersions.companySkillId, skill.id))).toEqual(versionsBefore);
    // Failed uploads keep a durable claim for reconciliation. Simulate its
    // expiry before retrying the same package with recovered storage.
    await db.update(snapshots).set({ upload: sql`jsonb_set(${snapshots.upload}, '{expiresAt}', to_jsonb(${new Date(0).toISOString()}::text))` })
      .where(and(eq(snapshots.companyId, companyId), sql`${snapshots.upload} is not null`));
    const deleted = await service.deleteFile(companyId, skill.id, input);
    expect(deleted.deletedPaths).toContain("bundle/probe.sh");
    await expect(fs.stat(path.join(root, input.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("Unrelated file\n");
    expect((await service.getVersion(companyId, skill.id, before!.currentVersionId!))!.fileInventory)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "bundle/probe.sh", executable: true })]));
  });

  it.each(["committed", "rolled_back", "newer_edit", "unavailable"] as const)("reconciles a lost deletion commit reply when %s", async outcome => {
    const companyId = await company();
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Commit reply", slug: "commit-reply", markdown: "# Keep\n" });
    await service.updateFile(companyId, skill.id, "notes.txt", "Original notes\n");
    await service.updateFile(companyId, skill.id, "keep.txt", "Keep\n");
    const before = (await service.getById(companyId, skill.id))!;
    let deletionFinished = false;
    let backupDirectory: string | undefined;
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const directory = await mkdtemp(...args);
      if (String(args[0]).includes("paperclip-skill-delete-")) backupDirectory = directory as string;
      return directory;
    });
    const ambiguousDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") return async (callback: (tx: any) => Promise<any>, ...options: any[]) => {
          if (deletionFinished && outcome === "unavailable") throw new Error("Database unavailable");
          const result = await target.transaction(async tx => {
            const value = await callback(tx);
            if (value?.deletedPaths) {
              deletionFinished = true;
              if (outcome === "rolled_back") throw new Error("Lost commit reply");
            }
            return value;
          }, ...options);
          if (!result?.deletedPaths) return result;
          if (outcome === "newer_edit") await service.updateFile(companyId, skill.id, "notes.txt", "Newer edit\n");
          throw new Error("Lost commit reply");
        };
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      await expect(companySkillService(ambiguousDb, { packageDb: db }).deleteFile(companyId, skill.id,
        { path: "notes.txt", target: "file" })).rejects.toThrow("Lost commit reply");
      expect(deletionFinished).toBe(true);
      const [saved] = await db.select().from(companySkills).where(eq(companySkills.id, skill.id));
      if (outcome === "rolled_back") {
        expect(saved!.currentVersionId).toBe(before.currentVersionId);
        expect(await fs.readFile(path.join(skill.sourceLocator!, "notes.txt"), "utf8")).toBe("Original notes\n");
      } else if (outcome === "newer_edit") {
        expect(await fs.readFile(path.join(skill.sourceLocator!, "notes.txt"), "utf8")).toBe("Newer edit\n");
      } else {
        expect(saved!.currentVersionId).not.toBe(before.currentVersionId);
        await expect(fs.stat(path.join(skill.sourceLocator!, "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (outcome === "unavailable" || outcome === "newer_edit") {
        expect(await fs.readFile(path.join(backupDirectory!, "source"), "utf8")).toBe("Original notes\n");
      } else await expect(fs.stat(backupDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (backupDirectory) await fs.rm(backupDirectory, { recursive: true, force: true });
    }
  });

  it("expires an unused Git package and reacquires its exact bytes without a migration command", async () => {
    const f = await fixture(true);
    const recipe = { version: 1 as const, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40), skillPath: null, manifest: skillPackageManifest(files) };
    await f.store.prepare(f.companyId, files, true, undefined, recipe);
    await f.store.files(f.companyId, f.id);
    await db.update(snapshots).set({ createdAt: new Date(Date.now() - 40 * 86_400_000), maintenanceAt: new Date(0), migrationAt: null }).where(eq(snapshots.id, f.id));
    // Current versions stay pinned even after their cache age expires.
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    expect((await f.store.descriptor(f.companyId, f.id)).storage).not.toBeNull();
    for (const { skill } of f.skills) await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, skill.id));
    await db.update(snapshots).set({ maintenanceAt: new Date(0) }).where(eq(snapshots.id, f.id));
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    expect((await f.store.descriptor(f.companyId, f.id)).storage).toBeNull();
    expect(await fs.stat(skillPackagePaths(f.companyId, f.id).directory).catch(() => null)).toBeNull();
    const entries = recipe.manifest.files.map((file, i) => ({ path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", size: file.size, sha: String(i).repeat(40) }));
    const read = Object.assign(vi.fn(async () => ({ id: 123 })), { openSnapshot: vi.fn(async () => ({ commitSha: recipe.commitSha, entries,
      readBlob: async (entry: typeof entries[number]) => skillFileBytes(files[entries.indexOf(entry)]!), release: async () => {} })) }) as unknown as GitHubRead;
    const authorization = vi.spyOn(recovery, "skillPackageRecoveryReader").mockResolvedValue(read);
    expect(await f.store.files(f.companyId, f.id)).toEqual(files);
    expect(read.openSnapshot).toHaveBeenCalledOnce();
    await f.store.files(f.companyId, f.id);
    expect(authorization).toHaveBeenCalledOnce();
    await fs.rm(skillPackagePaths(f.companyId, f.id).directory, { recursive: true });
    authorization.mockRejectedValue(new Error("grant revoked"));
    await expect(f.store.files(f.companyId, f.id)).rejects.toThrow("grant revoked");
    await expect(f.store.files(f.companyId, f.id)).rejects.toThrow("backoff");
    expect(authorization).toHaveBeenCalledTimes(2);
  });

  it("recovers missing archive and manifest objects while a published receipt still exists", async () => {
    const companyId = await company();
    const store = skillPackageStore(db, storage);
    const recipe = { version: 1 as const, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40), skillPath: null, manifest: skillPackageManifest(files) };
    const id = await store.prepare(companyId, files, true, undefined, recipe);
    const receipt = (await store.descriptor(companyId, id)).storage!;
    await storage.deleteObject(companyId, receipt.archiveKey);
    await storage.deleteObject(companyId, receipt.manifestKey);
    await expect(recovery.skillPackageRecoveryReader(db, companyId, recipe)).rejects.toThrow("Reconnect its original repository");
    const entries = recipe.manifest.files.map((file, i) => ({ path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", size: file.size, sha: String(i).repeat(40) }));
    const read = Object.assign(vi.fn(async () => ({ id: 123 })), { openSnapshot: vi.fn(async () => ({ commitSha: recipe.commitSha, entries,
      readBlob: async (entry: typeof entries[number]) => skillFileBytes(files[entries.indexOf(entry)]!), release: async () => {} })) }) as unknown as GitHubRead;
    vi.spyOn(recovery, "skillPackageRecoveryReader").mockResolvedValue(read);
    // PostgreSQL JSONB has reordered recipe object keys; its canonical bytes must
    // still agree with the original externally written manifest checksum.
    expect(await store.files(companyId, id)).toEqual(files);
    expect(read.openSnapshot).toHaveBeenCalledOnce();
  });

  it("retains referenced historical bytes without an exact Git recipe", async () => {
    const f = await fixture();
    for (const { skill } of f.skills) await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, skill.id));
    await db.update(snapshots).set({ createdAt: new Date(0), migrationAt: null, maintenanceAt: new Date(0) }).where(eq(snapshots.id, f.id));
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    expect((await f.store.descriptor(f.companyId, f.id)).storage).not.toBeNull();
    expect(await f.store.files(f.companyId, f.id)).toEqual(files);
  });

  it("retains authored history when a Git import shares its package and later loses access", async () => {
    const f = await fixture();
    const [authored] = await db.insert(companySkillVersions).values({ companyId: f.companyId, companySkillId: f.skills[0]!.skill.id,
      revisionNumber: 2, packageSnapshotId: f.id, migrationAt: null }).returning();
    const recipe = { version: 1 as const, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40), skillPath: null, manifest: skillPackageManifest(files) };
    expect(await f.store.prepare(f.companyId, files, true, undefined, recipe)).toBe(f.id);
    for (const { skill } of f.skills) await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, skill.id));
    await db.update(snapshots).set({ createdAt: new Date(0), migrationAt: null, maintenanceAt: new Date(0) }).where(eq(snapshots.id, f.id));
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    expect((await f.store.descriptor(f.companyId, f.id)).storage).not.toBeNull();
    await fs.rm(skillPackagePaths(f.companyId, f.id).directory, { recursive: true, force: true });
    const upstream = vi.spyOn(recovery, "skillPackageRecoveryReader").mockRejectedValue(new Error("grant revoked"));
    expect(await f.store.versionFiles(authored!)).toEqual(files);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps authored durability when it joins an in-flight Git package upload", async () => {
    const companyId = await company();
    const store = skillPackageStore(db, storage);
    const recipe = { version: 1 as const, sourceId: randomUUID(), repositoryId: "123", repositoryUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40), skillPath: null, manifest: skillPackageManifest(files) };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => { entered(); await blocked; return put(input); });
    const git = store.prepare(companyId, files, true, undefined, recipe);
    await uploading;
    const authored = store.prepare(companyId, files);
    release();
    const ids = await Promise.all([git, authored]);
    expect(ids[0]).toBe(ids[1]);
    expect((await store.descriptor(companyId, ids[0]!)).storage?.durable).toBe(true);
    expect(await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId))).toEqual([]);
  });

  it("preserves version kinds and encodings when identical package bytes are deduplicated", async () => {
    const companyId = await company();
    const original: CompanySkillVersionFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill", content: files[0]!.content },
      { path: "helper", kind: "other", content: "#!/bin/sh\necho same\n" }];
    const changed: CompanySkillVersionFileInventoryEntry[] = [original[0]!, { ...original[1]!, kind: "script", encoding: "base64",
      content: Buffer.from(original[1]!.content).toString("base64") }];
    const store = skillPackageStore(db, storage);
    const packageId = await store.prepare(companyId, original);
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
    const [skill] = await db.insert(companySkills).values({ companyId, key: "metadata", slug: "metadata", name: "Metadata", markdown: original[0]!.content }).returning();
    const service = companySkillService(db);
    const saved = await service.createVersion(companyId, skill!.id, {}, null, { skill: skill!, skipInventoryRefresh: true, fileInventory: changed });
    expect((await service.getVersion(companyId, skill!.id, saved.id))!.fileInventory).toEqual(changed);
    const [legacy] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 2, fileInventory: changed }).returning();
    await skillPackageMaintenance(db, storage).migrateVersions({ id: legacy!.id, apply: true, clearLegacy: true });
    const [converted] = await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, legacy!.id));
    expect(converted!.packageSnapshotId).toBe(packageId);
    expect(converted!.fileInventory).toEqual([]);
    expect(await store.versionFiles(converted!)).toEqual(changed);
  });

  it("does not delete an orphan whose expired upload was reclaimed after selection", async () => {
    const companyId = await company();
    const upload = { token: randomUUID(), provider: "local_disk" as const, archiveKey: `${companyId}/old/archive`, manifestKey: `${companyId}/old/manifest`, expiresAt: new Date(0).toISOString() };
    const [row] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), createdAt: new Date(0), upload }).returning();
    const renewed = { ...upload, token: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const racingDb = new Proxy(db, { get(target, key) {
      if (key !== "delete") return Reflect.get(target, key);
      return (table: typeof snapshots) => ({ where: (predicate: Parameters<ReturnType<typeof db.delete>["where"]>[0]) => ({ returning: async () => {
        await db.update(snapshots).set({ upload: renewed }).where(eq(snapshots.id, row!.id));
        return db.delete(table).where(predicate).returning({ id: snapshots.id });
      } }) });
    } });
    expect((await skillPackageMaintenance(racingDb, storage).collectOrphans({ companyId, apply: true })).removed).toBe(0);
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.id, row!.id));
    expect(saved!.upload).toEqual(renewed);
  });

  it("restores one shared archive, then prepares a warm turn without object reads or SQL file bodies", async () => {
    const f = await fixture();
    const read = vi.spyOn(storage, "getObject");
    const cold = await f.resolve();
    expect(cold.map(entry => entry.sourceStatus)).toEqual(["available", "available"]);
    expect(read.mock.calls.filter(call => call[1].endsWith("files.tar.gz"))).toHaveLength(1);
    expect(read.mock.calls.filter(call => call[1].endsWith("manifest.json"))).toHaveLength(1);
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, f.id));
    expect(row!.fileInventory).toEqual([]);
    const sql: string[] = [];
    const oldDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { sql.push(query); };
    read.mockClear();
    try { expect(await f.resolve()).toEqual(cold); }
    finally { db.$client.options.debug = oldDebug; }
    expect(read).not.toHaveBeenCalled();
    expect(sql.length).toBeLessThanOrEqual(6);
    for (const query of sql.filter(query => /from "company_skill_(repository_snapshots|versions)"/.test(query))) {
      // Bundled release validation returns only a DB-side digest.
      if (!query.includes("encode(sha256(")) expect(query).not.toMatch(/"file_inventory"/);
    }
    expect((await f.service.getVersion(f.companyId, f.skills[0]!.skill.id, f.skills[0]!.version.id))!.fileInventory)
      .toEqual([{ path: "SKILL.md", kind: "skill", content: files[0]!.content }]);
    const restored = await f.store.files(f.companyId, f.id);
    expect(restored.map(skillFileBytes)).toEqual(files.map(skillFileBytes));
    await expect(f.store.files(await company(), f.id)).rejects.toThrow("unavailable");
  });

  it("repairs a same-size cached edit and restores old versions without upstream access", async () => {
    const f = await fixture();
    const entries = await f.resolve();
    const target = path.join(entries[0]!.source, ".paperclip-repository/shared/run.sh");
    const stat = await fs.stat(target);
    await fs.chmod(target, 0o755);
    await fs.writeFile(target, "#!/bin/sh\necho modified\n");
    await fs.utimes(target, stat.atime, stat.mtime);
    const read = vi.spyOn(storage, "getObject");
    await f.resolve();
    expect(await fs.readFile(target, "utf8")).toBe(files[2]!.content);
    expect(read).not.toHaveBeenCalled();
    const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    for (const entry of entries) await fs.rm(entry.source, { recursive: true });
    await fs.rm(skillPackagePaths(f.companyId, f.id).directory, { recursive: true });
    expect((await f.resolve()).every(entry => entry.sourceStatus === "available")).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses cache eviction when durable objects are missing, even after an earlier verification", async () => {
    const f = await fixture();
    await f.resolve();
    expect(await hasRestorableSnapshot(db, f.companyId, f.skills[0]!.version.id)).toBe(true);
    const receipt = (await f.store.descriptor(f.companyId, f.id)).storage!;
    await storage.deleteObject(f.companyId, receipt.archiveKey);
    await expect(hasRestorableSnapshot(db, f.companyId, f.skills[0]!.version.id)).rejects.toThrow();
    // Existing local verified files remain usable while storage is unavailable.
    expect((await f.resolve()).every(entry => entry.sourceStatus === "available")).toBe(true);
  });

  it("reads verified cached versions offline while independently checking durable bytes and rejecting corrupt files", async () => {
    const f = await fixture();
    await f.store.files(f.companyId, f.id);
    const read = vi.spyOn(storage, "getObject").mockRejectedValue(new Error("storage offline"));
    const saved = f.skills[0]!;
    expect((await f.service.getVersion(f.companyId, saved.skill.id, saved.version.id))!.fileInventory)
      .toEqual([{ path: "SKILL.md", kind: "skill", content: files[0]!.content }]);
    expect(await f.store.versionFiles({ ...saved.version, packageFileMap: null })).toEqual(files);
    expect(read).not.toHaveBeenCalled();
    await expect(f.store.verifyDurable(f.companyId, f.id)).rejects.toThrow("storage offline");
    const target = path.join(skillPackagePaths(f.companyId, f.id).directory, files[0]!.path);
    await fs.chmod(target, 0o600);
    await fs.writeFile(target, "x".repeat(Buffer.byteLength(files[0]!.content)));
    await expect(f.store.versionFiles(saved.version)).rejects.toThrow("storage offline");
  });

  it("coalesces cold version reads and retains the verified package for subsequent reads", async () => {
    const f = await fixture();
    await f.resolve();
    const root = skillPackagePaths(f.companyId, f.id).directory;
    await fs.rm(root, { recursive: true });
    const read = vi.spyOn(storage, "getObject");
    const saved = f.skills[0]!;
    const get = () => f.service.getVersion(f.companyId, saved.skill.id, saved.version.id);
    const [first, second, third] = await Promise.all([get(), get(), get()]);
    expect(first!.fileInventory).toEqual([{ path: "SKILL.md", kind: "skill", content: files[0]!.content }]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await get()).toEqual(first);
    expect(await f.store.readVersionFile(saved.version, "SKILL.md")).toMatchObject({ content: files[0]!.content });
    expect(read.mock.calls.filter(call => call[1].endsWith("files.tar.gz"))).toHaveLength(1);
    expect(await verifySkillPackageDirectory(root, skillPackageManifest(files).files)).toBe(true);
  });

  it("shares a cold manifest while allowing one caller to cancel without aborting another", async () => {
    const f = await fixture();
    const get = storage.getObject.bind(storage);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let storageSignal: AbortSignal | undefined;
    const read = vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      storageSignal = args[2]?.signal;
      entered();
      await blocked;
      return get(...args);
    });
    const cancellation = new AbortController();
    const first = f.store.manifest(f.companyId, f.id, cancellation.signal).catch(error => error);
    await started;
    const second = f.store.manifest(f.companyId, f.id);
    try {
      // The shared one-slot pool places this query after the second descriptor.
      await db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.id, f.id));
      cancellation.abort(new Error("Caller stopped"));
      expect((await first).message).toBe("Caller stopped");
      expect(storageSignal?.aborted).toBe(false);
      release();
      expect(await second).toEqual(skillPackageManifest(files));
      expect(read).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([first, second]); }
  });

  it("keeps warm preparation responsive while a read-triggered cache trim verifies storage", async () => {
    const f = await fixture();
    await f.resolve();
    const paths = skillPackagePaths(f.companyId, f.id);
    // Exceed the directory bound without manufacturing large file payloads.
    for (let index = 0; index < 63; index++) {
      const orphan = path.join(paths.parent, randomUUID());
      await fs.mkdir(orphan);
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(orphan, later, later);
    }
    const changed = files.map((file, index) => index ? file : { ...file, content: `${file.content}Updated\n` });
    const id = await f.store.prepare(f.companyId, changed);
    const [version] = await db.insert(companySkillVersions).values({ companyId: f.companyId,
      companySkillId: f.skills[0]!.skill.id, revisionNumber: 2, packageSnapshotId: id, migrationAt: null,
      packageFileMap: f.skills[0]!.version.packageFileMap }).returning();
    const receipt = (await f.store.descriptor(f.companyId, f.id)).storage!;
    const get = storage.getObject.bind(storage);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (args[1] === receipt.manifestKey) { entered(); await blocked; }
      return get(...args);
    });
    const reading = f.store.versionFiles(version!);
    let warming: ReturnType<typeof f.resolve> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      warming = f.resolve();
      expect((await Promise.race([warming, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Warm preparation waited for eviction storage")), 1_000);
      })])).every(entry => entry.sourceStatus === "available")).toBe(true);
      // Preparation can reuse its separate projection. Also access the shared
      // package itself to prove eviction rechecks use after verification.
      await f.store.versionFiles(f.skills[0]!.version);
      release();
      expect((await reading)[0]!.content).toBe(changed[0]!.content);
      expect((await fs.stat(paths.directory)).isDirectory()).toBe(true);
    } finally { clearTimeout(timeout); release(); await Promise.allSettled([reading, warming]); }
  });

  it("bounds cold response lifetimes while cleanup is waiting without blocking warm preparation", async () => {
    const fixtures = [await fixture(), await fixture(), await fixture()];
    let bothEntered!: () => void;
    const started = new Promise<void>(resolve => { bothEntered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let decoded = 0;
    const trim = vi.spyOn(packageCache, "trimSkillPackageCache").mockImplementation(async () => {
      if (++decoded === 2) bothEntered();
      await blocked;
    });
    const reads = fixtures.slice(0, 2).map(f => f.store.versionFiles(f.skills[0]!.version));
    const storageRead = vi.spyOn(storage, "getObject");
    try {
      await started;
      reads.push(fixtures[2]!.store.versionFiles(fixtures[2]!.skills[0]!.version));
      expect((await fixtures[0]!.resolve()).every(entry => entry.sourceStatus === "available")).toBe(true);
      // Let the third metadata/manifest read settle. Its archive and response
      // must remain queued while two decoded responses are owned by cleanup.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(decoded).toBe(2);
      const third = (await fixtures[2]!.store.descriptor(fixtures[2]!.companyId, fixtures[2]!.id)).storage!;
      expect(storageRead.mock.calls.filter(call => call[1] === third.archiveKey)).toHaveLength(0);
      release();
      expect((await Promise.all(reads)).every(files => files[0]!.path === "SKILL.md")).toBe(true);
      expect(trim).toHaveBeenCalledTimes(3);
    } finally { release(); await Promise.allSettled(reads); }
  });

  it.each(["manifest", "files"] as const)("does not load queued legacy bodies for %s reads", async kind => {
    const f = await fixture();
    const companyId = await company();
    const rows = await db.insert(snapshots).values(Array.from({ length: 33 }, (_, index) => {
      const inventory = files.map((file, i) => i ? file : { ...file, content: `${file.content}${index}` });
      return { companyId, contentHash: skillSnapshotHash(inventory), fileInventory: inventory };
    })).returning({ id: snapshots.id });
    const store = skillPackageStore(db, storage);
    if (kind === "files") for (const row of rows) await store.manifest(companyId, row.id);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    const occupying = Array.from({ length: 2 }, () => f.store.withIsolatedPackage(f.companyId, f.id, async () => {
      active++;
      await blocked;
    }));
    await vi.waitFor(() => expect(active).toBe(2));
    let bodies = 0;
    const observe = (_connection: number, query: string) => {
      if (query.includes('"file_inventory"') && query.includes('"company_skill_repository_snapshots"')) bodies++;
    };
    const debug = db.$client.options.debug;
    db.$client.options.debug = observe;
    const dedicated = dbModule.withDedicatedDbConnection;
    let ready = 0;
    vi.spyOn(dbModule, "withDedicatedDbConnection").mockImplementation((owner, action) => dedicated(owner, connection => {
      connection.$client.options.debug = observe;
      if (kind === "files") ready++;
      return action(connection);
    }));
    if (kind === "manifest") {
      const parent = skillPackagePaths(companyId, rows[0]!.id).parent;
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (args[0] === parent) ready++;
        return result;
      });
    }
    const read = (id: string) => kind === "files" ? store.files(companyId, id, true) : store.manifest(companyId, id);
    const queued = rows.slice(0, 32).map(row => read(row.id));
    try {
      await vi.waitFor(() => expect(ready).toBe(32));
      // The final reader observes the full queue only after all earlier readers
      // have reached admission. None may preload repository bodies while waiting.
      await expect(read(rows[32]!.id)).rejects.toThrow("busy");
      expect(bodies).toBe(0);
      release();
      expect(await Promise.all(queued)).toHaveLength(32);
    } finally {
      release();
      await Promise.allSettled([...occupying, ...queued]);
      db.$client.options.debug = debug;
    }
  }, 15_000);

  it("does not deadlock a transaction behind cold reads on a one-connection pool", async () => {
    const fixtures = [await fixture(), await fixture(), await fixture()];
    const roots = new Map(fixtures.slice(0, 2).map(f => [skillPackagePaths(f.companyId, f.id).directory, 0]));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const lstat = fs.lstat.bind(fs);
    const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const root = String(args[0]);
      if (roots.has(root)) {
        roots.set(root, roots.get(root)! + 1);
        await blocked;
        throw Object.assign(new Error("Cold package"), { code: "ENOENT" });
      }
      return lstat(...args);
    });
    const reads = fixtures.slice(0, 2).map(f => f.store.versionFiles(f.skills[0]!.version));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Both callers have loaded metadata but have not entered cold fallback.
      await vi.waitFor(() => expect([...roots.values()]).toEqual([1, 1]));
      await db.transaction(async tx => {
        await tx.execute(sql`select 1`);
        release();
        // Their second cache misses now queue the cold fallback while this
        // transaction owns the only ordinary connection.
        await vi.waitFor(() => expect([...roots.values()]).toEqual([2, 2]));
        const cancellation = new AbortController();
        timeout = setTimeout(() => cancellation.abort(new Error("Cold read deadlocked the pool")), 1_000);
        const third = fixtures[2]!;
        expect(await skillPackageStore(tx as unknown as typeof db, storage, db)
          .versionFiles(third.skills[0]!.version, true, cancellation.signal))
          .toEqual([{ path: "SKILL.md", kind: "skill", content: files[0]!.content }]);
      });
    } finally {
      clearTimeout(timeout);
      release();
      stat.mockRestore();
      await Promise.allSettled(reads);
    }
    expect((await Promise.all(reads)).every(result => result[0]!.content === files[0]!.content)).toBe(true);
  });

  it("bounds concurrent cached inventories while leaving warm turn preparation responsive", async () => {
    const f = await fixture();
    await f.resolve();
    const target = path.join(skillPackagePaths(f.companyId, f.id).directory, files[0]!.path);
    const open = fs.open.bind(fs);
    let entered = 0;
    let bothEntered!: () => void;
    const started = new Promise<void>(resolve => { bothEntered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === target) {
        if (++entered === 2) bothEntered();
        await blocked;
      }
      return open(...args);
    });
    const version = { ...f.skills[0]!.version, packageFileMap: null };
    const storageRead = vi.spyOn(storage, "getObject");
    const reads = [f.store.versionFiles(version), f.store.versionFiles(version)];
    let preview: ReturnType<typeof f.store.readVersionFile> | undefined;
    try {
      await started;
      reads.push(f.store.versionFiles(version));
      preview = f.store.readVersionFile(version, files[0]!.path);
      reads.push(...Array.from({ length: 30 }, () => f.store.versionFiles(version)));
      // These queries share the one-connection pool, so the third inventory has
      // loaded its descriptor by the time preparation finishes. Its byte read
      // must still be queued behind the two active readers.
      expect((await f.resolve()).every(entry => entry.sourceStatus === "available")).toBe(true);
      expect(entered).toBe(2);
      await expect(f.store.versionFiles(version)).rejects.toThrow("busy");
      expect(storageRead).not.toHaveBeenCalled();
      release();
      expect(await Promise.all(reads)).toEqual(reads.map(() => files));
      expect(await preview).toMatchObject(files[0]!);
    } finally { release(); await Promise.allSettled([...reads, preview]); }
  });

  it("reads cached versions while both storage operations are stalled", async () => {
    const f = await fixture();
    await f.resolve();
    const get = storage.getObject.bind(storage);
    let entered = 0;
    let bothEntered!: () => void;
    const started = new Promise<void>(resolve => { bothEntered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (++entered === 2) bothEntered();
      await blocked;
      return get(...args);
    });
    const pending = [f.store.withIsolatedPackage(f.companyId, f.id, async () => null),
      f.store.withIsolatedPackage(f.companyId, f.id, async () => null)];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      const reading = db.transaction(tx => skillPackageStore(tx as unknown as typeof db, storage)
        .versionFiles({ ...f.skills[0]!.version, packageFileMap: null }));
      expect(await Promise.race([reading, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Cached read waited for storage")), 1_000);
      })])).toEqual(files);
    } finally { clearTimeout(timeout); release(); await Promise.allSettled(pending); }
  });

  it("retries expired upload claims with fresh keys and only deletes the abandoned attempt", async () => {
    const companyId = await company();
    const store = skillPackageStore(db, storage);
    const put = vi.spyOn(storage, "putFile").mockRejectedValueOnce(new Error("connection lost"));
    await expect(store.prepare(companyId, files)).rejects.toThrow("connection lost");
    put.mockRestore();
    const [pending] = await db.select().from(snapshots).where(eq(snapshots.companyId, companyId));
    expect(pending!.storage).toBeNull();
    await expect(store.prepare(companyId, files)).rejects.toThrow("being saved");
    await db.update(snapshots).set({ upload: { ...pending!.upload!, expiresAt: new Date(0).toISOString() } }).where(eq(snapshots.id, pending!.id));
    const id = await store.prepare(companyId, files);
    expect(id).toBe(pending!.id);
    const receipt = (await store.descriptor(companyId, id)).storage!;
    expect(receipt.archiveKey).not.toBe(pending!.upload!.archiveKey);
    const [deletion] = await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId));
    expect(deletion!.archiveKey).toBe(pending!.upload!.archiveKey);
    await db.update(skillPackageDeletions).set({ deleteAfter: new Date(0) }).where(eq(skillPackageDeletions.id, deletion!.id));
    expect((await skillPackageMaintenance(db, storage).deleteObjects({ companyId, apply: true })).removed).toBe(1);
    expect(await store.verifyDurable(companyId, id)).toBe(true);
    // Company cascades retain a receipt after removing the snapshot's DB row.
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.companyId, companyId)))
      .toEqual([expect.objectContaining({ archiveKey: receipt.archiveKey })]);
  });

  it("cancels queued and active uploads without publishing or leaking I/O capacity", async () => {
    const ids = await Promise.all([company(), company(), company()]);
    const active = new AbortController();
    const queued = new AbortController();
    const put = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      expect(input.signal).toBeDefined();
      await new Promise<void>((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      });
      throw new Error("Unreachable cancelled upload");
    });
    const store = skillPackageStore(db, storage);
    const running = ids.slice(0, 2).map(id => store.prepare(id!, files, false, active.signal).catch(error => error));
    try {
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
      const waiting = store.prepare(ids[2]!, files, false, queued.signal).catch(error => error);
      await vi.waitFor(async () => expect(await db.select({ id: snapshots.id }).from(snapshots)
        .where(eq(snapshots.companyId, ids[2]!))).toHaveLength(1));
      queued.abort(new Error("queued cancellation"));
      expect((await waiting).message).toBe("queued cancellation");
      expect(put).toHaveBeenCalledTimes(2);
    } finally {
      active.abort(new Error("active cancellation"));
      await Promise.all(running);
      put.mockRestore();
    }
    for (const id of ids) {
      const [row] = await db.select().from(snapshots).where(eq(snapshots.companyId, id!));
      expect(row!.storage).toBeNull();
      expect(row!.upload).not.toBeNull();
    }
    expect(await store.prepare(await company(), files)).toEqual(expect.any(String));
  });

  it("migrates both legacy payload locations in bounded resumable pages without changing version IDs", async () => {
    const companyId = await company();
    const [snapshot] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const [skill] = await db.insert(companySkills).values({ companyId, key: "legacy", slug: "legacy", name: "Legacy", markdown: files[0]!.content }).returning();
    const original = { path: "SKILL.md", kind: "skill" as const, content: files[0]!.content };
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id, revisionNumber: 7,
      repositorySnapshotId: snapshot!.id, repositorySkillPath: files[0]!.path, fileInventory: [original] }).returning();
    const maintenance = skillPackageMaintenance(db, storage);
    expect((await maintenance.migrateSnapshots({ companyId })).migrated).toBe(0);
    const fail = vi.spyOn(storage, "getObject").mockRejectedValueOnce(new Error("verification interrupted"));
    await expect(maintenance.migrateSnapshots({ companyId, apply: true })).rejects.toThrow("verification interrupted");
    fail.mockRestore();
    const [pending] = await db.select().from(snapshots).where(eq(snapshots.id, snapshot!.id));
    expect(pending!.fileInventory).toEqual(files);
    await db.update(snapshots).set({ upload: { ...pending!.upload!, expiresAt: new Date(0).toISOString() } }).where(eq(snapshots.id, snapshot!.id));
    expect((await maintenance.migrateSnapshots({ companyId, limit: 1, apply: true })).migrated).toBe(1);
    const [soaked] = await db.select().from(snapshots).where(eq(snapshots.id, snapshot!.id));
    expect(soaked!.storage).not.toBeNull();
    expect(soaked!.fileInventory).toEqual(files);
    expect((await maintenance.migrateSnapshots({ companyId, limit: 1, apply: true, clearLegacy: true })).migrated).toBe(1);
    expect((await maintenance.migrateSnapshots({ companyId, apply: true })).inspected).toBe(0);
    expect((await maintenance.migrateVersions({ companyId, apply: true, clearLegacy: true })).migrated).toBe(1);
    const [saved] = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.id, version!.id), eq(companySkillVersions.companyId, companyId)));
    expect(saved).toMatchObject({ id: version!.id, revisionNumber: 7, fileInventory: [], repositorySnapshotId: snapshot!.id, packageSnapshotId: snapshot!.id });
    expect(await skillPackageStore(db, storage).versionFiles(saved!)).toEqual([original]);
  });

  it.each([false, true])("restores across legacy payload clearing with a cached manifest: %s", async cachedManifest => {
    const companyId = await company();
    const [snapshot] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const store = skillPackageStore(db, storage);
    await withSkillPackageReadScope(db, async () => {
      expect((await store.descriptor(companyId, snapshot!.id)).storage).toBeNull();
      if (cachedManifest) await store.manifest(companyId, snapshot!.id);
      await store.prepare(companyId, files, true);
      await db.update(snapshots).set({ fileInventory: [] }).where(eq(snapshots.id, snapshot!.id));
      expect(skillSnapshotHash(await store.files(companyId, snapshot!.id))).toBe(skillSnapshotHash(files));
      expect(await store.verifyDurable(companyId, snapshot!.id)).toBe(true);
    });
  });

  it("bounds and validates archives, binaries, paths, executable modes, and corruption", async () => {
    const root = await fs.mkdtemp(path.join(home, "codec-"));
    const archive = path.join(root, "files.tar.gz");
    const manifest = skillPackageManifest(files);
    await writeSkillPackageArchive(archive, files);
    const output = path.join(root, "out");
    await fs.mkdir(output);
    await extractSkillPackageArchive(archive, output, manifest);
    expect(await verifySkillPackageDirectory(output, manifest.files)).toBe(true);
    expect((await fs.stat(path.join(output, "shared/run.sh"))).mode & 0o111).toBe(0o111);
    expect(() => validateSkillPackageManifest({ ...manifest, files: [{ ...manifest.files[0], path: "../escape" }] })).toThrow();
    expect(() => validateSkillPackageManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] })).toThrow();
    expect(() => validateSkillPackageManifest({ ...manifest, totalBytes: 1 })).toThrow();
    const boundary = { ...manifest, totalBytes: 100 * 1024 * 1024,
      files: [{ ...manifest.files[0]!, size: 100 * 1024 * 1024 }] };
    expect(validateSkillPackageManifest(boundary).totalBytes).toBe(boundary.totalBytes);
    expect(() => validateSkillPackageManifest({ ...boundary, totalBytes: boundary.totalBytes + 1,
      files: [{ ...boundary.files[0]!, size: boundary.totalBytes + 1 }] })).toThrow("byte bound");
    const bad = path.join(root, "bad");
    await fs.mkdir(bad);
    await fs.truncate(archive, 20);
    await expect(extractSkillPackageArchive(archive, bad, manifest)).rejects.toThrow();
  });

  it("stores and converts a saved directory package above 64 MiB without losing its history", async () => {
    const companyId = await company();
    const content = "x".repeat(1024 * 1024);
    const large = [{ path: "SKILL.md", kind: "skill" as const, content: "---\nname: large\n---\nlarge skill" },
      ...Array.from({ length: 65 }, (_, index) => ({ path: `asset-${index}`, kind: "asset" as const, content }))];
    const store = skillPackageStore(db, storage);
    const id = await store.prepare(companyId, large);
    const [skill] = await db.insert(companySkills).values({ companyId, key: "large", slug: "large", name: "Large", markdown: large[0]!.content }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skill!.id,
      revisionNumber: 1, fileInventory: large }).returning();
    await skillPackageMaintenance(db, storage).migrateVersions({ id: version!.id, apply: true, clearLegacy: true });
    const [converted] = await db.select().from(companySkillVersions).where(eq(companySkillVersions.id, version!.id));
    expect(converted!.fileInventory).toEqual([]);
    expect(converted!.migrationAt).toBeNull();
    expect(converted!.packageSnapshotId).toBe(id);
    expect(skillSnapshotHash(await store.versionFiles(converted!))).toBe(skillSnapshotHash(large));
  }, 90_000);
});
