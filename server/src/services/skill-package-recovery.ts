import path from "node:path";
import { and, eq } from "drizzle-orm";
import { companySkillSources, type Db, type SkillPackageRestoreRecipe } from "@paperclipai/db";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { assertSkillSnapshotPath } from "./skill-snapshot.js";
import { packageSha256, skillPackageManifest, validateSkillPackageManifest } from "./skill-package-files.js";
import type { GitHubRead } from "./github-skill-source.js";
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES } from "./skill-repository-package.js";

/** Recheck the source's saved identity and current grant. Never search another
 * company's credentials or turn a mutable branch name into a historical commit. */
export async function skillPackageRecoveryReader(db: Db, companyId: string, recipe: SkillPackageRestoreRecipe) {
  const [source] = await db.select().from(companySkillSources).where(and(
    eq(companySkillSources.companyId, companyId), eq(companySkillSources.id, recipe.sourceId)));
  if (!source || source.removedAt || !source.enabled || source.repositoryId !== recipe.repositoryId
    || source.repositoryUrl.toLowerCase() !== recipe.repositoryUrl.toLowerCase()) {
    throw forbidden("This skill package is no longer cached. Reconnect its original repository to restore it.");
  }
  // Deferred import avoids making the package store own source synchronization.
  const { skillSourceSetupContext } = await import("./skill-source-sync.js");
  const context = await skillSourceSetupContext(db, source);
  await context.authorize("skills.update", { sourceType: "git", sourceLocator: recipe.repositoryUrl });
  return context.read(source.connectionId);
}

export async function recoverSkillPackage(recipe: SkillPackageRestoreRecipe, read: GitHubRead, signal: AbortSignal): Promise<CompanySkillVersionFileInventoryEntry[]> {
  if (recipe.version !== 1 || !/^[a-f0-9]{40}$/i.test(recipe.commitSha)) throw new Error("Invalid immutable skill package recipe");
  const manifest = validateSkillPackageManifest(recipe.manifest);
  const url = new URL(recipe.repositoryUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
    || !/^\/[^/]+\/[^/]+$/.test(url.pathname) || url.search || url.hash) throw new Error("Invalid skill repository identity");
  const repository = await read(`/repos${url.pathname}`, signal) as { id?: number | string };
  if (String(repository.id) !== recipe.repositoryId) throw new Error("The repository at this URL is not the original skill repository");
  const snapshot = await read.openSnapshot({ repositoryUrl: recipe.repositoryUrl, ref: recipe.commitSha, commitSha: recipe.commitSha }, { signal });
  try {
    if (snapshot.commitSha !== recipe.commitSha) throw new Error("Git returned a different skill commit");
    const byPath = new Map(snapshot.entries.map(entry => [entry.path, entry]));
    if (recipe.skillPath) assertSkillSnapshotPath(recipe.skillPath);
    const entries = manifest.files.map(file => {
      const sourcePath = recipe.skillPath
        ? file.path === "SKILL.md" ? recipe.skillPath : path.posix.join(path.posix.dirname(recipe.skillPath), file.path)
        : file.path;
      const entry = byPath.get(assertSkillSnapshotPath(sourcePath));
      if (!entry || entry.type !== "blob" || entry.mode !== (file.executable ? "100755" : "100644") || entry.size !== file.size) {
        throw new Error(`The original skill file is unavailable: ${sourcePath}`);
      }
      return entry;
    });
    const files: CompanySkillVersionFileInventoryEntry[] = [];
    for (let start = 0; start < entries.length;) {
      signal.throwIfAborted();
      let end = start, batchBytes = 0;
      while (end < entries.length && end - start < MAX_REPOSITORY_FILES
        && batchBytes + manifest.files[end]!.size <= MAX_REPOSITORY_BYTES) {
        batchBytes += manifest.files[end]!.size;
        end++;
      }
      if (end === start) throw new Error("Restored skill file exceeds the Git read limit");
      const batch = entries.slice(start, end);
      const blobs = snapshot.readBlobs ? await snapshot.readBlobs(batch, signal) : null;
      for (let index = start; index < end; index++) {
        signal.throwIfAborted();
        const entry = entries[index]!, expected = manifest.files[index]!;
        const bytes = blobs?.get(entry.sha) ?? await snapshot.readBlob(entry, signal);
        if (bytes.length !== expected.size || packageSha256(bytes) !== expected.sha256) throw new Error(`Restored skill file checksum mismatch: ${expected.path}`);
        files.push({ path: expected.path, kind: expected.kind, content: bytes.toString(expected.encoding),
          ...(expected.encoding === "base64" ? { encoding: expected.encoding } : {}), ...(expected.executable ? { executable: true } : {}) });
      }
      start = end;
    }
    if (skillPackageManifest(files).contentHash !== manifest.contentHash) throw new Error("Restored skill package checksum mismatch");
    return files;
  } finally { await snapshot.release(); }
}
