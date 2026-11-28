import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { companySkills, companySkillVersions, type Db } from "@paperclipai/db";
import { parseFrontmatterMarkdown, type CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { classifyInventoryKind, companySkillService, REMOTE_SKILL_SOURCE_UNAVAILABLE, RemoteSkillSourceUnavailableError,
  remoteSourceUnavailable as skillSourceUnavailable, type SkillMissingSourceMarker } from "./company-skills.js";
import { managedSkillContent } from "./managed-skill-content.js";
import { skillPackageStore, skillVersionMetadataColumns } from "./skill-package-store.js";
import { skillPackageMaintenance } from "./skill-package-maintenance.js";
import { skillPackageManifest } from "./skill-package-files.js";
import { assertSkillSnapshotPath, MAX_SKILL_SNAPSHOT_BYTES, MAX_SKILL_SNAPSHOT_FILES, skillSnapshotHash, snapshotFile } from "./skill-snapshot.js";
import { protectedVersions, withSkillVersionCacheLock } from "./skill-version-cache.js";
import { readPinnedCatalogSkillFiles } from "./skills-catalog.js";
import { getStorageService, type StorageService } from "../storage/index.js";

type Page = { companyId?: string; after?: string; id?: string; limit?: number; signal?: AbortSignal };
type Conversion = Page & { apply?: boolean; writersStopped?: boolean; settleUnavailableSources?: boolean };
const RECONSTRUCTED_FROM_STORED_CONTENT_LABEL = "Rebuilt from saved instructions";
const limit = (options: Page) => Math.min(50, Math.max(1, options.limit ?? 10));
const legacyManaged = (skill: typeof companySkills.$inferSelect) => skill.sourceType === "local_path" && skill.metadata?.sourceKind === "managed_local";
const linkedLocal = (skill: typeof companySkills.$inferSelect) => skill.sourceType === "local_path"
  && !legacyManaged(skill) && skill.metadata?.sourceKind !== "paperclip_bundled";
class SkillConversionBlocked extends HttpError {
  constructor(readonly code: string, message: string, status = 422) { super(status, message); }
}
const blocked = (code: string, message: string, status?: number) => new SkillConversionBlocked(code, message, status);

function coversInstalledInventory(skill: typeof companySkills.$inferSelect, files: Array<{ path: string }>) {
  const paths = new Set(files.map(file => file.path));
  return paths.has("SKILL.md") && skill.fileInventory.every(file => typeof file.path === "string" && paths.has(file.path));
}

async function legacySourceIdentity(skill: typeof companySkills.$inferSelect) {
  if (!skill.sourceLocator || !path.isAbsolute(skill.sourceLocator)) return null;
  const source = path.resolve(skill.sourceLocator), root = path.basename(source) === "SKILL.md" ? path.dirname(source) : source;
  const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw blocked("legacy_source_unsafe", "Legacy skill root is not a safe directory");
  return { root: await fs.realpath(root), device: stat.dev, inode: stat.ino };
}

async function legacyFiles(skill: typeof companySkills.$inferSelect, signal?: AbortSignal) {
  if (!skill.sourceLocator || !path.isAbsolute(skill.sourceLocator)) return null;
  const source = path.resolve(skill.sourceLocator);
  const root = path.basename(source) === "SKILL.md" ? path.dirname(source) : source;
  const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw blocked("legacy_source_unsafe", "Legacy skill root is not a safe directory");
  const files: CompanySkillVersionFileInventoryEntry[] = [];
  let bytes = 0;
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw blocked("legacy_source_unsafe", "Legacy skill contains a symbolic link");
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw blocked("legacy_source_unsafe", "Legacy skill contains an unsupported file");
      const relative = assertSkillSnapshotPath(path.relative(root, absolute).split(path.sep).join("/"));
      const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw blocked("legacy_source_unsafe", "Legacy skill contains an unsupported file");
        bytes += stat.size;
        if (files.length >= MAX_SKILL_SNAPSHOT_FILES || bytes > MAX_SKILL_SNAPSHOT_BYTES) throw blocked("legacy_source_too_large", "Legacy skill exceeds package limits");
        const body = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < body.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
          if (!bytesRead) throw blocked("source_changed", "Legacy skill changed during conversion");
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw blocked("source_changed", "Legacy skill changed during conversion");
        files.push(snapshotFile(relative, classifyInventoryKind(relative), body, Boolean(stat.mode & 0o111)));
      } finally { await handle.close(); }
    }
  }
  await visit(root);
  if (!files.some(file => file.path === "SKILL.md" && file.encoding !== "base64")) throw blocked("legacy_skill_markdown_missing", "Legacy skill is missing UTF-8 SKILL.md");
  return files;
}

