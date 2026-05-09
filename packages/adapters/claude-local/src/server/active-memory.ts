/**
 * Active Memory Enforcement (VOG-5736, schema updated VOG-5838)
 *
 * Reads agent memory files tagged with `trigger: always-check` and
 * builds a concise "Self-Check" section that is prepended to the agent's
 * system prompt on every wake, giving the model a mandatory reminder before
 * it can take any action.
 *
 * Feature flag: set env var ACTIVE_MEMORY_ENFORCEMENT_ENABLED=false to disable.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MemoryTrigger = "always-check" | "triggered" | "optional";

export interface ActiveMemory {
  name: string;
  description: string;
  trigger: MemoryTrigger;
  howToApply: string | null;
}

const MEMORY_INDEX_FILE = "MEMORY.md";
// Regex to extract markdown links:  [display text](filename.md)
const MEMORY_LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
// Regex to extract "**How to apply:** <text>" from memory body
const HOW_TO_APPLY_RE = /\*\*How to apply:\*\*\s*([^\n]+)/;

/** Parse YAML-style frontmatter from a markdown file (simple key: value). */
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

async function parseMemoryFile(filePath: string): Promise<ActiveMemory | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    const name = fm["name"] ?? path.basename(filePath, ".md");
    const description = fm["description"] ?? "";
    const rawTrigger = fm["trigger"] ?? fm["enforcement"] ?? "optional";
    const trigger: MemoryTrigger =
      rawTrigger === "always-check" || rawTrigger === "triggered"
        ? (rawTrigger as MemoryTrigger)
        : "optional";
    const body = bodyAfterFrontmatter(content);
    const howToApplyMatch = HOW_TO_APPLY_RE.exec(body);
    const howToApply = howToApplyMatch?.[1]?.trim() ?? null;
    return { name, description, trigger, howToApply };
  } catch {
    return null;
  }
}

/** Extract memory file links from a MEMORY.md index. */
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
 * e.g. "C:\Users\wj\.paperclip\..." → "C--Users-wj--paperclip-..."
 */
function cwdToClaudeProjectId(cwdPath: string): string {
  return cwdPath.replace(/[:\\/.]/g, "-");
}

/**
 * Locate the memory directory for the given CWD.
 * Tries two locations in order:
 *   1. `<cwd>/memory/`     — in-repo memory (used by ERP-style agents)
 *   2. `~/.claude/projects/<encoded-cwd>/memory/` — Claude Code auto-memory
 */
async function resolveMemoryDir(cwd: string): Promise<string | null> {
  // Option 1: in-repo memory
  const inRepoDir = path.join(cwd, "memory");
  const inRepoIndex = path.join(inRepoDir, MEMORY_INDEX_FILE);
  if (await fs.stat(inRepoIndex).then(() => true).catch(() => false)) {
    return inRepoDir;
  }

  // Option 2: Claude Code auto-memory
  const projectId = cwdToClaudeProjectId(cwd);
  const claudeDir = path.join(os.homedir(), ".claude", "projects", projectId, "memory");
  const claudeIndex = path.join(claudeDir, MEMORY_INDEX_FILE);
  if (await fs.stat(claudeIndex).then(() => true).catch(() => false)) {
    return claudeDir;
  }

  return null;
}

/**
 * Load all memories tagged `trigger: always-check` from the agent's memory directory.
 * Returns an empty array if no memory directory is found or no always-check memories exist.
 */
export async function loadActiveMemories(cwd: string): Promise<ActiveMemory[]> {
  const memoryDir = await resolveMemoryDir(cwd);
  if (!memoryDir) return [];

  const indexContent = await fs.readFile(path.join(memoryDir, MEMORY_INDEX_FILE), "utf-8").catch(() => null);
  if (!indexContent) return [];

  const links = parseMemoryLinks(indexContent);
  const parsed = await Promise.all(links.map((link) => parseMemoryFile(path.join(memoryDir, link))));

  return parsed.filter((m): m is ActiveMemory => m !== null && m.trigger === "always-check");
}

/**
 * Build the "## Active Memory Self-Check" block injected at the end of the
 * heartbeat wake prompt (VOG-5839). Feature flag: MEMORY_ENFORCE_ENABLED=true.
 *
 * Format: a markdown table so the model can scan it quickly before acting.
 */
export function buildMemorySelfCheckBlock(memories: ActiveMemory[]): string {
  if (memories.length === 0) return "";

  const rows = memories
    .map((m, i) => {
      const name = m.name ?? "(unnamed)";
      const description = (m.description ?? "").replace(/\|/g, "\\|");
      const howToApply = (m.howToApply ?? "").replace(/\|/g, "\\|");
      return `| ${i + 1} | ${name} | ${description} | ${howToApply} |`;
    })
    .join("\n");

  return [
    "## Active Memory Self-Check",
    "",
    "The following memories are ALWAYS enforced — verify before acting:",
    "",
    "| # | Memory | Description | How to Apply |",
    "|---|--------|-------------|--------------|",
    rows,
    "",
    "**Self-check:** Do any of your planned actions this wake violate the above memories?",
    "If yes, correct before proceeding.",
  ].join("\n");
}

/**
 * Build the "## Active Memories — Self-Check Before Each Action" section
 * to prepend to the agent's system prompt.
 */
export function buildActiveMemorySection(memories: ActiveMemory[]): string {
  if (memories.length === 0) return "";

  const items = memories.map((m) => {
    const lines: string[] = [`**${m.name}**`];
    if (m.description) lines.push(m.description);
    if (m.howToApply) lines.push(`→ ${m.howToApply}`);
    return lines.join("\n");
  });

  return [
    "## Active Memories — Self-Check Before Each Action",
    "",
    "The following memories are marked `always-check`.",
    "Before taking any action, verify you are NOT violating these rules:",
    "",
    ...items.flatMap((item) => [item, ""]),
  ].join("\n");
}
