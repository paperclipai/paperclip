import { measureRunPhase } from "./execution-preparation-timing.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { skillPackageStore, type StoredSkillVersion } from "./skill-package-store.js";
import { packageSha256, verifySkillPackageDirectory, relocateSkillPackageVerification, type SkillPackageFile, type SkillPackageManifest } from "./skill-package-files.js";
import { REPOSITORY_CONTENT_DIR, repositorySkillProjection } from "./skill-repository-package.js";
import { assertSkillSnapshotPath, skillFileBytes } from "./skill-snapshot.js";
import { ensureSkillCacheDirectory } from "./skill-version-cache.js";

type ProjectedFile = SkillPackageFile & { sourcePath?: string; generated?: Buffer };
// Only the wrapper/policy bytes and file metadata are retained, never a decoded repository.
const projections = new Map<string, { files: ProjectedFile[]; bytes: number }>();
let projectionBytes = 0;
const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTIONS = 256;
const repositoryFiles = new WeakMap<SkillPackageManifest, ProjectedFile[]>();
function originalFiles(version: StoredSkillVersion, manifest: SkillPackageManifest): ProjectedFile[] {
  if (version.repositorySnapshotId) {
    let shared = repositoryFiles.get(manifest);
    if (!shared) {
      shared = manifest.files.map(file => ({ ...file, sourcePath: file.path, path: `${REPOSITORY_CONTENT_DIR}/${file.path}` }));
      repositoryFiles.set(manifest, shared);
    }
    return [...shared];
  }
  if (!version.packageFileMap) return manifest.files.map(file => ({ ...file, sourcePath: file.path }));
  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  return version.packageFileMap.map(mapping => {
    assertSkillSnapshotPath(mapping.path);
    assertSkillSnapshotPath(mapping.sourcePath);
    const file = byPath.get(mapping.sourcePath);
    if (!file) throw new Error("Skill version references a missing package file");
    return { ...file, ...mapping, encoding: mapping.encoding ?? file.encoding };
  });
}
export function skillPackageRuntime(db: Db) {
  const store = skillPackageStore(db);
  async function inventory(version: StoredSkillVersion) {
    const id = version.repositorySnapshotId ?? version.packageSnapshotId;
    if (!id) throw new Error("Skill version has no package");
    const manifest = await store.manifest(version.companyId, id);
    const files = originalFiles(version, manifest).map(({ path, kind }) => ({ path, kind }));
    if (version.repositorySnapshotId) {
      files.unshift({ path: "SKILL.md", kind: "skill" });
      const policy = path.posix.join(path.posix.dirname(version.repositorySkillPath!), "agents/openai.yaml");
      const file = manifest.files.find(file => file.path === policy);
      if (file) files.push({ path: "agents/openai.yaml", kind: file.kind });
    }
    return files;
  }
  async function projection(version: StoredSkillVersion): Promise<ProjectedFile[]> {
    const id = version.repositorySnapshotId ?? version.packageSnapshotId;
    if (!id) throw new Error("Skill version has no package");
    const manifest = await store.manifest(version.companyId, id);
    const key = `${version.companyId}:${version.id}:${manifest.contentHash}`;
    const files = originalFiles(version, manifest);
    const cached = projections.get(key);
    if (cached) return [...files, ...cached.files];
    const generatedFiles: ProjectedFile[] = [];
    if (version.repositorySnapshotId) {
      if (!version.repositorySkillPath) throw new Error("Repository skill entrypoint is missing");
      const generated = await store.withPackage(version.companyId, id, async (root, manifest) => {
        const wanted = new Set([version.repositorySkillPath!, path.posix.join(path.posix.dirname(version.repositorySkillPath!), "agents/openai.yaml")]);
        const selected: CompanySkillVersionFileInventoryEntry[] = [];
        for (const file of manifest.files.filter(file => wanted.has(file.path))) selected.push({
          ...file, content: (await fs.readFile(path.join(root, file.path))).toString(file.encoding),
        });
        return repositorySkillProjection(selected, version.repositorySkillPath!).filter(file => !file.path.startsWith(`${REPOSITORY_CONTENT_DIR}/`));
      });
      for (const file of generated) {
        const bytes = skillFileBytes(file);
        generatedFiles.push({ path: file.path, kind: file.kind, encoding: file.encoding ?? "utf8", executable: Boolean(file.executable),
          size: bytes.length, sha256: packageSha256(bytes), generated: bytes });
      }
    }
    // Retain only tiny generated wrappers/policies per version. Shared package
    // file metadata follows the bounded manifest cache through the WeakMap.
    const bytes = generatedFiles.reduce((sum, file) => sum + (file.generated?.length ?? 0) + 512, 0);
    while (projections.size && (projections.size >= MAX_PROJECTIONS || projectionBytes + bytes > MAX_PROJECTION_BYTES)) {
      const first = projections.keys().next().value!;
      projectionBytes -= projections.get(first)!.bytes;
      projections.delete(first);
    }
    if (generatedFiles.length && bytes <= MAX_PROJECTION_BYTES) { projections.set(key, { files: generatedFiles, bytes }); projectionBytes += bytes; }
    return [...files, ...generatedFiles];
  }
  async function materialize(version: StoredSkillVersion, directory: string) {
    const files = await measureRunPhase("skills.repository.read", () => projection(version));
    const parent = path.dirname(directory);
    await ensureSkillCacheDirectory(parent, true);
    if (await measureRunPhase("skills.version.verify", () => verifySkillPackageDirectory(directory, files), { fileCount: files.length })) return directory;
    return store.withPackage(version.companyId, (version.repositorySnapshotId ?? version.packageSnapshotId)!, async root => {
      const staging = await fs.mkdtemp(path.join(parent, `.${version.id}-`));
      try {
        for (const file of files) {
          const target = path.join(staging, file.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          if (file.generated) await fs.writeFile(target, file.generated);
          else await fs.copyFile(path.join(root, file.sourcePath!), target);
          await fs.chmod(target, file.executable ? 0o555 : 0o444);
        }
        if (!await verifySkillPackageDirectory(staging, files)) throw new Error("Prepared skill version failed integrity verification");
        await fs.rm(directory, { recursive: true, force: true });
        await fs.rename(staging, directory);
        relocateSkillPackageVerification(staging, directory, files);
        return directory;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    });
  }
  async function readFile(version: StoredSkillVersion, relative: string) {
    const file = (await projection(version)).find(file => file.path === relative);
    if (!file) return null;
    const bytes = file.generated ?? await store.withPackage(version.companyId,
      (version.repositorySnapshotId ?? version.packageSnapshotId)!, root => fs.readFile(path.join(root, file.sourcePath!)));
    return { path: file.path, kind: file.kind, content: bytes.toString(file.encoding), encoding: file.encoding, executable: file.executable };
  }
  return { inventory, materialize, readFile };
}
