import path from 'node:path';
import { MAX_REPOSITORY_BYTES, MAX_REPOSITORY_FILES, repositoryPackageInspection } from './skill-repository-package.js';
import type { CompanySkillVersionFileInventoryEntry, SkillSourceCandidate, SkillSourceDiscovery, SkillSourcePreviewRequest, SkillSourceFilePreview, SkillSourceScanUpdate, SkillSourceScanProgress } from '@paperclipai/shared';
import { parseFrontmatterMarkdown, parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { notFound, unprocessable } from '../errors.js';
import { assertSkillSnapshotPath, snapshotFile, skillFileBytes } from './skill-snapshot.js';
import { indexSkillPackagePaths, inspectSkillPackage } from './skill-package-inspection.js';
import { auditSkillSnapshot, classifyInventoryKind } from './company-skills.js';
import { skillRepositoryDependencies } from './skill-repository-dependencies.js';

import type { GitSkillSnapshot, GitSkillSnapshotOptions, GitSkillTreeEntry as TreeEntry } from './skill-source-git-snapshot.js';

export interface GitHubRead {
  (apiPath: string, signal?: AbortSignal): Promise<unknown>;
  withScan?: <T>(operation: () => Promise<T>) => Promise<T>;
  openSnapshot: (input: { repositoryUrl: string; ref: string; commitSha?: string }, options?: GitSkillSnapshotOptions) => Promise<GitSkillSnapshot>;
  readonly connectionId?: string | null;
  readonly grantId?: string | null;
}
export type DiscoveredSkill = SkillSourceCandidate & { files: CompanySkillVersionFileInventoryEntry[] };
export type ScannedSkillSource = SkillSourceDiscovery & { skills: DiscoveredSkill[]; defaultBranch: string; treeSha?: string; downloadBytes?: number; scanBytes?: number; repositoryFiles?: CompanySkillVersionFileInventoryEntry[]; repositorySubset?: boolean };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 100 * 1024 * 1024;
const MAX_SCAN_PACKAGES = 1_000;
const MAX_SCAN_FILES = 10_000;

export function parseSkillRepository(url: string) {
  const parsed = parseGitHubSkillRepositoryUrl(url);
  if (!parsed) throw unprocessable('Enter an HTTPS GitHub repository or branch URL without credentials.');
  return parsed;
}

export interface SkillScanOptions {
  signal?: AbortSignal;
  onProgress?: (event: SkillSourceScanUpdate) => void | Promise<void>;
  /** Discovery needs audited manifests, not the full contents retained for import. */
  retainFiles?: boolean;
  repositorySubset?: boolean;
}

type SkillScanInput = { packageMode?: 'skills' | 'repository'; repositoryUrl: string; trackingRef?: string; commitSha?: string; onlySkillPath?: string };

export function scanGitHubSkills(input: SkillScanInput, providerRead: GitHubRead, options: SkillScanOptions = {}): Promise<ScannedSkillSource> {
  const scan = () => scanRepository(input, providerRead, options);
  return providerRead.withScan ? providerRead.withScan(scan) : scan();
}

/** Oversized repositories may still contain valid, bounded skill packages. */
export async function scanGitHubSkillsWithPackageFallback(input: SkillScanInput, providerRead: GitHubRead, options: SkillScanOptions = {}): Promise<ScannedSkillSource> {
  try { return await scanGitHubSkills(input, providerRead, options); }
  catch (error) {
    if (input.packageMode !== 'repository' || !(error instanceof Error) || !/^Repository package exceeds/.test(error.message)) throw error;
    options.signal?.throwIfAborted();
    try {
      return await scanGitHubSkills(input, providerRead, { ...options, repositorySubset: true });
    } catch (subsetError) {
      if (!(subsetError instanceof Error) || !/^Repository package exceeds/.test(subsetError.message)) throw subsetError;
      const scan = await scanGitHubSkills({ ...input, packageMode: 'skills' }, providerRead, options);
      scan.warnings.push('Only skill folders were included because the repository and its referenced files exceed the supported package size. Missing references are listed below.');
      return scan;
    }
  }
}

async function scanRepository(input: SkillScanInput, providerRead: GitHubRead, options: SkillScanOptions): Promise<ScannedSkillSource> {
  const read = async (apiPath: string) => {
    options.signal?.throwIfAborted();
    const result = await providerRead(apiPath, options.signal);
    options.signal?.throwIfAborted();
    return result;
  };
  const progress: SkillSourceScanProgress = { type: 'progress', phase: 'connecting', totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null };
  const report = async () => {
    options.signal?.throwIfAborted();
    await options.onProgress?.({ ...progress });
  };
  await report();
  const parsed = parseSkillRepository(input.repositoryUrl);
  const repo = await read(`/repos/${parsed.fullName}`) as { id: number; full_name: string; default_branch: string };
  if (!repo.id || !repo.full_name || !repo.default_branch) throw unprocessable('GitHub returned incomplete repository information.');
  const canonical = parseSkillRepository(`https://github.com/${repo.full_name}`);
  const requestedRef = input.trackingRef || parsed.trackingRef;
  const trackingRef = !requestedRef || requestedRef === 'HEAD' ? repo.default_branch : requestedRef;
  // Re-resolve moving branches, then use the immutable commit for caller-scoped
  // cache lookup. Repeated discovery can reuse bytes without hiding new commits.
  const resolved = input.commitSha ? { sha: input.commitSha }
    : await read(`/repos/${canonical.fullName}/commits/${encodeURIComponent(trackingRef)}`) as { sha: string };
  if (!/^[a-f0-9]{40}$/i.test(resolved.sha)) throw unprocessable('GitHub did not return an immutable commit.');
  progress.phase = 'downloading';
  await report();
  const snapshot = await providerRead.openSnapshot({ repositoryUrl: canonical.repositoryUrl, ref: trackingRef, commitSha: resolved.sha }, {
    signal: options.signal,
    onDownload: async download => { progress.download = download; await report(); },
  });
  try {
    const commit = { sha: snapshot.commitSha };
    if (!/^[a-f0-9]{40}$/i.test(commit.sha)) throw unprocessable('Git did not return an immutable commit.');
    progress.phase = 'listing';
    delete progress.download;
    await report();
    const entries = snapshot.entries;
    for (const entry of entries) {
      assertSkillSnapshotPath(entry.path);
      if (entry.path.length > 4_096 || entry.path.split('/').length > 64) throw unprocessable('Repository paths exceed the 4,096 character or 64-level scan limit.');
    }
    const repositoryPaths = indexSkillPackagePaths(entries.map(entry => entry.path));
    const roots = entries.filter(e => e.type === 'blob' && /(^|\/)skill\.md$/i.test(e.path) && ['100644', '100755'].includes(e.mode));
    const rootsByDirectory = new Map<string, TreeEntry[]>();
    for (const root of roots) {
      const dir = path.posix.dirname(root.path);
      const siblings = rootsByDirectory.get(dir) ?? [];
      siblings.push(root);
      rootsByDirectory.set(dir, siblings);
    }
    const selectedRoots = roots.filter(root => input.packageMode === 'repository' || !input.onlySkillPath || root.path === input.onlySkillPath).sort((a, b) => a.path.localeCompare(b.path));
    if (selectedRoots.length > MAX_SCAN_PACKAGES) throw unprocessable('Repository exceeds the 1,000 skill package scan limit.');
    // Assign each file to its nearest package root once, including hidden and
    // nested directories. Memoized ancestors avoid a full-tree pass per skill.
    const owners = new Map<string, string | null>([...rootsByDirectory.keys()].map(dir => [dir, dir]));
    const inventories = new Map<string, TreeEntry[]>();
    const selectedDirectories = new Set(selectedRoots.map(root => path.posix.dirname(root.path)));
    for (const entry of entries) {
      if (entry.type === 'tree') continue;
      let dir = path.posix.dirname(entry.path);
      const ancestors: string[] = [];
      while (!owners.has(dir)) {
        ancestors.push(dir);
        if (dir === '.') { owners.set(dir, null); break; }
        dir = path.posix.dirname(dir);
      }
      const owner = owners.get(dir) ?? null;
      for (const ancestor of ancestors) owners.set(ancestor, owner);
      if (owner !== null && selectedDirectories.has(owner)) {
        const inventory = inventories.get(owner) ?? [];
        inventory.push(entry);
        inventories.set(owner, inventory);
      }
    }
    let expandedFiles = 0;
    let declaredBytes = 0;
    for (const root of selectedRoots) {
      const inventory = inventories.get(path.posix.dirname(root.path)) ?? [];
      expandedFiles += inventory.length;
      if (expandedFiles > MAX_SCAN_FILES) throw unprocessable('Skill packages exceed the 10,000 file scan limit.');
      for (const entry of inventory) {
        if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && (entry.size ?? 0) <= MAX_FILE_BYTES) declaredBytes += entry.size ?? 0;
      }
      if (declaredBytes > MAX_SCAN_BYTES) throw unprocessable('Skill packages exceed the 100 MB scan limit.');
    }
    const warnings = entries.filter(e => e.mode === '120000' || e.type === 'commit').map(e => `${e.path} — ${e.mode === '120000' ? 'Symlink' : 'Submodule'} couldn’t be included.`);
    const dependencyBlobs = new Map<string, Buffer>();
    let dependencyBytes = 0;
    const repositoryInventory = input.packageMode !== 'repository' ? null : options.repositorySubset
      ? await skillRepositoryDependencies(entries, [...inventories.values()].flat(), selectedDirectories, async entry => {
        if ((entry.size ?? 0) > MAX_FILE_BYTES) return null;
        options.signal?.throwIfAborted();
        const bytes = dependencyBlobs.get(entry.sha) ?? await snapshot.readBlob(entry, options.signal);
        if (bytes.length > MAX_FILE_BYTES) return null;
        dependencyBytes += bytes.length;
        if (dependencyBytes > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the 61 MB runtime limit.');
        dependencyBlobs.set(entry.sha, bytes);
        return bytes;
      }, snapshot.readBlobs ? async pending => {
        options.signal?.throwIfAborted();
        const unread = pending.filter(entry => !dependencyBlobs.has(entry.sha) && (entry.size ?? 0) <= MAX_FILE_BYTES);
        if (unread.length) for (const [sha, bytes] of await snapshot.readBlobs!(unread, options.signal)) dependencyBlobs.set(sha, bytes);
      } : undefined) : entries.filter(entry => entry.type !== 'tree');
    if (repositoryInventory && repositoryInventory.length > MAX_REPOSITORY_FILES) throw unprocessable('Repository package exceeds the 9,990 file limit.');
    const readable = repositoryInventory?.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && (entry.size ?? 0) <= MAX_FILE_BYTES);
    if (readable && readable.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the 61 MB runtime limit.');
    // A single bounded batch supplies both skill manifests and support files.
    const blobs = dependencyBlobs;
    if (readable && snapshot.readBlobs) {
      const remaining = readable.filter(entry => !blobs.has(entry.sha));
      if (remaining.length) for (const [sha, bytes] of await snapshot.readBlobs(remaining, options.signal)) blobs.set(sha, bytes);
    }
    let totalBytes = 0;
    const readBlob = async (entry: TreeEntry) => {
      if ((entry.size ?? 0) > MAX_FILE_BYTES) return null;
      let bytes = blobs.get(entry.sha);
      if (!bytes) {
        options.signal?.throwIfAborted();
        bytes = await snapshot.readBlob(entry, options.signal);
        if (bytes.length > MAX_FILE_BYTES) return null;
        blobs.set(entry.sha, bytes);
      }
      // Reused blobs still produce another package copy, audit, and manifest.
      totalBytes += bytes.length;
      if (totalBytes > MAX_SCAN_BYTES) throw unprocessable('Skill packages exceed the 100 MB scan limit.');
      return bytes;
    };
    const skills: DiscoveredSkill[] = [];
    Object.assign(progress, { phase: 'checking', totalSkills: selectedRoots.length, currentPath: null });
    await report();
    for (const root of selectedRoots) {
      const dir = path.posix.dirname(root.path);
      const prefix = dir === '.' ? '' : `${dir}/`;
      const inventory = inventories.get(dir) ?? [];
      Object.assign(progress, { currentPath: root.path, checkedFiles: 0, totalFiles: inventory.length });
      await report();
      const files: CompanySkillVersionFileInventoryEntry[] = [];
      const fileWarnings: string[] = [];
      let error: string | null = rootsByDirectory.get(dir)!.length > 1 ? 'Multiple SKILL.md entrypoints share this package directory.' : null;
      for (const entry of inventory) {
        progress.currentPath = entry.path;
        await report();
        progress.checkedFiles++;
        if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') { fileWarnings.push(`${entry.path} — ${entry.mode === '120000' ? 'Symlink' : 'Submodule'} couldn’t be included.`); continue; }
        const bytes = await readBlob(entry);
        if (!bytes) { fileWarnings.push(`${entry.path} — Exceeds the 1 MB file limit; not included.`); continue; }
        const relative = entry.path === root.path ? 'SKILL.md' : entry.path.slice(prefix.length);
        const kind = relative !== 'SKILL.md' && (entry.mode === '100755' || bytes.subarray(0, 2).toString() === '#!') ? 'script' : classifyInventoryKind(relative);
        files.push(snapshotFile(relative, kind, bytes, entry.mode === '100755'));
      }
      const markdown = files.find(f => f.path === 'SKILL.md');
      if (!markdown) error = 'SKILL.md couldn’t be included.';
      const frontmatter = markdown && markdown.encoding !== 'base64' ? parseFrontmatterMarkdown(markdown.content).frontmatter : {};
      if (markdown?.encoding === 'base64') error = 'SKILL.md must contain UTF-8 text.';
      const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : path.posix.basename(dir) || repo.full_name;
      const description = typeof frontmatter.description === 'string' ? frontmatter.description : null;
      const findings = !error ? await auditSkillSnapshot(files) : [];
      error ??= findings.filter(f => f.severity === 'error').map(f => `${f.path ?? root.path}: ${f.message}`).join(' ') || null;
      const inspection = { ...inspectSkillPackage(root.path, files, repositoryPaths, frontmatter, findings), commitSha: commit.sha };
      inspection.warnings.push(...fileWarnings);
      skills.push({ path: root.path, name, description, fileCount: inventory.length, error, warnings: inspection.warnings, inspection, files: options.retainFiles === false ? [] : files });
      options.signal?.throwIfAborted();
      await options.onProgress?.({ type: 'candidate', candidate: { path: root.path, name, description, fileCount: inventory.length, error } });
      progress.checkedSkills++;
      await report();
    }
    let repositoryFiles: CompanySkillVersionFileInventoryEntry[] | undefined;
    let repositoryPackage: ReturnType<typeof repositoryPackageInspection> | undefined;
    if (input.packageMode === 'repository') {
      const inventory = repositoryInventory!;
      repositoryFiles = [];
      const packageWarnings = [...warnings];
      if (options.repositorySubset) packageWarnings.push('Only skill folders and referenced files were included because the repository exceeds the supported package size.');
      totalBytes = 0;
      Object.assign(progress, { currentPath: null, checkedFiles: 0, totalFiles: inventory.length });
      for (const entry of inventory) {
        options.signal?.throwIfAborted();
        if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') {
          continue;
        }
        const bytes = await readBlob(entry);
        if (!bytes) { packageWarnings.push(`${entry.path} — Exceeds the 1 MB file limit; not included.`); continue; }
        if (totalBytes > MAX_REPOSITORY_BYTES) throw unprocessable('Repository package exceeds the 61 MB runtime limit.');
        const kind = entry.mode === '100755' || bytes.subarray(0, 2).toString() === '#!'
          ? 'script' : classifyInventoryKind(entry.path);
        repositoryFiles.push(snapshotFile(entry.path, kind, bytes, entry.mode === '100755'));
        progress.currentPath = entry.path;
        progress.checkedFiles++;
        await report();
      }
      const findings = await auditSkillSnapshot(repositoryFiles, false);
      const unsafe = findings.filter(f => f.severity === 'error' && ['remote_fetch_exec', 'secret_exfiltration'].includes(f.code));
      if (unsafe.some(f => !f.path)) throw unprocessable('Repository audit could not identify an unsafe file.');
      const omitted = new Map(unsafe.map(f => [f.path!, `${f.path} — ${f.message} File not included.`]));
      repositoryFiles = repositoryFiles.filter(file => !omitted.has(file.path));
      repositoryPackage = repositoryPackageInspection(repositoryFiles, roots.map(root => root.path),
        [...new Set([...packageWarnings, ...omitted.values(), ...findings.filter(f => f.severity === 'error' && !omitted.has(f.path!)).map(f => `${f.path}: ${f.message}`)])], null);
      const included = indexSkillPackagePaths(repositoryFiles.map(file => file.path));
      const byPath = new Map(repositoryFiles.map(file => [file.path, file]));
      for (const skill of skills) {
        if (skill.inspection) {
          const dir = path.posix.dirname(skill.path);
          const repositoryPath = (relative: string) => relative === 'SKILL.md' ? skill.path : path.posix.join(dir, relative);
          const omittedWarnings = skill.inspection.files.flatMap(file => {
            const warning = omitted.get(repositoryPath(file.path));
            return warning ? [warning] : [];
          });
          if (omittedWarnings.length) {
            const supported = skill.inspection.files.flatMap(file => {
              const original = byPath.get(repositoryPath(file.path));
              return original ? [{ ...original, path: file.path, kind: file.path === 'SKILL.md' ? 'skill' as const : original.kind === 'script' ? 'script' as const : classifyInventoryKind(file.path) }] : [];
            });
            const markdown = supported.find(file => file.path === 'SKILL.md');
            const frontmatter = markdown && markdown.encoding !== 'base64' ? parseFrontmatterMarkdown(markdown.content).frontmatter : {};
            const remainingFindings = await auditSkillSnapshot(supported);
            skill.error = rootsByDirectory.get(dir)!.length > 1 ? 'Multiple SKILL.md entrypoints share this package directory.'
              : remainingFindings.filter(f => f.severity === 'error').map(f => `${f.path}: ${f.message}`).join(' ') || null;
            const fileWarnings = skill.inspection.warnings.filter(warning => warning.includes('not included') || warning.includes('couldn’t be included'));
            skill.inspection = { ...inspectSkillPackage(skill.path, supported, included, frontmatter, remainingFindings), commitSha: commit.sha };
            skill.inspection.warnings.push(...fileWarnings, ...omittedWarnings);
            skill.warnings = skill.inspection.warnings;
            skill.fileCount = supported.length;
            skill.files = options.retainFiles === false ? [] : supported;
          }
        }
        if (skill.inspection) skill.inspection.references = skill.inspection.references.filter(ref => !included.has(ref.resolvedPath));
      }
    }
    return { treeSha: snapshot.treeSha, downloadBytes: snapshot.downloadBytes, ...(options.repositorySubset ? { repositorySubset: true } : {}),
      scanBytes: Math.min(MAX_SCAN_BYTES, snapshot.entries.reduce((sum, entry) => sum + (entry.type === 'blob' ? entry.size ?? MAX_SCAN_BYTES : 0), 0)),
      ...(input.packageMode ? { packageMode: input.packageMode } : {}), ...(repositoryPackage ? { repositoryPackage } : {}),
      ...(repositoryFiles && options.retainFiles !== false ? { repositoryFiles } : {}),
      connectionId: providerRead.connectionId ?? null, repositoryId: String(repo.id), repositoryUrl: `https://github.com/${repo.full_name.toLowerCase()}`, fullName: repo.full_name, trackingRef, commitSha: commit.sha,
      defaultBranch: repo.default_branch, candidates: skills.map(({ files: _files, ...candidate }) => candidate), warnings, skills };
  } finally { await snapshot.release(); }
}

