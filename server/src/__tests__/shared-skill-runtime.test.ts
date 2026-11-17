import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySkills, companySkillVersions, companySkillRepositorySnapshots, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { companySkillService } from "../services/company-skills.js";
import { skillSnapshotHash } from "../services/skill-snapshot.js";
import { withSkillVersionCacheLock } from "../services/skill-version-cache.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("shared repository admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("shared-skill-admission-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "shared-skill-admission-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  it("pins repository metadata without creating a portable source or holding the company lock through consumption", async () => {
    const companyId = randomUUID(), skillId = randomUUID(), key = `company/${companyId}/one`;
    const files = [{ path: "skills/one/SKILL.md", kind: "skill" as const, content: "---\nname: one\ndescription: One\n---\nRead shared files.\n" }];
    await db.insert(companies).values({ id: companyId, name: "Shared fixture", issuePrefix: `SH${companyId.slice(0, 6)}` });
    await db.insert(companySkills).values({ id: skillId, companyId, key, slug: "one", name: "One", sourceType: "github", markdown: files[0]!.content });
    const [snapshot] = await db.insert(companySkillRepositorySnapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skillId, revisionNumber: 1, repositorySnapshotId: snapshot!.id, repositorySkillPath: files[0]!.path }).returning();
    await db.update(companySkills).set({ currentVersionId: version!.id }).where(eq(companySkills.id, skillId));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    let pinned = false;
    const work = companySkillService(db).withRuntimeSkillEntries(companyId, { onlyKeys: new Set([key]), snapshotLatest: true, repositoryLayout: "shared",
      selectVersions: async entries => { expect(entries[0]!.versionId).toBe(version!.id); pinned = true; return new Set([key]); } }, async entries => {
      expect(pinned).toBe(true);
      expect(entries[0]!.repository).toEqual({ companyId, skillId, versionId: version!.id, snapshotId: snapshot!.id, entryPath: files[0]!.path });
      expect(await fs.lstat(entries[0]!.source).catch(() => null)).toBeNull();
      entered(); await gate;
      return entries;
    });
    try {
      await Promise.race([started, work]);
      await withSkillVersionCacheLock(db, companyId, async () => undefined, true);
    } finally { release(); await work; }
  }, 30_000);
});
