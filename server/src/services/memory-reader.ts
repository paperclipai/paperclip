/**
 * Server-side Memory Reader (VOG-5838)
 *
 * Provides `readAlwaysCheckMemories(agentHome)` for use by the heartbeat service
 * and any other server component that needs to inspect an agent's always-check memories.
 *
 * Design notes:
 * - Field name: `trigger` (canonical). Legacy `enforcement` field is read as fallback.
 * - Governance: each agent marks only their own memories; max 15 always-check per agent.
 * - Default: files without a `trigger` field are treated as `trigger: optional`.
 * - Memory index: read via `{memoryDir}/MEMORY.md` link list.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MemoryTrigger = "always-check" | "triggered" | "optional";

export interface MemoryEntry {
  name: string;
  description: string;
  howToApply: string;
  trigger: MemoryTrigger;
}

const MEMORY_INDEX_FILE = "MEMORY.md";
const MEMORY_LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
const HOW_TO_APPLY_RE = /\*\*How to apply:\*\*\s*([^\n]+)/;

/** Parse YAML-style frontmatter (simple key: value lines). */
function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return {};
  const result: Record<string, string> = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function bodyAfterFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  return closing >= 0 ? normalized.slice(closing + 5).trim() : normalized.trim();
}

/** Parse a single memory file; returns null on read/parse error. */
async function parseMemoryFile(filePath: string): Promise<MemoryEntry | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    const name = fm["name"] ?? path.basename(filePath, ".md");
    const description = fm["description"] ?? "";
    // `trigger` is canonical; fall back to legacy `enforcement` for backward compat.
    const rawTrigger = fm["trigger"] ?? fm["enforcement"] ?? "optional";
    const trigger: MemoryTrigger =
      rawTrigger === "always-check" || rawTrigger === "triggered"
        ? (rawTrigger as MemoryTrigger)
        : "optional";
    const body = bodyAfterFrontmatter(content);
    const howToApply = HOW_TO_APPLY_RE.exec(body)?.[1]?.trim() ?? "";
    return { name, description, trigger, howToApply };
  } catch {
    return null;
  }
}

/** Extract linked memory file paths from MEMORY.md index. */
function parseMemoryLinks(indexContent: string): string[] {
  const links: string[] = [];
  MEMORY_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEMORY_LINK_RE.exec(indexContent)) !== null) {
    links.push(match[2]!);
  }
  return links;
}

/**
 * Convert a filesystem path to a Claude Code project directory ID.
 * Claude Code encodes CWDs by replacing `\`, `/`, `:`, and `.` with `-`.
 */
function cwdToClaudeProjectId(cwdPath: string): string {
  return cwdPath.replace(/[:\\/.]/g, "-");
}

/**
 * Locate the memory directory for the given agent home directory.
 *
 * Tries two locations:
 *   1. `{agentHome}/memory/`                           — in-repo memory
 *   2. `~/.claude/projects/{encoded-agentHome}/memory/` — Claude Code auto-memory
 */
async function resolveMemoryDir(agentHome: string): Promise<string | null> {
  const inRepoDir = path.join(agentHome, "memory");
  const inRepoIndex = path.join(inRepoDir, MEMORY_INDEX_FILE);
  if (await fs.stat(inRepoIndex).then(() => true).catch(() => false)) {
    return inRepoDir;
  }

  const projectId = cwdToClaudeProjectId(agentHome);
  const claudeDir = path.join(os.homedir(), ".claude", "projects", projectId, "memory");
  const claudeIndex = path.join(claudeDir, MEMORY_INDEX_FILE);
  if (await fs.stat(claudeIndex).then(() => true).catch(() => false)) {
    return claudeDir;
  }

  return null;
}

/**
 * Return all memories tagged `trigger: always-check` for the given agent home directory.
 *
 * @param agentHome  The agent's workspace root (e.g. from `resolveDefaultAgentWorkspaceDir`).
 * @returns  Filtered list of MemoryEntry objects ready for injection into the system prompt.
 *
 * Governance rules (VOG-5838):
 * - Each agent marks only their own memories.
 * - Max 15 always-check entries per agent (warning only, not enforced here).
 * - Returns empty array when no memory directory or no always-check entries exist.
 */
export async function readAlwaysCheckMemories(agentHome: string): Promise<MemoryEntry[]> {
  const memoryDir = await resolveMemoryDir(agentHome);
  if (!memoryDir) return [];

  const indexContent = await fs.readFile(path.join(memoryDir, MEMORY_INDEX_FILE), "utf-8").catch(() => null);
  if (!indexContent) return [];

  const links = parseMemoryLinks(indexContent);
  const parsed = await Promise.all(links.map((link) => parseMemoryFile(path.join(memoryDir, link))));

  const alwaysCheck = parsed.filter((m): m is MemoryEntry => m !== null && m.trigger === "always-check");

  if (alwaysCheck.length > 15) {
    // Governance warning — log to stderr but do not truncate.
    process.stderr.write(
      `[paperclip] Warning: agent at "${agentHome}" has ${alwaysCheck.length} always-check memories (governance limit is 15). Consider downgrading low-priority entries to "optional".\n`,
    );
  }

  return alwaysCheck;
}
