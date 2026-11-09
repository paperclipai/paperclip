import type { CompanySkillVersionFileInventoryEntry, SkillSourceUpdateDiffFile, SkillSourcePackageMode } from '@paperclipai/shared';
import { unprocessable } from '../errors.js';
import { scanGitHubSkillsWithPackageFallback, type GitHubRead } from './github-skill-source.js';

// Bounded LCS work after trimming the shared head and tail of the two files.
const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

type Row = { kind: ' ' | '-' | '+'; text: string; oldLine: number; newLine: number };

/** Unified line diff from `before` (installed) to `after` (latest); "" when equal, null when too large. */
export function unifiedLineDiff(before: string, after: string): string | null {
  if (before === after) return '';
  const a = before.split('\n'), b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) return null;
  const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
  for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--)
    lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const rows: Row[] = [];
  for (let k = 0; k < head; k++) rows.push({ kind: ' ', text: a[k]!, oldLine: k + 1, newLine: k + 1 });
  let i = 0, j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) { rows.push({ kind: ' ', text: midA[i]!, oldLine: head + i + 1, newLine: head + j + 1 }); i++; j++; }
    else if (j < midB.length && (i >= midA.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) { rows.push({ kind: '+', text: midB[j]!, oldLine: head + i, newLine: head + j + 1 }); j++; }
    else { rows.push({ kind: '-', text: midA[i]!, oldLine: head + i + 1, newLine: head + j }); i++; }
  }
  for (let k = 0; k < tail; k++) rows.push({ kind: ' ', text: a[a.length - tail + k]!, oldLine: a.length - tail + k + 1, newLine: b.length - tail + k + 1 });
  const changed = rows.map((row, index) => row.kind === ' ' ? -1 : index).filter(index => index >= 0);
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES), end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end); else hunks.push([start, end]);
  }
  return hunks.map(([start, end]) => {
    const slice = rows.slice(start, end + 1);
    const oldCount = slice.filter(row => row.kind !== '+').length, newCount = slice.filter(row => row.kind !== '-').length;
    const oldStart = oldCount ? slice.find(row => row.kind !== '+')!.oldLine : slice[0]!.oldLine;
    const newStart = newCount ? slice.find(row => row.kind !== '-')!.newLine : slice[0]!.newLine;
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map(row => `${row.kind}${row.text}`)].join('\n');
  }).join('\n');
}

type DiffFile = Pick<CompanySkillVersionFileInventoryEntry, 'path' | 'content' | 'encoding'>;
/** Per-file changes between two snapshots of one skill package, sorted by path. */
export function diffSkillPackageFiles(installed: DiffFile[], latest: DiffFile[]): SkillSourceUpdateDiffFile[] {
  const before = new Map(installed.map(file => [file.path, file])), after = new Map(latest.map(file => [file.path, file]));
  const text = (file: DiffFile | undefined) => file && file.encoding !== 'base64' ? file.content : null;
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const old = before.get(path), next = after.get(path);
    if (old && next && old.content === next.content && old.encoding === next.encoding) return [];
    const change = !old ? 'added' as const : !next ? 'removed' as const : 'modified' as const;
    const oldText = old ? text(old) : '', newText = next ? text(next) : '';
    const binary = oldText === null || newText === null;
    return [{ path, change, binary, diff: binary ? null : unifiedLineDiff(oldText, newText) }];
  });
}

export async function diffGitHubSkillUpdate(input: { repositoryUrl: string; packageMode?: SkillSourcePackageMode; skillPath: string; installedCommitSha: string; latestCommitSha: string }, read: GitHubRead) {
  const filesAt = async (commitSha: string) => {
    const scan = await scanGitHubSkillsWithPackageFallback({ repositoryUrl: input.repositoryUrl, packageMode: input.packageMode, commitSha, onlySkillPath: input.skillPath }, read);
    if (scan.commitSha.toLowerCase() !== commitSha.toLowerCase()) throw unprocessable('The source snapshot did not match the requested revision.');
    const skill = scan.skills.find(candidate => candidate.path === input.skillPath);
    return (input.packageMode === 'repository' ? scan.repositoryFiles : skill?.files) ?? [];
  };
  return diffSkillPackageFiles(await filesAt(input.installedCommitSha), await filesAt(input.latestCommitSha));
}
