import path from 'node:path';
import type { CompanySkillVersionFileInventoryEntry, SkillSourceUpdateDiffFile, SkillSourcePackageMode } from '@paperclipai/shared';
import { unprocessable } from '../errors.js';
import { scanGitHubSkillsWithPackageFallback, type GitHubRead, type ScannedSkillSource } from './github-skill-source.js';

// Bounded LCS work for one file, after trimming the shared head and tail of the two files.
const MAX_DIFF_CELLS = 4_000_000;
// One response shares these budgets across all of its files, so a large update
// cannot hold the event loop or produce an unbounded response body.
export const MAX_UPDATE_DIFF_CELLS = 24_000_000;
export const MAX_UPDATE_DIFF_CHARS = 1_000_000;
export const MAX_UPDATE_DIFF_FILES = 1_000;
const CONTEXT_LINES = 3;
const NO_FINAL_NEWLINE = '\n\\ No newline at end of file';

type Row = { kind: ' ' | '-' | '+'; text: string; oldLine: number; newLine: number };
type LineDiff = { diff: string | null; cells: number };

/** The lines of a file. An empty file has none; a last line without a final newline carries the unified-diff marker. */
function fileLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else lines[lines.length - 1] += NO_FINAL_NEWLINE;
  return lines;
}

function lineDiff(before: string, after: string, maxCells: number): LineDiff {
  if (before === after) return { diff: '', cells: 0 };
  const a = fileLines(before), b = fileLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  const cells = (midA.length + 1) * (midB.length + 1);
  if (cells > maxCells) return { diff: null, cells };
  const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--)
    lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const rows: Row[] = [];
  for (let k = 0; k < head; k++) rows.push({ kind: ' ', text: a[k]!, oldLine: k + 1, newLine: k + 1 });
  let i = 0, j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) { rows.push({ kind: ' ', text: midA[i]!, oldLine: head + i + 1, newLine: head + j + 1 }); i++; j++; }
    // On a tie the installed line goes first, so a replaced line reads "-old" then "+new".
    else if (i < midA.length && (j >= midB.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { rows.push({ kind: '-', text: midA[i]!, oldLine: head + i + 1, newLine: head + j }); i++; }
    else { rows.push({ kind: '+', text: midB[j]!, oldLine: head + i, newLine: head + j + 1 }); j++; }
  }
  for (let k = 0; k < tail; k++) rows.push({ kind: ' ', text: a[a.length - tail + k]!, oldLine: a.length - tail + k + 1, newLine: b.length - tail + k + 1 });
  const changed = rows.map((row, index) => row.kind === ' ' ? -1 : index).filter(index => index >= 0);
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES), end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end); else hunks.push([start, end]);
  }
  const diff = hunks.map(([start, end]) => {
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter(row => row.kind !== '+').length, newCount = slice.filter(row => row.kind !== '-').length;
    // As in unified diff, a side with no lines starts at the line before the hunk (0 for an empty file).
    const oldStart = oldCount ? slice.find(row => row.kind !== '+')!.oldLine : slice[0]!.oldLine;
    const newStart = newCount ? slice.find(row => row.kind !== '-')!.newLine : slice[0]!.newLine;
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map(row => `${row.kind}${row.text}`)].join('\n');
  }).join('\n');
  return { diff, cells };
}

/** Unified line diff from `before` (installed) to `after` (latest); "" when equal, null when too large. */
export function unifiedLineDiff(before: string, after: string): string | null {
  return lineDiff(before, after, MAX_DIFF_CELLS).diff;
}

type DiffFile = Pick<CompanySkillVersionFileInventoryEntry, 'path' | 'content' | 'encoding' | 'executable'>;
/** Paths that a source scan left out of each snapshot (too large, a symlink, or rejected by the audit). */
export type OmittedPaths = { installed: ReadonlySet<string>; latest: ReadonlySet<string> };
export type SkillPackageDiff = { files: SkillSourceUpdateDiffFile[]; truncated: boolean };

