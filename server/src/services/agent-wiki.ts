import fs from "node:fs/promises";
import path from "node:path";
import type { WikiContextBundle, WikiUpdate, WikiPageInfo } from "@paperclipai/shared";
import { resolveAgentWikiDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const WIKI_PATH_RE = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.md$/;

function validateWikiPath(relativePath: string): void {
  if (!WIKI_PATH_RE.test(relativePath)) {
    throw new Error(`Invalid wiki path: ${relativePath}`);
  }
}

function safeResolve(wikiDir: string, relativePath: string): string {
  validateWikiPath(relativePath);
  const resolved = path.resolve(wikiDir, relativePath);
  if (!resolved.startsWith(wikiDir + path.sep) && resolved !== wikiDir) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractTitle(content: string, fallbackPath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(fallbackPath, ".md");
}

export async function ensureWikiDir(agentId: string): Promise<string> {
  const wikiDir = resolveAgentWikiDir(agentId);
  await fs.mkdir(wikiDir, { recursive: true });

  const indexPath = path.join(wikiDir, "index.md");
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, "# Wiki Index\n", "utf-8");
  }

  const learningsPath = path.join(wikiDir, "learnings.md");
  try {
    await fs.access(learningsPath);
  } catch {
    await fs.writeFile(learningsPath, "# Learnings\n", "utf-8");
  }

  return wikiDir;
}

export async function getWikiForRun(
  agentId: string,
  projectSlug: string | null,
): Promise<WikiContextBundle> {
  const wikiDir = await ensureWikiDir(agentId);

  const indexPage = await readFileOrEmpty(path.join(wikiDir, "index.md"));
  const learningsPage = await readFileOrEmpty(path.join(wikiDir, "learnings.md"));

  let projectPage: string | null = null;
  if (projectSlug) {
    const projectPath = path.join(wikiDir, "projects", `${projectSlug}.md`);
    projectPage = await readFileOrNull(projectPath);
  }

  return {
    indexPage,
    learningsPage,
    projectPage,
    projectSlug,
    wikiPath: wikiDir,
  };
}

export async function applyWikiUpdates(
  agentId: string,
  updates: WikiUpdate[],
): Promise<void> {
  const wikiDir = resolveAgentWikiDir(agentId);
  await fs.mkdir(wikiDir, { recursive: true });

  for (const update of updates) {
    const filePath = safeResolve(wikiDir, update.path);

    if (update.action === "upsert") {
      if (!update.content) {
        logger.warn({ path: update.path }, "wiki upsert missing content, skipping");
        continue;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, update.content, "utf-8");
    } else if (update.action === "delete") {
      try {
        await fs.unlink(filePath);
      } catch {
        // file already absent
      }
    }
  }

  await rebuildIndex(agentId);
}

export async function rebuildIndex(agentId: string): Promise<void> {
  const wikiDir = resolveAgentWikiDir(agentId);
  const entries = await scanMarkdownFiles(wikiDir, wikiDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const groups = new Map<string, Array<{ relativePath: string; title: string }>>();
  for (const entry of entries) {
    if (entry.path === "index.md") continue;
    const dir = path.dirname(entry.path);
    const groupName = dir === "." ? "Root" : dir.charAt(0).toUpperCase() + dir.slice(1);
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push({ relativePath: entry.path, title: entry.title });
  }

  const lines: string[] = ["# Wiki Index", ""];
  for (const [group, items] of groups) {
    lines.push(`## ${group}`);
    for (const item of items) {
      lines.push(`- [${item.title}](${item.relativePath})`);
    }
    lines.push("");
  }

  await fs.writeFile(path.join(wikiDir, "index.md"), lines.join("\n"), "utf-8");
}

async function scanMarkdownFiles(
  dir: string,
  root: string,
): Promise<Array<{ path: string; title: string; sizeBytes: number; updatedAt: string }>> {
  const results: Array<{ path: string; title: string; sizeBytes: number; updatedAt: string }> = [];

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const dirent of dirents) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...(await scanMarkdownFiles(fullPath, root)));
    } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
      const relativePath = path.relative(root, fullPath);
      const stat = await fs.stat(fullPath);
      const content = await readFileOrEmpty(fullPath);
      results.push({
        path: relativePath,
        title: extractTitle(content, relativePath),
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }

  return results;
}

export async function listPages(agentId: string): Promise<WikiPageInfo[]> {
  const wikiDir = resolveAgentWikiDir(agentId);
  return scanMarkdownFiles(wikiDir, wikiDir);
}

export async function readPage(
  agentId: string,
  relativePath: string,
): Promise<string | null> {
  const wikiDir = resolveAgentWikiDir(agentId);
  const filePath = safeResolve(wikiDir, relativePath);
  return readFileOrNull(filePath);
}

export async function writePage(
  agentId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const wikiDir = resolveAgentWikiDir(agentId);
  const filePath = safeResolve(wikiDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  await rebuildIndex(agentId);
}

export async function deletePage(
  agentId: string,
  relativePath: string,
): Promise<boolean> {
  const wikiDir = resolveAgentWikiDir(agentId);
  const filePath = safeResolve(wikiDir, relativePath);
  try {
    await fs.unlink(filePath);
    await rebuildIndex(agentId);
    return true;
  } catch {
    return false;
  }
}

