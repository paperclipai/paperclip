import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { companySkills, companySkillVersions, type Db } from "@paperclipai/db";
import { parseFrontmatterMarkdown, type CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { classifyInventoryKind, companySkillService } from "./company-skills.js";
import { managedSkillContent } from "./managed-skill-content.js";
import { skillPackageStore, skillVersionMetadataColumns } from "./skill-package-store.js";
import { skillPackageMaintenance } from "./skill-package-maintenance.js";
import { skillPackageManifest } from "./skill-package-files.js";
import { assertSkillSnapshotPath, MAX_SKILL_SNAPSHOT_BYTES, MAX_SKILL_SNAPSHOT_FILES, skillSnapshotHash, snapshotFile } from "./skill-snapshot.js";
import { protectedVersions, withSkillVersionCacheLock } from "./skill-version-cache.js";
import { getStorageService, type StorageService } from "../storage/index.js";

type Page = { companyId?: string; after?: string; id?: string; limit?: number; signal?: AbortSignal };
type Conversion = Page & { apply?: boolean; writersStopped?: boolean };
const limit = (options: Page) => Math.min(50, Math.max(1, options.limit ?? 10));
const legacyManaged = (skill: typeof companySkills.$inferSelect) => skill.sourceType === "local_path" && skill.metadata?.sourceKind === "managed_local";
const linkedLocal = (skill: typeof companySkills.$inferSelect) => skill.sourceType === "local_path"
  && !legacyManaged(skill) && skill.metadata?.sourceKind !== "paperclip_bundled";

async function legacyFiles(skill: typeof companySkills.$inferSelect, signal?: AbortSignal) {
  if (!skill.sourceLocator || !path.isAbsolute(skill.sourceLocator)) return null;
  const source = path.resolve(skill.sourceLocator);
  const root = path.basename(source) === "SKILL.md" ? path.dirname(source) : source;
  const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Legacy skill root is not a safe directory");
  const files: CompanySkillVersionFileInventoryEntry[] = [];
  let bytes = 0;
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Legacy skill contains a symbolic link");
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new Error("Legacy skill contains an unsupported file");
      const relative = assertSkillSnapshotPath(path.relative(root, absolute).split(path.sep).join("/"));
      const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Legacy skill contains an unsupported file");
        bytes += stat.size;
        if (files.length >= MAX_SKILL_SNAPSHOT_FILES || bytes > MAX_SKILL_SNAPSHOT_BYTES) throw new Error("Legacy skill exceeds package limits");
        const body = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < body.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
          if (!bytesRead) throw new Error("Legacy skill changed during conversion");
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Legacy skill changed during conversion");
        files.push(snapshotFile(relative, classifyInventoryKind(relative), body, Boolean(stat.mode & 0o111)));
      } finally { await handle.close(); }
    }
  }
  await visit(root);
  if (!files.some(file => file.path === "SKILL.md" && file.encoding !== "base64")) throw new Error("Legacy skill is missing UTF-8 SKILL.md");
  return files;
}

