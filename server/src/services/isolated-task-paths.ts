import { lstat } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[a-zA-Z0-9_-]+$/;
type Identity = { companyId: string; issueId: string; attemptId?: string };

function compactId(id: string) { return BigInt(`0x${id.replace(/-/g, "")}`).toString(36).padStart(25, "0"); }
function expandId(value: string): string | null {
  if (!/^[0-9a-z]{25}$/.test(value)) return null;
  let number = 0n;
  for (const digit of value) number = number * 36n + BigInt(parseInt(digit, 36));
  const hex = number.toString(16).padStart(32, "0");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isolatedTaskPathSegments(input: Identity, platform = process.platform): string[] {
  const ids = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (ids.some(id => !SEGMENT.test(id))) throw new Error("Invalid isolated task workspace identity");
  if (platform === "win32" && input.attemptId && ids.every(id => UUID.test(id))) return ["w", ...ids.map(compactId)];
  return [input.attemptId ? "isolated-workspace-attempts" : "isolated-workspaces", ...ids];
}

export function readIsolatedTaskPath(instance: string, cwd: string) {
  const parts = path.relative(instance, cwd).split(path.sep);
  let companyId: string, issueId: string, attemptId: string | undefined, count: number;
  const compact = parts[0] === "w";
  if (compact) {
    const ids = parts.slice(1, 4).map(expandId);
    if (ids.length !== 3 || ids.some(id => !id)) return null;
    [companyId, issueId, attemptId] = ids as [string, string, string]; count = 4;
  } else if (parts[0] === "isolated-workspaces" || parts[0] === "isolated-workspace-attempts") {
    count = parts[0] === "isolated-workspaces" ? 3 : 4;
    const ids = parts.slice(1, count);
    if (ids.length !== count - 1 || ids.some(id => !SEGMENT.test(id))) return null;
    [companyId, issueId, attemptId] = ids as [string, string, string?];
  } else return null;
  return { companyId, issueId, attemptId, compact, root: path.join(instance, ...parts.slice(0, count)), rest: parts.slice(count) };
}

export function compactIsolatedIssueRoot(instance: string, companyId: string, issueId: string): string | null {
  return UUID.test(companyId) && UUID.test(issueId) ? path.join(instance, "w", compactId(companyId), compactId(issueId)) : null;
}

export function isolatedSeedDirectory(instance: string, root: string) {
  return path.join(root, readIsolatedTaskPath(instance, root)?.compact ? "w" : "workspace");
}

export async function resolveIsolatedTaskDirectory(instance: string, input: Identity): Promise<string> {
  const preferred = path.join(instance, ...isolatedTaskPathSegments(input));
  const legacy = path.join(instance, ...isolatedTaskPathSegments(input, "linux"));
  if (preferred === legacy) return preferred;
  const present = (target: string) => lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false; throw error;
  });
  const [hasPreferred, hasLegacy] = await Promise.all([present(preferred), present(legacy)]);
  if (hasPreferred && hasLegacy) throw new Error("Ambiguous isolated task workspace identity");
  return hasLegacy ? legacy : preferred;
}
