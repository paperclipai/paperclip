import path from 'node:path';
import type { CompanySkillVersionFileInventoryEntry, SkillSourceCandidate, SkillSourceDiscovery, SkillSourcePreviewRequest, SkillSourceFilePreview, SkillSourceScanUpdate, SkillSourceScanProgress } from '@paperclipai/shared';
import { parseFrontmatterMarkdown, parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { notFound, unprocessable } from '../errors.js';
import { assertSkillSnapshotPath, snapshotFile, skillFileBytes } from './skill-snapshot.js';
import { inspectSkillPackage } from './skill-package-inspection.js';
import { auditSkillSnapshot, classifyInventoryKind } from './company-skills.js';

import type { GitSkillSnapshot, GitSkillSnapshotOptions, GitSkillTreeEntry as TreeEntry } from './skill-source-git-snapshot.js';

export interface GitHubRead {
  (apiPath: string, signal?: AbortSignal): Promise<unknown>;
  openSnapshot: (input: { repositoryUrl: string; ref: string; commitSha?: string }, options?: GitSkillSnapshotOptions) => Promise<GitSkillSnapshot>;
  readonly connectionId?: string | null;
}
export type DiscoveredSkill = SkillSourceCandidate & { files: CompanySkillVersionFileInventoryEntry[] };
export type ScannedSkillSource = SkillSourceDiscovery & { skills: DiscoveredSkill[]; defaultBranch: string };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 100 * 1024 * 1024;

export function parseSkillRepository(url: string) {
  const parsed = parseGitHubSkillRepositoryUrl(url);
  if (!parsed) throw unprocessable('Enter an HTTPS GitHub repository or branch URL without credentials.');
  return parsed;
}

export interface SkillScanOptions {
  signal?: AbortSignal;
  onProgress?: (event: SkillSourceScanUpdate) => void | Promise<void>;
}

export async function scanGitHubSkills(input: { repositoryUrl: string; trackingRef?: string; commitSha?: string; onlySkillPath?: string }, providerRead: GitHubRead, options: SkillScanOptions = {}): Promise<ScannedSkillSource> {
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
  progress.phase = 'downloading';
  await report();
  const snapshot = await providerRead.openSnapshot({ repositoryUrl: canonical.repositoryUrl, ref: trackingRef, commitSha: input.commitSha }, {
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
    for (const entry of entries) assertSkillSnapshotPath(entry.path);
    const roots = entries.filter(e => e.type === 'blob' && /(^|\/)skill\.md$/i.test(e.path) && ['100644', '100755'].includes(e.mode));
    const directories = new Set(roots.map(e => path.posix.dirname(e.path)));
    const warnings = entries.filter(e => e.mode === '120000' || e.type === 'commit').map(e => `Not followed: ${e.path} (${e.mode === '120000' ? 'symlink' : 'submodule'}).`);
    const blobs = new Map<string, Buffer>();
    let totalBytes = 0;
    const readBlob = async (entry: TreeEntry) => {
      if ((entry.size ?? 0) > MAX_FILE_BYTES) return null;
      let bytes = blobs.get(entry.sha);
      if (!bytes) {
        options.signal?.throwIfAborted();
        bytes = await snapshot.readBlob(entry, options.signal);
        totalBytes += bytes.length;
        if (totalBytes > MAX_SCAN_BYTES) throw unprocessable('Skill packages exceed the 100 MB scan limit.');
        if (bytes.length > MAX_FILE_BYTES) return null;
        blobs.set(entry.sha, bytes);
      }
      return bytes;
    };
    const skills: DiscoveredSkill[] = [];
    const selectedRoots = roots.filter(root => !input.onlySkillPath || root.path === input.onlySkillPath).sort((a, b) => a.path.localeCompare(b.path));
    Object.assign(progress, { phase: 'checking', totalSkills: selectedRoots.length, currentPath: null });
    await report();
    for (const root of selectedRoots) {
      const dir = path.posix.dirname(root.path);
      const prefix = dir === '.' ? '' : `${dir}/`;
      const owns = (entry: TreeEntry) => {
        if (!entry.path.startsWith(prefix)) return false;
        let parent = path.posix.dirname(entry.path);
        while (parent !== dir && parent !== '.') {
          if (directories.has(parent)) return false;
          parent = path.posix.dirname(parent);
        }
        return parent === dir;
      };
      const inventory = entries.filter(e => e.type !== 'tree' && owns(e));
      Object.assign(progress, { currentPath: root.path, checkedFiles: 0, totalFiles: inventory.length });
      await report();
      const files: CompanySkillVersionFileInventoryEntry[] = [];
      let error: string | null = roots.filter(entry => path.posix.dirname(entry.path) === dir).length > 1 ? 'Multiple SKILL.md entrypoints share this package directory.' : null;
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
      const inspection = { ...inspectSkillPackage(root.path, files, entries.map(entry => entry.path), frontmatter, findings), commitSha: commit.sha };
      skills.push({ path: root.path, name, description, fileCount: inventory.length, error, warnings: inspection.warnings, inspection, files });
      options.signal?.throwIfAborted();
      await options.onProgress?.({ type: 'candidate', candidate: { path: root.path, name, description, fileCount: inventory.length, error } });
      progress.checkedSkills++;
      await report();
    }
    return { connectionId: providerRead.connectionId ?? null, repositoryId: String(repo.id), repositoryUrl: `https://github.com/${repo.full_name.toLowerCase()}`, fullName: repo.full_name, trackingRef, commitSha: commit.sha,
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
  const file = skill.files.find(file => file.path === input.filePath);
  const manifest = skill.inspection?.files.find(file => file.path === input.filePath);
  if (!file || !manifest) throw notFound('File is not included in this skill package.');
  const bytes = skillFileBytes(file);
  const limit = 64 * 1024;
  return { file: manifest, content: manifest.encoding === 'base64' ? null : bytes.subarray(0, limit).toString('utf8'),
    truncated: manifest.encoding !== 'base64' && bytes.length > limit, commitSha: scan.commitSha };
}