/** Reauthorize the caller and re-audit the selected package; never trust a client-supplied manifest. */
export async function previewGitHubSkillFile(input: SkillSourcePreviewRequest, read: GitHubRead): Promise<SkillSourceFilePreview> {
  const scan = await scanGitHubSkillsWithPackageFallback({ ...input, onlySkillPath: input.skillPath }, read);
  if (scan.commitSha.toLowerCase() !== input.commitSha.toLowerCase()) throw unprocessable('The preview commit did not match the requested snapshot.');
  const skill = scan.skills.find(candidate => candidate.path === input.skillPath);
  if (!skill) throw notFound('Skill package not found at this commit.');
  const file = (input.packageMode === 'repository' ? scan.repositoryFiles : skill.files)?.find(file => file.path === input.filePath);
  const manifest = (input.packageMode === 'repository' ? scan.repositoryPackage?.files : skill.inspection?.files)?.find(file => file.path === input.filePath);
  if (!file || !manifest) throw notFound('File is not included in this skill package.');
  const bytes = skillFileBytes(file);
  const limit = 64 * 1024;
  return { file: manifest, content: manifest.encoding === 'base64' ? null : bytes.subarray(0, limit).toString('utf8'),
    truncated: manifest.encoding !== 'base64' && bytes.length > limit, commitSha: scan.commitSha };
}
