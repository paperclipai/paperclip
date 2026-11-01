import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { notFound, unprocessable } from "../errors.js";
import { skillAccessService } from "./skill-access.js";
import { skillPackageStore } from "./skill-package-store.js";
import { skillPackageRuntime } from "./skill-package-runtime.js";
import { skillPackageManifest, verifySkillPackageDirectory } from "./skill-package-files.js";
import { skillFileBytes } from "./skill-snapshot.js";
import { ensureSkillCacheDirectory, skillVersionCachePaths, touchSkillVersionCache, withSkillVersionCacheLock } from "./skill-version-cache.js";
import { runVersionSnapshotFlight } from "./skill-version-retention.js";

export type SkillContentReference = { companyId: string; skillId: string; versionId: string };

export function skillExecutionContent(db: Db, options: { actor?: AuthorizationActor; packageDb?: Db } = {}) {
  const packages = skillPackageStore(options.packageDb ?? db);
  const runtime = skillPackageRuntime(options.packageDb ?? db);
  async function withVersion<T>(reference: SkillContentReference, consume: (directory: string) => Promise<T>): Promise<T> {
    const { companyId, skillId, versionId } = reference;
    await skillAccessService(db, options.actor).assertSkill(companyId, skillId);
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
  return { withVersion };
}
