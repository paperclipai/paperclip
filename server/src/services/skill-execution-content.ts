import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { notFound, unprocessable } from "../errors.js";
import { skillAccessService } from "./skill-access.js";
import { skillPackageStore } from "./skill-package-store.js";
import { skillPackageRuntime } from "./skill-package-runtime.js";
import { skillPackageManifest, verifySkillPackageDirectory, type SkillPackageManifest } from "./skill-package-files.js";
import { skillFileBytes } from "./skill-snapshot.js";
import { ensureSkillCacheDirectory, skillVersionCachePaths, touchSkillVersionCache, withSkillVersionCacheLock } from "./skill-version-cache.js";
import { runVersionSnapshotFlight } from "./skill-version-retention.js";

export type SkillContentReference = { companyId: string; skillId: string; versionId: string };
export type SkillRepositoryContentReference = SkillContentReference & { snapshotId: string; entryPath: string };

export function skillExecutionContent(db: Db, options: { actor?: AuthorizationActor; packageDb?: Db } = {}) {
  const packages = skillPackageStore(options.packageDb ?? db);
  const runtime = skillPackageRuntime(options.packageDb ?? db);
  async function withRepositoryVersion<T>(reference: SkillRepositoryContentReference,
    consume: (directory: string, manifest: SkillPackageManifest) => Promise<T>, additionalReferences: SkillRepositoryContentReference[] = []): Promise<T> {
    for (const selected of [reference, ...additionalReferences]) {
      if (selected.companyId !== reference.companyId || selected.snapshotId !== reference.snapshotId) throw notFound("Admitted skill repository group does not match");
      await skillAccessService(db, options.actor).assertSkill(selected.companyId, selected.skillId);
      const version = await packages.version(selected.companyId, selected.skillId, selected.versionId);
      if (!version || version.companyId !== selected.companyId || version.companySkillId !== selected.skillId
        || version.id !== selected.versionId || version.repositorySnapshotId !== selected.snapshotId
        || version.repositorySkillPath !== selected.entryPath) throw notFound("Admitted skill repository version not found");
    }
    // The storage owner verifies private scratch and retains it through consume.
    // No shared cache path is exposed, so retention/publication cannot delete a
    // reader's source, and filesystem work holds no company advisory transaction.
    return packages.withIsolatedPackage(reference.companyId, reference.snapshotId, consume);
  }
  async function withVersion<T>(reference: SkillContentReference, consume: (directory: string) => Promise<T>): Promise<T> {
    await skillAccessService(db, options.actor).assertSkill(reference.companyId, reference.skillId);
    return withReadableVersion(reference, consume);
  }
  async function withReadableVersion<T>(reference: SkillContentReference, consume: (directory: string) => Promise<T>): Promise<T> {
    const { companyId, skillId, versionId } = reference;
    return withSkillVersionCacheLock(db, companyId, async () => {
      const version = await packages.version(companyId, skillId, versionId);
      if (!version) throw notFound("Skill version not found");
      const { directory } = skillVersionCachePaths(companyId, skillId, versionId);
      await runVersionSnapshotFlight(directory, async () => {
        if (version.repositorySnapshotId || version.packageSnapshotId) return runtime.materialize(version, directory);
        const files = await packages.versionFiles(version);
        if (!files.some(file => file.path === "SKILL.md")) throw unprocessable("Skill version has no SKILL.md snapshot.");
        const manifest = skillPackageManifest(files);
        const parent = path.dirname(directory);
        await ensureSkillCacheDirectory(parent, true);
        if (await verifySkillPackageDirectory(directory, manifest.files)) return directory;
        const staging = await fs.mkdtemp(path.join(parent, `.${versionId}-`));
        try {
          for (const file of files) {
            const target = path.join(staging, file.path);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, skillFileBytes(file), { mode: file.executable ? 0o555 : 0o444 });
          }
          if (!await verifySkillPackageDirectory(staging, manifest.files)) throw new Error("Skill delivery verification failed");
          await fs.rm(directory, { recursive: true, force: true });
          await fs.rename(staging, directory);
          return directory;
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
      });
      await touchSkillVersionCache(companyId, skillId, versionId);
      return consume(directory);
    });
  }
  return { withVersion, withReadableVersion, withRepositoryVersion };
}