async function pinnedCatalogFiles(skill: typeof companySkills.$inferSelect, signal?: AbortSignal) {
  const catalogId = skill.metadata?.catalogId, originHash = skill.metadata?.originHash;
  if (skill.sourceType !== "catalog" || typeof catalogId !== "string" || typeof originHash !== "string") return null;
  let files: Awaited<ReturnType<typeof readPinnedCatalogSkillFiles>>;
  try { files = await readPinnedCatalogSkillFiles(catalogId, originHash, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw blocked("catalog_package_unavailable", error instanceof Error ? error.message : "Catalog package is unavailable");
  }
  return files?.map(file => snapshotFile(assertSkillSnapshotPath(file.path), classifyInventoryKind(file.path), file.bytes)) ?? null;
}

export function skillInstallationMaintenance(db: Db, storage?: StorageService) {
  const store = skillPackageStore(db, storage);
  const content = managedSkillContent(db, db, storage);
  const provider = () => (storage ?? getStorageService()).provider;
  function storedContentFiles(skill: typeof companySkills.$inferSelect, saved: CompanySkillVersionFileInventoryEntry[] | null) {
    const kept = saved ?? [];
    const savedEntry = kept.find(file => file.path === "SKILL.md" && file.encoding !== "base64");
    const entry = savedEntry ?? (parseFrontmatterMarkdown(skill.markdown).body.trim()
      ? snapshotFile("SKILL.md", classifyInventoryKind("SKILL.md"), Buffer.from(skill.markdown, "utf8")) : null);
    if (!entry) return null;
    const files = [entry, ...kept.filter(file => file.path !== "SKILL.md")];
    const present = new Set(files.map(file => file.path));
    const missingFiles = skill.fileInventory.map(file => file.path).filter((file): file is string => typeof file === "string" && !present.has(file));
    return { files, missingFiles };
  }
  async function markSourceUnavailable(skill: typeof companySkills.$inferSelect) {
    const publications: ActivityPublication[] = [];
    await db.transaction(async tx => {
      const [row] = await tx.update(companySkills).set({
        metadata: { ...(skill.metadata ?? {}), missingSource: { reason: REMOTE_SKILL_SOURCE_UNAVAILABLE,
          sourceType: skill.sourceType as SkillMissingSourceMarker["sourceType"], sourceLocator: skill.sourceLocator ?? null,
          sourcePath: null, detectedAt: new Date().toISOString() } satisfies SkillMissingSourceMarker },
        updatedAt: new Date(),
      }).where(and(eq(companySkills.companyId, skill.companyId), eq(companySkills.id, skill.id),
        skill.sourceLocator ? eq(companySkills.sourceLocator, skill.sourceLocator) : isNull(companySkills.sourceLocator),
        skill.sourceRef ? eq(companySkills.sourceRef, skill.sourceRef) : isNull(companySkills.sourceRef),
        sql`${companySkills.metadata}->'missingSource' is null`,
        skill.currentVersionId ? eq(companySkills.currentVersionId, skill.currentVersionId) : isNull(companySkills.currentVersionId)))
        .returning({ id: companySkills.id });
      if (!row) throw blocked("source_changed", "Skill changed while its source was being checked. Retry the operation.", 409);
      await logActivity(tx as unknown as Db, { companyId: skill.companyId, actorType: "system", actorId: "skill-installation-maintenance",
        action: "company.skill_source_unavailable", entityType: "company_skill", entityId: skill.id,
        details: { skillName: skill.name, sourceType: skill.sourceType, hadSavedVersion: Boolean(skill.currentVersionId) } }, publications);
    });
    for (const publication of publications) publishActivity(publication);
    return { skillId: skill.id, companyId: skill.companyId, status: "source_unavailable", versionId: skill.currentVersionId };
  }
  function scope(options: Page) {
    return and(options.companyId ? eq(companySkills.companyId, options.companyId) : undefined,
      options.id ? eq(companySkills.id, options.id) : undefined,
      options.after ? gt(companySkills.id, options.after) : undefined);
  }
  async function installations(options: Conversion = {}) {
    const skills = await db.select().from(companySkills).where(scope(options)).orderBy(asc(companySkills.id)).limit(limit(options));
    const results: Array<{ skillId: string; companyId: string; status: string; versionId?: string | null; reason?: string; code?: string;
      reconstructed?: boolean }> = [];
    for (const skill of skills) {
      options.signal?.throwIfAborted();
      const catalogOrigin = skill.sourceType === "catalog" && !skill.metadata?.originVersionId;
      if (linkedLocal(skill)) {
        results.push({ skillId: skill.id, companyId: skill.companyId, status: "linked_local", versionId: skill.currentVersionId });
        continue;
      }
      if (skillSourceUnavailable(skill)) {
        results.push({ skillId: skill.id, companyId: skill.companyId, status: "source_unavailable", versionId: skill.currentVersionId });
        continue;
      }
      try {
        const version = skill.currentVersionId ? await store.version(skill.companyId, skill.id, skill.currentVersionId) : null;
        const complete = version && coversInstalledInventory(skill, await store.versionInventory(version));
        if (!legacyManaged(skill) && !catalogOrigin && complete) {
          results.push({ skillId: skill.id, companyId: skill.companyId, status: "unchanged", versionId: skill.currentVersionId });
          continue;
        }
        // Conversion copies current content. Keep old directories, versions and
        // inline bytes; unknown historical pins still block retention/eviction.
        const convert = async () => {
          const saved = version ? await store.versionFiles(version) : null;
          const sourceIdentity = await legacySourceIdentity(skill);
          const local = await legacyFiles(skill, options.signal);
          const completeSaved = saved && coversInstalledInventory(skill, saved) ? saved : null;
          const unmodifiedCatalog = skill.sourceType === "catalog" && !skill.metadata?.userModifiedAt
            && typeof skill.metadata?.originHash === "string" && skill.metadata.installedHash === skill.metadata.originHash;
          let remoteUnavailable = false;
          const remoteFiles = local ?? completeSaved ?? ((skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url")
            ? await companySkillService(db).captureLegacyInstallation(skill.companyId, skill.id).catch(error => {
              if (options.signal?.aborted) throw error;
              if (!options.settleUnavailableSources || !(error instanceof RemoteSkillSourceUnavailableError)) throw blocked(REMOTE_SKILL_SOURCE_UNAVAILABLE, error instanceof Error ? error.message : "Remote source is unavailable");
              remoteUnavailable = true;
              return null;
            })
            : unmodifiedCatalog ? await pinnedCatalogFiles(skill, options.signal) : null);
          const reconstructed = remoteUnavailable ? storedContentFiles(skill, saved) : null;
          if (remoteUnavailable && !reconstructed) {
            if (!options.apply) return { skillId: skill.id, companyId: skill.companyId, status: "conversion_required", versionId: skill.currentVersionId };
            return await markSourceUnavailable(skill);
          }
          const files = reconstructed?.files ?? remoteFiles;
          const originSource = catalogOrigin && typeof skill.metadata?.originSnapshotLocator === "string"
            ? { ...skill, sourceLocator: skill.metadata.originSnapshotLocator } : null;
          const originIdentity = originSource ? await legacySourceIdentity(originSource) : null;
          const localOrigin = originSource ? await legacyFiles(originSource, options.signal) : null;
          const origin = localOrigin ?? (catalogOrigin && skill.metadata?.userModifiedAt ? await pinnedCatalogFiles(skill, options.signal) : null);
          if (catalogOrigin && !origin && skill.metadata?.userModifiedAt) {
            throw blocked("catalog_origin_unavailable", "Catalog reset snapshot is unavailable; preserve the original installed package before conversion");
          }
          if (!files?.length || !files.some(file => file.path === "SKILL.md")) throw blocked("source_files_unavailable", "Neither complete legacy files nor a saved version is available");
          if (!local && !reconstructed && !coversInstalledInventory(skill, files)) {
            throw blocked("saved_version_incomplete", "Saved version does not cover the installed inventory");
          }
          if (!options.apply) {
            return { skillId: skill.id, companyId: skill.companyId, status: "conversion_required", versionId: skill.currentVersionId };
          }
          if (version && saved && !version.packageSnapshotId && !version.repositorySnapshotId
            && skillSnapshotHash(saved) === skillSnapshotHash(files)) {
            await skillPackageMaintenance(db, storage).migrateVersions({ id: version.id, apply: true, clearLegacy: false, signal: options.signal });
          }
          const candidate = await content.prepare(skill.companyId, files, options.signal);
          if (!candidate.packageSnapshotId || !await store.verifyDurable(skill.companyId, candidate.packageSnapshotId, options.signal)) {
            throw blocked("snapshot_not_durable", "Final snapshot is not independently recoverable from object storage");
          }
          let originVersionId = typeof skill.metadata?.originVersionId === "string" ? skill.metadata.originVersionId : null;
          const originCandidate = catalogOrigin && origin && skillSnapshotHash(origin) !== skillSnapshotHash(files)
            ? await content.prepare(skill.companyId, origin, options.signal) : null;
          if (originCandidate && !originCandidate.packageSnapshotId) throw blocked("catalog_origin_not_durable", "Catalog origin is not durably available");
          const markdown = files.find(file => file.path === "SKILL.md")!.content;
          const publications: ActivityPublication[] = [];
          const parsed = parseFrontmatterMarkdown(markdown);
          const { missingSource: _missing, ...metadata } = skill.metadata ?? {};
          // Object preparation is private. Hold the shared cache lock only for
          // publication so new run pinning does not wait for network uploads.
          const result = await withSkillVersionCacheLock(db, skill.companyId, () => content.publish(skill, candidate, {
            ...(legacyManaged(skill) ? { sourceType: "managed", sourceLocator: null } : {}), markdown,
            name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : skill.name,
            description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : skill.description,
            fileInventory: files.map(({ path, kind }) => ({ path, kind })),
            trustLevel: files.some(file => file.kind === "script" || file.executable) ? "scripts_executables"
              : files.some(file => file.kind === "asset" || file.kind === "other") ? "assets" : "markdown_only",
            metadata: { ...metadata, ...(legacyManaged(skill) ? { sourceKind: "managed" } : {}),
              ...(originVersionId ? { originVersionId } : {}),
              ...(reconstructed ? { reconstructedFromStoredContent: { at: new Date().toISOString(),
                missingFiles: reconstructed.missingFiles } } : {}) },
          }, { type: "system" }, { label: reconstructed ? RECONSTRUCTED_FROM_STORED_CONTENT_LABEL : "Legacy installation conversion",
            reuseCurrentVersion: Boolean(!reconstructed && saved && skillSnapshotHash(saved) === skillSnapshotHash(files)),
            validate: async tx => {
              // publish already holds the canonical slug and skill-row locks.
              // Recheck filesystem writers after upload, before changing authority.
              const [current] = await tx.select().from(companySkills).where(and(
                eq(companySkills.companyId, skill.companyId), eq(companySkills.id, skill.id)));
              if (!current || current.slug !== skill.slug || current.sourceLocator !== skill.sourceLocator
                || current.sourceRef !== skill.sourceRef || JSON.stringify(current.fileInventory) !== JSON.stringify(skill.fileInventory)
                || JSON.stringify(await legacySourceIdentity(current)) !== JSON.stringify(sourceIdentity))
                throw blocked("source_changed", "Legacy skill source changed during conversion. Retry the operation.", 409);
              const latest = await legacyFiles(current, options.signal);
              if ((latest ? skillSnapshotHash(latest) : null) !== (local ? skillSnapshotHash(local) : null))
                throw blocked("source_changed", "Legacy skill files changed during conversion. Retry the operation.", 409);
              if (originSource && (JSON.stringify(await legacySourceIdentity(originSource)) !== JSON.stringify(originIdentity)
                || (await legacyFiles(originSource, options.signal).then(value => value ? skillSnapshotHash(value) : null))
                  !== (localOrigin ? skillSnapshotHash(localOrigin) : null)))
                throw blocked("source_changed", "Catalog origin changed during conversion. Retry the operation.", 409);
              if (origin && originCandidate?.packageSnapshotId) {
                originVersionId = (await companySkillService(db).createVersion(skill.companyId, skill.id,
                  { label: "Original catalog package" }, { type: "system" }, {
                    database: tx, fileInventory: origin, packageSnapshotId: originCandidate.packageSnapshotId,
                    packageFileMap: originCandidate.packageFileMap, updateCurrentVersion: false, skipInventoryRefresh: true,
                  })).id;
              }
            },
            afterPublish: async (tx, row, version) => {
              if (reconstructed) await logActivity(tx as unknown as Db, { companyId: skill.companyId, actorType: "system",
                actorId: "skill-installation-maintenance", action: "company.skill_reconstructed_from_stored_content",
                entityType: "company_skill", entityId: skill.id, details: { skillName: skill.name, versionId: version.id,
                  restoredFiles: files.map(file => file.path), missingFiles: reconstructed.missingFiles } }, publications);
              if (catalogOrigin) await tx.update(companySkills)
                .set({ metadata: { ...row.metadata, originVersionId: originVersionId ?? version.id } }).where(eq(companySkills.id, row.id));
            },
          }));
          for (const publication of publications) publishActivity(publication);
          return { skillId: skill.id, companyId: skill.companyId, status: "converted", versionId: result.version.id,
            ...(reconstructed ? { reconstructed: true } : {}) };
        };
        results.push(await convert());
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const reason = error instanceof Error ? error.message : "Conversion failed";
        results.push({ skillId: skill.id, companyId: skill.companyId, status: "blocked", reason,
          code: error instanceof SkillConversionBlocked ? error.code : "blocked" });
      }
    }
    return { inspected: skills.length, after: skills.at(-1)?.id ?? null, results };
  }

  async function eligibility(options: Page & { purpose?: "migration" | "startup" } = {}) {
    const skills = await db.select().from(companySkills).where(scope(options)).orderBy(asc(companySkills.id)).limit(limit(options));
    const results = [];
    for (const skill of skills) {
      // Migration/eviction must wait for exact pins. Replacement readiness only
      // inspects installation durability: a serving controller may legitimately
      // be between run admission and publishing its immutable skill selection.
      const pins = options.purpose === "startup" ? undefined : await protectedVersions(db, skill.companyId);
      let status = linkedLocal(skill) ? "linked_local" : legacyManaged(skill) ? "legacy_managed" : "version_backed";
      if (pins?.versions === null) status = "unsupported_active_run";
      else if (skillSourceUnavailable(skill)) status = "source_unavailable";
      else if (!linkedLocal(skill) && !skill.currentVersionId) status = "missing_current_version";
      else if (skill.sourceType === "catalog" && !skill.metadata?.originVersionId) status = "legacy_catalog_origin";
      else if (status === "version_backed" && skill.currentVersionId) {
        try {
          const version = await store.version(skill.companyId, skill.id, skill.currentVersionId);
          if (!version) status = "unavailable_current_version";
          else if (!coversInstalledInventory(skill, await store.versionInventory(version))) status = "incomplete_current_version";
        } catch { status = "unavailable_current_version"; }
      }
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
          const [unavailableHead] = await db.select({ id: companySkills.id }).from(companySkills).where(and(
            eq(companySkills.companyId, version.companyId), eq(companySkills.id, version.companySkillId),
            eq(companySkills.currentVersionId, version.id), sql`${companySkills.metadata}->'missingSource'->>'reason' = ${REMOTE_SKILL_SOURCE_UNAVAILABLE}`));
          const files = await store.versionFiles(version, false, options.signal);
          const complete = files.some(file => file.path === "SKILL.md" && file.encoding !== "base64");
          if (unavailableHead && (!complete || !files.length)) {
            results.push({ companyId: version.companyId, skillId: version.companySkillId, versionId: version.id, packageId, status: "source_unavailable" });
            continue;
          }
          skillPackageManifest(files);
          status = complete
            ? version.releaseId ? "database_release_snapshot" : "database_snapshot"
            : "incomplete_database_snapshot";
        }
        // A valid archive can still be an incomplete legacy installation. Compare
        // only the current head: historical revisions may legitimately omit files
        // that were added later. Inventory reads do not load SQL package bodies.
        const [installed] = await db.select().from(companySkills).where(and(
          eq(companySkills.companyId, version.companyId), eq(companySkills.id, version.companySkillId),
          eq(companySkills.currentVersionId, version.id),
        ));
        if (installed && !linkedLocal(installed) && !skillSourceUnavailable(installed)
          && !coversInstalledInventory(installed, await store.versionInventory(version))) status = "incomplete_current_version";
      } catch { status = "unavailable_or_corrupt_package"; }
      results.push({ companyId: version.companyId, skillId: version.companySkillId, versionId: version.id, packageId, status });
    }
    return { inspected: versions.length, after: versions.at(-1)?.id ?? null, results };
  }
  return { installations, eligibility, verifyVersions };
}