export function skillInstallationMaintenance(db: Db, storage?: StorageService) {
  const store = skillPackageStore(db, storage);
  const content = managedSkillContent(db, db, storage);
  const provider = () => (storage ?? getStorageService()).provider;
  function scope(options: Page) {
    return and(options.companyId ? eq(companySkills.companyId, options.companyId) : undefined,
      options.id ? eq(companySkills.id, options.id) : undefined,
      options.after ? gt(companySkills.id, options.after) : undefined);
  }
  async function installations(options: Conversion = {}) {
    if (options.apply && !options.writersStopped) throw conflict("Installation conversion requires stopped admission and retired legacy writers (--writers-stopped).");
    const skills = await db.select().from(companySkills).where(scope(options)).orderBy(asc(companySkills.id)).limit(limit(options));
    const results: Array<{ skillId: string; companyId: string; status: string; versionId?: string | null; reason?: string }> = [];
    for (const skill of skills) {
      options.signal?.throwIfAborted();
      const catalogOrigin = skill.sourceType === "catalog" && !skill.metadata?.originVersionId;
      const needsConversion = legacyManaged(skill) || catalogOrigin || !skill.currentVersionId;
      if (linkedLocal(skill) || !needsConversion) {
        results.push({ skillId: skill.id, companyId: skill.companyId, status: linkedLocal(skill) ? "linked_local" : "unchanged", versionId: skill.currentVersionId });
        continue;
      }
      try {
        const pins = await protectedVersions(db, skill.companyId);
        if (pins.versions === null) throw new Error("Active run lacks an exact durable skill selection; settle or snapshot it on the legacy server first");
        const version = skill.currentVersionId ? await store.version(skill.companyId, skill.id, skill.currentVersionId) : null;
        const saved = version ? await store.versionFiles(version) : null;
        const local = await legacyFiles(skill, options.signal);
        const files = local ?? saved ?? ((skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url")
          ? await companySkillService(db).captureLegacyInstallation(skill.companyId, skill.id) : null);
        const origin = catalogOrigin && typeof skill.metadata?.originSnapshotLocator === "string"
          ? await legacyFiles({ ...skill, sourceLocator: skill.metadata.originSnapshotLocator }, options.signal) : null;
        if (catalogOrigin && !origin && skill.metadata?.userModifiedAt) {
          throw new Error("Catalog reset snapshot is unavailable; preserve the original installed package before conversion");
        }
        if (!files?.length || !files.some(file => file.path === "SKILL.md")) throw new Error("Neither complete legacy files nor a saved version is available");
        if (!local && skill.fileInventory.some(file => !files.some(saved => saved.path === file.path))) {
          throw new Error("Saved version does not cover the installed inventory");
        }
        if (!options.apply) {
          results.push({ skillId: skill.id, companyId: skill.companyId, status: "conversion_required", versionId: skill.currentVersionId });
          continue;
        }
        if (version && saved && !version.packageSnapshotId && skillSnapshotHash(saved) === skillSnapshotHash(files)) {
          await skillPackageMaintenance(db, storage).migrateVersions({ id: version.id, apply: true, clearLegacy: true, signal: options.signal });
        }
        const candidate = await content.prepare(skill.companyId, files, options.signal);
        if (!candidate.packageSnapshotId || !await store.verifyDurable(skill.companyId, candidate.packageSnapshotId, options.signal)) {
          throw new Error("Final snapshot is not independently recoverable from object storage");
        }
        let originVersionId = typeof skill.metadata?.originVersionId === "string" ? skill.metadata.originVersionId : null;
        if (catalogOrigin && origin && skillSnapshotHash(origin) !== skillSnapshotHash(files)) {
          originVersionId = (await companySkillService(db).createVersion(skill.companyId, skill.id,
            { label: "Original catalog package" }, { type: "system" }, {
              fileInventory: origin, updateCurrentVersion: false, skipInventoryRefresh: true,
            })).id;
        }
        const markdown = files.find(file => file.path === "SKILL.md")!.content;
        const parsed = parseFrontmatterMarkdown(markdown);
        const { missingSource: _missing, ...metadata } = skill.metadata ?? {};
        const result = await withSkillVersionCacheLock(db, skill.companyId, () => content.publish(skill, candidate, {
          ...(legacyManaged(skill) ? { sourceType: "managed", sourceLocator: null } : {}), markdown,
          name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : skill.name,
          description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : skill.description,
          fileInventory: files.map(({ path, kind }) => ({ path, kind })),
          trustLevel: files.some(file => file.kind === "script" || file.executable) ? "scripts_executables"
            : files.some(file => file.kind === "asset" || file.kind === "other") ? "assets" : "markdown_only",
          metadata: { ...metadata, ...(legacyManaged(skill) ? { sourceKind: "managed" } : {}),
            ...(originVersionId ? { originVersionId } : {}) },
        }, { type: "system" }, { label: "Legacy installation conversion",
          reuseCurrentVersion: Boolean(saved && skillSnapshotHash(saved) === skillSnapshotHash(files)),
          afterPublish: async (tx, row, version) => {
            if (catalogOrigin && !originVersionId) await tx.update(companySkills)
              .set({ metadata: { ...row.metadata, originVersionId: version.id } }).where(eq(companySkills.id, row.id));
          },
        }));
        results.push({ skillId: skill.id, companyId: skill.companyId, status: "converted", versionId: result.version.id });
      } catch (error) {
        results.push({ skillId: skill.id, companyId: skill.companyId, status: "blocked", reason: error instanceof Error ? error.message : "Conversion failed" });
      }
    }
    return { inspected: skills.length, after: skills.at(-1)?.id ?? null, results };
  }

  async function eligibility(options: Page = {}) {
    const skills = await db.select().from(companySkills).where(scope(options)).orderBy(asc(companySkills.id)).limit(limit(options));
    const results = [];
    for (const skill of skills) {
      const pins = await protectedVersions(db, skill.companyId);
      let status = linkedLocal(skill) ? "linked_local" : legacyManaged(skill) ? "legacy_managed" : "version_backed";
      if (pins.versions === null) status = "unsupported_active_run";
      else if (!linkedLocal(skill) && !skill.currentVersionId) status = "missing_current_version";
      else if (skill.sourceType === "catalog" && !skill.metadata?.originVersionId) status = "legacy_catalog_origin";
      results.push({ skillId: skill.id, companyId: skill.companyId, sourceType: skill.sourceType, versionId: skill.currentVersionId, status });
    }
    return { inspected: skills.length, after: skills.at(-1)?.id ?? null, results, contentVerified: false };
  }

  async function verifyVersions(options: Page = {}) {
    const versions = await db.select(skillVersionMetadataColumns).from(companySkillVersions).where(and(
      options.companyId ? eq(companySkillVersions.companyId, options.companyId) : undefined,
      options.id ? eq(companySkillVersions.id, options.id) : undefined,
      options.after ? gt(companySkillVersions.id, options.after) : undefined,
    )).orderBy(asc(companySkillVersions.id)).limit(limit(options));
    const results = [];
    for (const version of versions) {
      options.signal?.throwIfAborted();
      const packageId = version.repositorySnapshotId ?? version.packageSnapshotId;
      let status = "missing_package";
      try {
        if (packageId) {
          const receipt = await store.descriptor(version.companyId, packageId);
          status = !receipt.storage ? "no_durable_receipt" : receipt.storage.provider !== provider() ? "provider_mismatch"
            : receipt.storage.provider === "local_disk" ? "local_storage" : "remote_storage";
          if (receipt.storage && receipt.storage.provider === provider()
            && !await store.verifyDurable(version.companyId, packageId, options.signal)) status = "corrupt_package";
          if (!receipt.storage && receipt.restorable && version.repositorySnapshotId === packageId) {
            const active = await protectedVersions(db, version.companyId);
            const [protectedRow] = await db.execute(sql`select 1 from company_skills
              where company_id = ${version.companyId} and current_version_id = ${version.id}
              union all select 1 from company_skill_test_runs where company_id = ${version.companyId}
                and status in ('queued', 'running') and skill_version_id = ${version.id}
              union all select 1 from agents where company_id = ${version.companyId}
                and adapter_config::text like ${`%${version.id}%`} limit 1`);
            if (!protectedRow && active.versions && !active.versions.has(version.id)
              && Date.now() - receipt.createdAt.getTime() >= 30 * 24 * 60 * 60_000) {
              await store.recoveryRecipe(version.companyId, packageId);
              status = "expired_git_history";
            }
          }
        } else {
          const files = await store.versionFiles(version, false, options.signal);
          skillPackageManifest(files);
          status = files.some(file => file.path === "SKILL.md" && file.encoding !== "base64")
            ? version.releaseId ? "database_release_snapshot" : "database_snapshot"
            : "incomplete_database_snapshot";
        }
      } catch { status = "unavailable_or_corrupt_package"; }
      results.push({ companyId: version.companyId, skillId: version.companySkillId, versionId: version.id, packageId, status });
    }
    return { inspected: versions.length, after: versions.at(-1)?.id ?? null, results };
  }
  return { installations, eligibility, verifyVersions };
}
