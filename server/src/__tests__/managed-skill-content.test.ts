import { skillInstallationMaintenance } from "../services/skill-installation-maintenance.js";
import { removeRuntimeAssetTree } from "../services/native-runtime/runtime-asset-retention.js";
import { eq } from "drizzle-orm";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { materializeSelectedSkills, rehydratePinnedSkillAssets } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, agents, heartbeatRuns, companySkills, companies, createDb } from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalDatabase = process.env.PAPERCLIP_SKILL_TEST_DATABASE_URL;
const support = externalDatabase ? { supported: true } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn("Managed skill integration database unavailable:", support);
describe.skipIf(!support.supported)("managed skills use committed versions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const previousStorage = process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;
  beforeAll(async () => {
    if (externalDatabase) {
      await applyPendingMigrations(externalDatabase);
      database = { connectionString: externalDatabase, cleanup: async () => {} };
    } else database = await startEmbeddedPostgresTestDatabase("managed-skill-content-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-skill-content-"));
    home = path.join(root, "server-a");
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = "true";
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(
      createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))),
    );
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousStorage === undefined) delete process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;
    else process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = previousStorage;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (root) await removeRuntimeAssetTree(root);
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
  });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Managed content", issuePrefix: `M${id.slice(0, 6)}` });
    return id;
  }

  it("imports supporting files from a root-level package without truncating their paths", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const [imported] = await service.importPackageFiles(companyId, {
      "SKILL.md": "---\nname: Root package\n---\n# Root\n",
      "references/guide.md": "complete root guide",
    });
    expect(imported).toBeTruthy();
    const skills = await service.list(companyId);
    const skill = skills.find(entry => entry.name === "Root package")!;
    expect(await service.readFile(companyId, skill.id, "references/guide.md"))
      .toMatchObject({ content: "complete root guide" });
  });

  it("forks live linked-local content even when an older saved version exists", async () => {
    const companyId = await company();
    const directory = path.join(root, `linked-${randomUUID()}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "SKILL.md"), "# Linked\n");
    await fs.writeFile(path.join(directory, "support.txt"), "old saved content");
    const [linked] = await db.insert(companySkills).values({ companyId, key: "linked", slug: "linked", name: "Linked",
      markdown: "# Linked\n", sourceType: "local_path", sourceLocator: directory,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }, { path: "support.txt", kind: "other" }] }).returning();
    const service = companySkillService(db);
    const saved = await service.createVersion(companyId, linked!.id);
    await fs.writeFile(path.join(directory, "support.txt"), "current local content");
    const forked = await service.createLocalSkill(companyId, { name: "Live fork", forkedFromSkillId: linked!.id });
    expect(await service.readFile(companyId, forked.id, "support.txt")).toMatchObject({ content: "current local content" });
    expect((await service.getVersion(companyId, linked!.id, saved.id))?.fileInventory)
      .toContainEqual(expect.objectContaining({ path: "support.txt", content: "old saved content" }));
  });

  it("keeps an unassigned skill, supporting bytes and executable mode across fresh homes", async () => {
    const companyId = await company();
    const a = companySkillService(db);
    const skill = await a.createLocalSkill(companyId, { name: "Cold", slug: "cold", markdown: "# First\n" });
    expect(skill.sourceType).toBe("managed");
    expect(skill.sourceLocator).toBeNull();
    expect(skill.currentVersionId).toBeTruthy();
    await expect(fs.stat(path.join(home, "instances/default/skills", companyId, "cold"))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await a.updateFile(companyId, skill.id, "scripts/run.sh", "#!/bin/sh\necho cold\n", null,
      { executable: true, expectedVersionId: skill.currentVersionId });
    const binary = await a.updateFile(companyId, skill.id, "data.bin", "AP8H", null,
      { encoding: "base64", expectedVersionId: saved.versionId });
    await fs.rm(home, { recursive: true, force: true });
    process.env.PAPERCLIP_HOME = path.join(root, "server-b");
    const b = companySkillService(db);
    expect((await b.list(companyId)).some(item => item.id === skill.id)).toBe(true);
    expect(await b.readFile(companyId, skill.id, "data.bin")).toMatchObject({ content: "AP8H", encoding: "base64", versionId: binary.versionId });
    const updated = await b.updateFile(companyId, skill.id, "SKILL.md", "# Saved on B\n", null, { expectedVersionId: binary.versionId });
    const [runtime] = await b.listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]), snapshotLatest: true });
    expect(runtime).toMatchObject({ versionId: updated.versionId, sourceStatus: "available" });
    expect((await fs.stat(path.join(runtime!.source, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
    expect(await fs.readFile(path.join(runtime!.source, "data.bin"))).toEqual(Buffer.from([0, 255, 7]));
    await fs.rm(process.env.PAPERCLIP_HOME, { recursive: true, force: true });
    process.env.PAPERCLIP_HOME = path.join(root, "server-c");
    expect(await companySkillService(db).readFile(companyId, skill.id, "SKILL.md"))
      .toMatchObject({ content: "# Saved on B\n", versionId: updated.versionId });
    expect(await a.readFile(companyId, skill.id, "SKILL.md")).toMatchObject({ versionId: updated.versionId });
  });

  it("rejects a save whose base changed while its package was being prepared", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Race" });
    await expect(service.updateFile(companyId, skill.id, "first.md", "first", null, { publication: {
      beforeLock: async () => { await service.updateFile(companyId, skill.id, "second.md", "second"); },
    } })).rejects.toMatchObject({ status: 409 });
    expect(await service.readFile(companyId, skill.id, "second.md")).toMatchObject({ content: "second" });
    await expect(service.readFile(companyId, skill.id, "first.md")).rejects.toMatchObject({ status: 404 });
    await expect(service.updateFile(companyId, skill.id, "first.md", "stale", null,
      { expectedVersionId: skill.currentVersionId })).rejects.toMatchObject({ status: 409 });
  });

  it("rolls back publication without changing the head or an existing version", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Rollback", markdown: "# Original" });
    await expect(service.updateFile(companyId, skill.id, "SKILL.md", "# Rejected", null,
      { publication: { afterPublish: async () => { throw new Error("failed audit"); } } })).rejects.toThrow("failed audit");
    expect(await service.readFile(companyId, skill.id, "SKILL.md")).toMatchObject({ content: "# Original", versionId: skill.currentVersionId });
    expect(await service.listVersions(companyId, skill.id)).toHaveLength(1);
  });

  it("restores the exact historical inventory and preserves history through rename and fork", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "History", markdown: "# Original" });
    const extra = await service.updateFile(companyId, skill.id, "new.md", "not in first version");
    const restored = await service.createVersion(companyId, skill.id,
      { sourceVersionId: skill.currentVersionId!, expectedVersionId: extra.versionId });
    await expect(service.readFile(companyId, skill.id, "new.md")).rejects.toMatchObject({ status: 404 });
    const renamed = await service.renameSkill(companyId, skill.id, { name: "Renamed", expectedVersionId: restored.id });
    expect(renamed.skill).toMatchObject({ id: skill.id, sourceType: "managed", sourceLocator: null });
    expect((await service.getVersion(companyId, skill.id, skill.currentVersionId!))!.fileInventory)
      .toContainEqual({ path: "SKILL.md", kind: "skill", content: "# Original" });
    const fork = await service.forkSkill(companyId, skill.id);
    expect(fork.skill).toMatchObject({ sourceType: "managed", sourceLocator: null, forkedFromSkillId: skill.id });
    expect((await service.readFile(companyId, fork.skill.id, "SKILL.md"))!.content)
      .toBe((await service.readFile(companyId, skill.id, "SKILL.md"))!.content);
  });
  it("persists selection before delivery and rejects deleting a detached active run's pin", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Pinned", markdown: "# pinned bytes" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Runner" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running" }).returning();
    let persisted = false;
    const entries = await service.withRuntimeSkillEntries(companyId, {
      onlyKeys: new Set([skill.key]), snapshotLatest: true,
      selectVersions: async selected => {
        expect(selected).toEqual([expect.objectContaining({ skillId: skill.id, versionId: skill.currentVersionId })]);
        expect(selected[0]).not.toHaveProperty("source");
        await expect(fs.stat(path.join(process.env.PAPERCLIP_HOME!, "instances/default/skills", companyId,
          "__versions__", skill.id, skill.currentVersionId!))).rejects.toMatchObject({ code: "ENOENT" });
        await db.update(heartbeatRuns).set({ contextSnapshot: { skillVersions: { [skill.key]: skill.currentVersionId }, skillSelectionSnapshot: true } })
          .where(eq(heartbeatRuns.id, run!.id));
        persisted = true;
        return new Set([skill.key]);
      },
    }, async entries => { expect(persisted).toBe(true); return entries; });
    const config = writePaperclipSkillSyncPreference({}, [{ key: skill.key, versionId: skill.currentVersionId }]);
    const selected = await materializeSelectedSkills(config, entries, false);
    const context = { ...nativeRuntimeContextFixture(), skills: selected };
    const originalHome = process.env.PAPERCLIP_HOME!;
    process.env.PAPERCLIP_HOME = path.join(root, `recovery-${randomUUID()}`);
    const recovered = await rehydratePinnedSkillAssets(db, { companyId, agentId: agent!.id, runId: run!.id }, context);
    expect(recovered.skills[0]!.bundle.digest).toBe(selected[0]!.bundle.digest);
    expect(recovered.skills[0]!.bundle.rootPath).not.toBe(selected[0]!.bundle.rootPath);
    expect(await fs.readFile(path.join(recovered.skills[0]!.bundle.rootPath, "SKILL.md"), "utf8")).toBe("# pinned bytes");
    await expect(rehydratePinnedSkillAssets(db, { companyId, agentId: agent!.id, runId: run!.id }, {
      ...context, skills: [{ ...selected[0]!, bundle: { ...selected[0]!.bundle, digest: "0".repeat(64) } }],
    })).rejects.toThrow("admitted digest");
    await expect(service.deleteSkill(companyId, skill.id)).rejects.toMatchObject({ status: 422 });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    await expect(service.deleteSkill(companyId, skill.id)).resolves.toMatchObject({ id: skill.id });
    process.env.PAPERCLIP_HOME = originalHome;
  });

  it("converts a legacy managed installation without changing its identity or identical version", async () => {
    const companyId = await company();
    const directory = path.join(root, `legacy-${randomUUID()}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "SKILL.md"), "# legacy saved");
    await fs.writeFile(path.join(directory, "support.txt"), "support");
    const [legacy] = await db.insert(companySkills).values({ companyId, key: `company/${companyId}/legacy`, slug: "legacy",
      name: "Legacy", markdown: "# legacy saved", sourceType: "local_path", sourceLocator: directory,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }, { path: "support.txt", kind: "other" }],
      metadata: { sourceKind: "managed_local" } }).returning();
    const service = companySkillService(db);
    const version = await service.createVersion(companyId, legacy!.id);
    const maintenance = skillInstallationMaintenance(db);
    expect((await maintenance.installations({ id: legacy!.id })).results[0]!.status).toBe("conversion_required");
    await expect(maintenance.installations({ companyId, apply: true })).rejects.toMatchObject({ status: 409 });
    expect((await maintenance.installations({ id: legacy!.id, apply: true, writersStopped: true })).results)
      .toEqual([expect.objectContaining({ skillId: legacy!.id, versionId: version.id, status: "converted" })]);
    await fs.rm(directory, { recursive: true });
    expect(await service.getById(companyId, legacy!.id)).toMatchObject({ sourceType: "managed", sourceLocator: null, currentVersionId: version.id });
    expect(await service.readFile(companyId, legacy!.id, "support.txt")).toMatchObject({ content: "support" });
    expect((await maintenance.eligibility({ id: legacy!.id })).results[0]!.status).toBe("version_backed");
  });

  it("reports an unrecoverable legacy installation and leaves linked sources alone", async () => {
    const companyId = await company();
    const [legacy] = await db.insert(companySkills).values({ companyId, key: "legacy-missing", slug: "legacy-missing", name: "Missing",
      markdown: "partial metadata only", sourceType: "local_path", sourceLocator: path.join(root, "absent"),
      metadata: { sourceKind: "managed_local" } }).returning();
    const [linked] = await db.insert(companySkills).values({ companyId, key: "linked", slug: "linked", name: "Linked",
      markdown: "# Linked", sourceType: "local_path", sourceLocator: path.join(root, "linked") }).returning();
    const report = await skillInstallationMaintenance(db).installations({ companyId, apply: true, writersStopped: true });
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: legacy!.id, status: "blocked" }),
      expect.objectContaining({ skillId: linked!.id, status: "linked_local" }),
    ]));
    expect(await companySkillService(db).getById(companyId, legacy!.id)).toMatchObject({ sourceType: "local_path", currentVersionId: null });
  });

  it("converts a missing legacy directory from its complete saved version", async () => {
    const companyId = await company();
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Saved conversion", markdown: "# saved" });
    const saved = await service.updateFile(companyId, skill.id, "support.txt", "complete supporting content");
    await db.update(companySkills).set({ sourceType: "local_path", sourceLocator: path.join(root, "missing-legacy"),
      metadata: { sourceKind: "managed_local" } }).where(eq(companySkills.id, skill.id));
    const maintenance = skillInstallationMaintenance(db);
    expect((await maintenance.installations({ id: skill.id, apply: true, writersStopped: true })).results)
      .toEqual([expect.objectContaining({ skillId: skill.id, versionId: saved.versionId, status: "converted" })]);
    expect((await maintenance.installations({ id: skill.id, apply: true, writersStopped: true })).results[0]!.status).toBe("unchanged");
    expect(await service.readFile(companyId, skill.id, "support.txt")).toMatchObject({ content: "complete supporting content" });
  });

  it("rejects unsafe legacy sources without publishing a partial conversion", async () => {
    const companyId = await company();
    const directory = path.join(root, `unsafe-${randomUUID()}`);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "SKILL.md"), "# legacy");
    await fs.symlink(path.join(root, "unrelated"), path.join(directory, "support.txt"));
    try {
      const [legacy] = await db.insert(companySkills).values({ companyId, key: "unsafe", slug: "unsafe", name: "Unsafe", markdown: "# legacy",
        sourceType: "local_path", sourceLocator: directory, metadata: { sourceKind: "managed_local" } }).returning();
      expect((await skillInstallationMaintenance(db).installations({ id: legacy!.id, apply: true, writersStopped: true })).results)
        .toEqual([expect.objectContaining({ status: "blocked", reason: "Legacy skill contains a symbolic link" })]);
      expect(await companySkillService(db).getById(companyId, legacy!.id)).toMatchObject({ sourceType: "local_path", currentVersionId: null });
    } finally { await fs.unlink(path.join(directory, "support.txt")); }
  });

  it("keeps the compatibility override durable in Postgres and reports that storage accurately", async () => {
    const companyId = await company();
    process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = "false";
    try {
      const service = companySkillService(db);
      const skill = await service.createLocalSkill(companyId, { name: "Inline durable", markdown: "# database bytes" });
      const saved = await service.updateFile(companyId, skill.id, "support.txt", "also in Postgres");
      expect((await skillInstallationMaintenance(db).verifyVersions({ id: saved.versionId! })).results)
        .toEqual([expect.objectContaining({ status: "database_snapshot", packageId: null })]);
      const priorHome = process.env.PAPERCLIP_HOME;
      process.env.PAPERCLIP_HOME = path.join(root, `inline-cold-${randomUUID()}`);
      try {
        expect(await companySkillService(db).readFile(companyId, skill.id, "support.txt")).toMatchObject({ content: "also in Postgres" });
      } finally { process.env.PAPERCLIP_HOME = priorHome; }
    } finally { process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = "true"; }
  });

});