/** Per-file changes between two snapshots of one skill package, sorted by path. */
export function diffSkillPackageFiles(installed: DiffFile[], latest: DiffFile[], omitted: OmittedPaths = { installed: new Set(), latest: new Set() }): SkillPackageDiff {
  const before = new Map(installed.map(file => [file.path, file])), after = new Map(latest.map(file => [file.path, file]));
  const text = (file: DiffFile) => file.encoding !== 'base64' ? file.content : null;
  const paths = [...new Set([...before.keys(), ...after.keys(), ...omitted.installed, ...omitted.latest])].sort();
  const files: SkillSourceUpdateDiffFile[] = [];
  let cells = 0, chars = 0, truncated = false;
  for (const filePath of paths) {
    const old = before.get(filePath), next = after.get(filePath);
    if (omitted.installed.has(filePath) || omitted.latest.has(filePath)) {
      // Without both snapshots of this path, any added/removed/modified claim would be a guess.
      files.push({ path: filePath, change: 'not_compared', binary: false, executableChanged: false, diff: null, diffUnavailable: 'omitted' });
    } else {
      const sameContent = !!old && !!next && old.content === next.content && (old.encoding ?? 'utf8') === (next.encoding ?? 'utf8');
      const executableChanged = !!old && !!next && !!old.executable !== !!next.executable;
      if (sameContent && !executableChanged) continue;
      const change = !old ? 'added' as const : !next ? 'removed' as const : 'modified' as const;
      const oldText = old ? text(old) : '', newText = next ? text(next) : '';
      const binary = oldText === null || newText === null;
      let diff: string | null = null;
      let diffUnavailable: SkillSourceUpdateDiffFile['diffUnavailable'] = binary ? 'binary' : null;
      if (!binary) {
        const result = lineDiff(oldText, newText, Math.min(MAX_DIFF_CELLS, MAX_UPDATE_DIFF_CELLS - cells));
        if (result.diff === null) {
          diffUnavailable = result.cells > MAX_DIFF_CELLS ? 'too_large' : 'budget';
          truncated ||= diffUnavailable === 'budget';
        } else if (chars + result.diff.length > MAX_UPDATE_DIFF_CHARS) {
          cells += result.cells;
          diffUnavailable = 'budget';
          truncated = true;
        } else {
          cells += result.cells;
          chars += result.diff.length;
          diff = result.diff;
        }
      }
      files.push({ path: filePath, change, binary, executableChanged, diff, diffUnavailable });
    }
    if (files.length >= MAX_UPDATE_DIFF_FILES && filePath !== paths.at(-1)) { truncated = true; break; }
  }
  return { files, truncated };
}

const OMITTED_FILE_WARNING = /^(.+?) — .*(?:not included|couldn’t be included)\.?$/;
function omittedPaths(warnings: Iterable<string>, toPackagePath: (repositoryPath: string) => string | null) {
  const paths = new Set<string>();
  for (const warning of warnings) {
    const match = OMITTED_FILE_WARNING.exec(warning);
    const packagePath = match ? toPackagePath(match[1]!) : null;
    if (packagePath) paths.add(packagePath);
  }
  return paths;
}

type Snapshot = { files: DiffFile[]; omitted: Set<string> } | { partialReason: string };
function packageSnapshot(scan: ScannedSkillSource, input: { packageMode?: SkillSourcePackageMode; skillPath: string }): Snapshot {
  if (input.packageMode === 'repository') {
    // A repository that outgrew the package limits is scanned as a subset or as
    // skill folders only; files missing from such a scan may still exist upstream.
    if (scan.packageMode !== 'repository' || scan.repositorySubset || !scan.repositoryFiles) {
      return { partialReason: 'The repository is larger than the supported package size, so its revisions cannot be compared file by file.' };
    }
    return { files: scan.repositoryFiles, omitted: omittedPaths([...scan.warnings, ...(scan.repositoryPackage?.warnings ?? [])], repositoryPath => repositoryPath) };
  }
  const skill = scan.skills.find(candidate => candidate.path === input.skillPath);
  const dir = path.posix.dirname(input.skillPath);
  const prefix = dir === '.' ? '' : `${dir}/`;
  const toPackagePath = (repositoryPath: string) => repositoryPath === input.skillPath ? 'SKILL.md'
    : repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : null;
  return { files: skill?.files ?? [], omitted: omittedPaths(skill?.warnings ?? [], toPackagePath) };
}

export type GitHubSkillUpdateDiff = ({ supported: true } & SkillPackageDiff) | { supported: false; reason: string };

export async function diffGitHubSkillUpdate(
  input: { repositoryUrl: string; packageMode?: SkillSourcePackageMode; skillPath: string; installedCommitSha: string; latestCommitSha: string },
  read: GitHubRead,
  signal?: AbortSignal,
): Promise<GitHubSkillUpdateDiff> {
  const snapshotAt = async (commitSha: string) => {
    signal?.throwIfAborted();
    const scan = await scanGitHubSkillsWithPackageFallback({ repositoryUrl: input.repositoryUrl, packageMode: input.packageMode, commitSha, onlySkillPath: input.skillPath }, read, { signal });
    if (scan.commitSha.toLowerCase() !== commitSha.toLowerCase()) throw unprocessable('The source snapshot did not match the requested revision.');
    return packageSnapshot(scan, input);
  };
  const installed = await snapshotAt(input.installedCommitSha);
  if ('partialReason' in installed) return { supported: false, reason: installed.partialReason };
  const latest = await snapshotAt(input.latestCommitSha);
  if ('partialReason' in latest) return { supported: false, reason: latest.partialReason };
  signal?.throwIfAborted();
  return { supported: true, ...diffSkillPackageFiles(installed.files, latest.files, { installed: installed.omitted, latest: latest.omitted }) };
}
