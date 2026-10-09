import path from 'node:path';
import { repositoryPackageInspection } from './skill-repository-package.js';
import type { CompanySkillVersionFileInventoryEntry, SkillSourceCandidate, SkillSourceDiscovery, SkillSourcePreviewRequest, SkillSourceFilePreview, SkillSourceScanUpdate, SkillSourceScanProgress } from '@paperclipai/shared';
import { parseFrontmatterMarkdown, parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { notFound, unprocessable } from '../errors.js';
import { assertSkillSnapshotPath, snapshotFile, skillFileBytes } from './skill-snapshot.js';
import { indexSkillPackagePaths, inspectSkillPackage } from './skill-package-inspection.js';
import { auditSkillSnapshot, classifyInventoryKind } from './company-skills.js';

import type { GitSkillSnapshot, GitSkillSnapshotOptions, GitSkillTreeEntry as TreeEntry } from './skill-source-git-snapshot.js';

export interface GitHubRead {
  (apiPath: string, signal?: AbortSignal): Promise<unknown>;
  withScan?: <T>(operation: () => Promise<T>) => Promise<T>;
  openSnapshot: (input: { repositoryUrl: string; ref: string; commitSha?: string }, options?: GitSkillSnapshotOptions) => Promise<GitSkillSnapshot>;
  readonly connectionId?: string | null;
}
export type DiscoveredSkill = SkillSourceCandidate & { files: CompanySkillVersionFileInventoryEntry[] };
export type ScannedSkillSource = SkillSourceDiscovery & { skills: DiscoveredSkill[]; defaultBranch: string; repositoryFiles?: CompanySkillVersionFileInventoryEntry[] };
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
}

type SkillScanInput = { packageMode?: 'skills' | 'repository'; repositoryUrl: string; trackingRef?: string; commitSha?: string; onlySkillPath?: string };

