import { touchSkillVersionCache } from "../services/skill-version-cache.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySkills,
  companySkillVersions,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import {
  resolveCompanySkillVersionsRoot,
  runVersionSnapshotFlight,
  skillVersionRetentionService,
} from "../services/skill-version-retention.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres skill version retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.chmod(target, 0o755);
  for (const entry of await fs.readdir(target)) await makeWritable(path.join(target, entry));
}

describeEmbeddedPostgres("skill version snapshot retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-version-retention-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-version-retention-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    if (paperclipHome) {
      const skillsRoot = path.join(paperclipHome, "instances", "default", "skills");
      await makeWritable(skillsRoot);
      await fs.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `R${companyId.slice(0, 6)}` });
    return companyId;
  }

  async function createSkill(companyId: string, versionCount: number, currentIndex = versionCount - 1) {
    const skillId = randomUUID();
    const key = `company/${companyId}/retained-${skillId.slice(0, 8)}`;
    await db.insert(companySkills).values({
      id: skillId, companyId, key, slug: `retained-${skillId.slice(0, 8)}`, name: "Retained",
      markdown: "# Retained", sourceType: "github", sourceLocator: "https://github.com/acme/retained",
      sourceRef: "a".repeat(40), trustLevel: "markdown_only", compatibility: "compatible",
      metadata: {}, fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    const versionIds: string[] = [];
    for (let index = 0; index < versionCount; index++) {
      const [version] = await db.insert(companySkillVersions).values({
        companyId, companySkillId: skillId, revisionNumber: index + 1, label: `v${index + 1}`,
        fileInventory: [
          { path: "SKILL.md", kind: "skill", content: `---\nname: retained\n---\n\n# Revision ${index + 1}\n` },
          { path: "references/notes.md", kind: "reference", content: `notes ${index + 1}` },
        ],
      }).returning({ id: companySkillVersions.id });
      versionIds.push(version!.id);
    }
    if (versionCount > 0) {
      await db.update(companySkills).set({ currentVersionId: versionIds[currentIndex]! })
        .where(eq(companySkills.id, skillId));
    }
    return { skillId, key, versionIds };
  }

  /** Writes a read-only snapshot directory like materializeVersionSnapshot does, aged by `ageMs`. */
  async function writeSnapshot(companyId: string, skillId: string, name: string, ageMs = 3 * HOUR_MS) {
    const dir = path.join(resolveCompanySkillVersionsRoot(companyId), skillId, name);
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Snapshot", { mode: 0o444 });
    await fs.writeFile(path.join(dir, "references", "notes.md"), "notes", { mode: 0o444 });
    await fs.chmod(path.join(dir, "references"), 0o555);
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    if (/^[a-f0-9-]{36}$/.test(name)) await touchSkillVersionCache(companyId, skillId, name, when.getTime());
    return dir;
  }

  it("keeps current, pinned, live-run, newest, and recent versions and removes superseded ones", async () => {
    const companyId = await createCompany();
    const { skillId, key, versionIds: v } = await createSkill(companyId, 7);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Pinned agent",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [{ key, versionId: v[0] }] } },
    }).returning({ id: agents.id });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agent!.id, status: "running", contextSnapshot: { skillVersions: { [key]: v[1] } } },
      { companyId, agentId: agent!.id, status: "succeeded", finishedAt: new Date(), contextSnapshot: { skillVersions: { [key]: v[2] } } },
    ]);
    const dirs = await Promise.all(v.map((id, index) => writeSnapshot(companyId, skillId, id, index === 3 ? 0 : 3 * HOUR_MS)));

    const result = await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 2 });

    // v1 pinned, v2 live run, v4 recent, v6 + v7 newest (v7 current).
    expect(await Promise.all(dirs.map(exists))).toEqual([true, true, false, true, false, true, true]);
    expect(result).toMatchObject({ removed: 2, removedOrphans: 0, skippedRecent: 1, failed: 0, truncated: false });
    // Rows are never deleted.
    expect(await db.select().from(companySkillVersions).where(eq(companySkillVersions.companySkillId, skillId))).toHaveLength(7);
  });

  it("removes orphan version folders, orphan skill folders, and stale staging folders", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const root = resolveCompanySkillVersionsRoot(companyId);
    const current = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const orphanVersion = await writeSnapshot(companyId, skillId, randomUUID());
    const orphanSkillId = randomUUID();
    const orphanSkillVersion = await writeSnapshot(companyId, orphanSkillId, randomUUID());
    const staleStaging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-abc123`);
    const freshStaging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-def456`, 0);
    const leftoverTrash = await writeSnapshot(companyId, skillId, `\.trash-${randomUUID()}`, 0);
    const unknown = await writeSnapshot(companyId, skillId, "operator-notes");
    const hidden = await writeSnapshot(companyId, skillId, ".notes");

    const result = await skillVersionRetentionService(db).pruneCompany(companyId);

    expect(await exists(current)).toBe(true);
    expect(await exists(orphanVersion)).toBe(false);
    expect(await exists(orphanSkillVersion)).toBe(false);
    expect(await fs.readdir(path.join(root, orphanSkillId))).toEqual([]);
    expect(await exists(staleStaging)).toBe(false);
    expect(await exists(freshStaging)).toBe(true);
    expect(await exists(leftoverTrash)).toBe(false);
    expect(await exists(unknown)).toBe(true);
    expect(await exists(hidden)).toBe(true);
    expect(result).toMatchObject({ removedOrphans: 2, removedStaging: 1, failed: 0 });
    expect((await fs.readdir(path.join(root, skillId))).filter(name => name.startsWith(".trash-"))).toEqual([]);
  });

  it("re-materializes a pruned version from its row on the next resolve", async () => {
    const companyId = await createCompany();
    const { key, versionIds } = await createSkill(companyId, 5);
    const svc = companySkillService(db);
    const selections = new Map([[key, versionIds[0]!]]);
    const first = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    expect(first.sourceStatus).toBe("available");
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await touchSkillVersionCache(companyId, path.basename(path.dirname(first.source)), path.basename(first.source), old.getTime());

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(first.source)).toBe(false);

    const again = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    expect(again).toMatchObject({ sourceStatus: "available", source: first.source });
    expect(await fs.readFile(path.join(again.source, "SKILL.md"), "utf8")).toContain("# Revision 1");
  });

  it("refreshes the age of a reused snapshot so the grace window protects it", async () => {
    const companyId = await createCompany();
    const { key, versionIds } = await createSkill(companyId, 5);
    const svc = companySkillService(db);
    const selections = new Map([[key, versionIds[0]!]]);
    const first = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await touchSkillVersionCache(companyId, path.basename(path.dirname(first.source)), path.basename(first.source), old.getTime());
    await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections });

    const result = await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(result.skippedRecent).toBe(1);
    expect(await exists(first.source)).toBe(true);
  });

  it("skips a version folder while a materialization holds it", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 3);
    const dir = await writeSnapshot(companyId, skillId, versionIds[0]!);
    let release!: () => void;
    const held = runVersionSnapshotFlight(dir, () => new Promise<string>(resolve => { release = () => resolve(dir); }));

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(dir)).toBe(true);
    release();
    await held;
    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(dir)).toBe(false);
  });

  it("sweeps deleted skills after protecting existing runs", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const first = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const second = await writeSnapshot(companyId, skillId, versionIds[1]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Detached agent" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running",
      contextSnapshot: { skillVersions: { retained: versionIds[0] } } }).returning();
    await companySkillService(db).deleteSkill(companyId, skillId);
    expect(await exists(first)).toBe(true);
    await skillVersionRetentionService(db).pruneCompany(companyId);
    expect(await exists(first)).toBe(true);
    expect(await exists(second)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    await skillVersionRetentionService(db).pruneCompany(companyId);
    expect(await exists(first)).toBe(false);
  });

  it("never removes anything outside the company's versions root", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 3);
    const other = await createSkill(otherCompanyId, 3);
    const otherDirs = await Promise.all(other.versionIds.map(id => writeSnapshot(otherCompanyId, other.skillId, id)));
    const outside = await fs.mkdtemp(path.join(paperclipHome!, "outside-"));
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    const root = resolveCompanySkillVersionsRoot(companyId);
    const victim = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const safe = await writeSnapshot(companyId, skillId, versionIds[1]!);
    await fs.chmod(victim, 0o755);
    await fs.symlink(outside, path.join(victim, "escape"));
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await fs.utimes(victim, old, old);
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, randomUUID()));
    await fs.symlink(outside, path.join(root, skillId, randomUUID()));

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });

    expect(await exists(victim)).toBe(true);
    expect(await exists(safe)).toBe(false);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await Promise.all(otherDirs.map(exists))).toEqual([true, true, true]);
  });

  it("bounds removals per tick and continues on the next tick", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 6);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const retention = skillVersionRetentionService(db, { keepNewest: 1, maxRemovals: 2 });

    let total = 0;
    for (let index = 0; index < 5; index++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(2);
      total += result.removed;
      if (!result.truncated) break;
    }
    expect(total).toBe(5);
    expect(await fs.readdir(path.join(resolveCompanySkillVersionsRoot(companyId), skillId))).toEqual([versionIds[5]]);
  });
  it("bounds directory reads and retains the discovery cursor between pages", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 100);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const parent = path.join(resolveCompanySkillVersionsRoot(companyId), skillId);
    const originalOpen = fs.opendir.bind(fs);
    let reads = 0;
    const opened = vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await originalOpen(...args);
      const read = directory.read.bind(directory);
      vi.spyOn(directory, "read").mockImplementation(async () => { reads++; return read(); });
      return directory;
    });
    const stat = vi.spyOn(fs, "lstat");
    const retention = skillVersionRetentionService(db, { maxEntries: 2, dryRun: true });
    try {
      const first = await retention.tick();
      expect(first).toMatchObject({ checked: 2, truncated: true });
      expect(reads).toBeLessThanOrEqual(2);
      const inspected = () => new Set(stat.mock.calls.map(call => String(call[0]))
        .filter(file => path.dirname(file) === parent).map(file => path.basename(file)));
      const firstPaths = inspected();
      expect(firstPaths.size).toBe(1); // Opening the skill root also consumes a slot.
      stat.mockClear(); reads = 0;
      const second = await retention.tick();
      expect(second).toMatchObject({ checked: 2, truncated: true });
      expect(reads).toBe(2);
      expect(inspected().size).toBe(2);
      expect([...inspected()].some(name => firstPaths.has(name))).toBe(false);
      expect(opened.mock.calls.filter(call => call[0] === parent)).toHaveLength(1);
    } finally { await retention.dispose(); }
  });

  it("continues beyond a page ending at an exhausted skill root", async () => {
    const companyId = await createCompany();
    const roots = [1, 2, 3].map(value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
    await Promise.all([randomUUID(), randomUUID()].map(id => writeSnapshot(companyId, roots[0]!, id, 0)));
    await fs.mkdir(path.join(resolveCompanySkillVersionsRoot(companyId), roots[1]!), { recursive: true });
    const versions = Array.from({ length: 5 }, () => randomUUID()).sort();
    const paths = await Promise.all(versions.map((id, index) => writeSnapshot(companyId, roots[2]!, id, index === 4 ? 3 * HOUR_MS : 0)));
    const retention = skillVersionRetentionService(db, { maxEntries: 3 });
    let reclaimed = 0;
    for (let page = 0; page < 5; page++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(3);
      reclaimed += result.removed;
      if (!result.truncated) break;
    }
    expect(reclaimed).toBe(1);
    expect(await exists(paths[4]!)).toBe(false);
    expect(await Promise.all(paths.slice(0, 4).map(exists))).toEqual([true, true, true, true]);
  });

  it("bounds failed attempts and continues beyond them", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 6);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("read-only fixture"), { code: "EACCES" }));
    const retention = skillVersionRetentionService(db, { maxRemovals: 2 });
    let checked = 0;
    let failures = 0;
    for (let index = 0; index < 5; index++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(2);
      checked += result.checked;
      failures += result.failed;
      if (!result.truncated) break;
    }
    expect(checked).toBe(7); // Six versions plus the skill-root discovery slot.
    expect(failures).toBe(5);
    expect(rename).toHaveBeenCalledTimes(5);
  });

});