export function scanGitHubSkills(input: SkillScanInput, providerRead: GitHubRead, options: SkillScanOptions = {}): Promise<ScannedSkillSource> {
  const scan = () => scanRepository(input, providerRead, options);
  return providerRead.withScan ? providerRead.withScan(scan) : scan();
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
    const warnings = entries.filter(e => e.mode === '120000' || e.type === 'commit').map(e => `Not followed: ${e.path} (${e.mode === '120000' ? 'symlink' : 'submodule'}).`);
    const blobs = new Map<string, Buffer>();
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
      let error: string | null = rootsByDirectory.get(dir)!.length > 1 ? 'Multiple SKILL.md entrypoints share this package directory.' : null;
      for (const entry of inventory) {
        progress.currentPath = entry.path;
        await report();
        progress.checkedFiles++;
        if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') { error = `Unsupported symlink or submodule: ${entry.path}`; continue; }
        const bytes = await readBlob(entry);
        if (!bytes) { error = `File exceeds the 1 MB limit: ${entry.path}`; continue; }
        const relative = entry.path === root.path ? 'SKILL.md' : entry.path.slice(prefix.length);
        const kind = relative !== 'SKILL.md' && (entry.mode === '100755' || bytes.subarray(0, 2).toString() === '#!') ? 'script' : classifyInventoryKind(relative);
        files.push(snapshotFile(relative, kind, bytes, entry.mode === '100755'));
      }
      const markdown = files.find(f => f.path === 'SKILL.md');
      const frontmatter = markdown && markdown.encoding !== 'base64' ? parseFrontmatterMarkdown(markdown.content).frontmatter : {};
      if (markdown?.encoding === 'base64') error = 'SKILL.md must contain UTF-8 text.';
      const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : path.posix.basename(dir) || repo.full_name;
      const description = typeof frontmatter.description === 'string' ? frontmatter.description : null;
      const findings = !error ? await auditSkillSnapshot(files) : [];
      error ??= findings.filter(f => f.severity === 'error').map(f => `${f.path ?? root.path}: ${f.message}`).join(' ') || null;
      const inspection = { ...inspectSkillPackage(root.path, files, repositoryPaths, frontmatter, findings), commitSha: commit.sha };
      skills.push({ path: root.path, name, description, fileCount: inventory.length, error, warnings: inspection.warnings, inspection, files: options.retainFiles === false ? [] : files });
      options.signal?.throwIfAborted();
      await options.onProgress?.({ type: 'candidate', candidate: { path: root.path, name, description, fileCount: inventory.length, error } });
      progress.checkedSkills++;
      await report();
    }
    let repositoryFiles: CompanySkillVersionFileInventoryEntry[] | undefined;
    let repositoryPackage: ReturnType<typeof repositoryPackageInspection> | undefined;
    if (input.packageMode === 'repository') {
      const inventory = entries.filter(entry => entry.type !== 'tree');
      if (inventory.length > 9_990) throw unprocessable('Repository package exceeds the 9,990 file limit.');
      repositoryFiles = [];
      let packageError: string | null = skills.find(skill => skill.error)?.error ?? null;
      totalBytes = 0;
      Object.assign(progress, { currentPath: null, checkedFiles: 0, totalFiles: inventory.length });
      for (const entry of inventory) {
        options.signal?.throwIfAborted();
        if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') {
          packageError ??= `Unsupported symlink or submodule: ${entry.path}`; continue;
        }
        const bytes = await readBlob(entry);
        if (!bytes) { packageError ??= `File exceeds the 1 MB limit: ${entry.path}`; continue; }
        if (totalBytes > 61 * 1024 * 1024) throw unprocessable('Repository package exceeds the 61 MB runtime limit.');
        const kind = entry.mode === '100755' || bytes.subarray(0, 2).toString() === '#!'
          ? 'script' : classifyInventoryKind(entry.path);
        repositoryFiles.push(snapshotFile(entry.path, kind, bytes, entry.mode === '100755'));
        progress.currentPath = entry.path;
        progress.checkedFiles++;
        await report();
      }
      const findings = await auditSkillSnapshot(repositoryFiles, false);
      packageError ??= findings.filter(f => f.severity === 'error').map(f => `${f.path}: ${f.message}`).join(' ') || null;
      repositoryPackage = repositoryPackageInspection(repositoryFiles, roots.map(root => root.path),
        [...new Set(findings.filter(f => f.severity === 'warning' && f.code !== 'broken_internal_link').map(f => f.message))], packageError);
      const included = indexSkillPackagePaths(repositoryFiles.map(file => file.path));
      for (const skill of skills) {
        skill.error = repositoryPackage.error ?? skill.error;
        if (skill.inspection) skill.inspection.references = skill.inspection.references.filter(ref => !included.has(ref.resolvedPath));
      }
    }
    return { ...(input.packageMode ? { packageMode: input.packageMode } : {}), ...(repositoryPackage ? { repositoryPackage } : {}),
      ...(repositoryFiles && options.retainFiles !== false ? { repositoryFiles } : {}),
      connectionId: providerRead.connectionId ?? null, repositoryId: String(repo.id), repositoryUrl: `https://github.com/${repo.full_name.toLowerCase()}`, fullName: repo.full_name, trackingRef, commitSha: commit.sha,
      defaultBranch: repo.default_branch, candidates: skills.map(({ files: _files, ...candidate }) => candidate), warnings, skills };
  } finally { await snapshot.release(); }
}

/** Reauthorize the caller and re-audit the selected package; never trust a client-supplied manifest. */
export async function previewGitHubSkillFile(input: SkillSourcePreviewRequest, read: GitHubRead): Promise<SkillSourceFilePreview> {
  const scan = await scanGitHubSkills({ ...input, onlySkillPath: input.skillPath }, read);
  if (scan.commitSha.toLowerCase() !== input.commitSha.toLowerCase()) throw unprocessable('The preview commit did not match the requested snapshot.');
  const skill = scan.skills.find(candidate => candidate.path === input.skillPath);
  if (!skill) throw notFound('Skill package not found at this commit.');
  if (skill.error) throw unprocessable(`Preview unavailable: ${skill.error}`);
  const file = (input.packageMode === 'repository' ? scan.repositoryFiles : skill.files)?.find(file => file.path === input.filePath);
  const manifest = (input.packageMode === 'repository' ? scan.repositoryPackage?.files : skill.inspection?.files)?.find(file => file.path === input.filePath);
  if (!file || !manifest) throw notFound('File is not included in this skill package.');
  const bytes = skillFileBytes(file);
  const limit = 64 * 1024;
  return { file: manifest, content: manifest.encoding === 'base64' ? null : bytes.subarray(0, limit).toString('utf8'),
    truncated: manifest.encoding !== 'base64' && bytes.length > limit, commitSha: scan.commitSha };
}
