import fs from "node:fs/promises";
import path from "node:path";

const PARA_DIRS = [
  "life/projects",
  "life/areas",
  "life/resources",
  "life/archives",
  "memory",
];

const LIFE_INDEX_CONTENT = `# Knowledge Graph Index

Entities discovered by this agent are stored here using the PARA method.
`;

const MEMORY_MD_CONTENT = `# Tacit Knowledge

Operating patterns, preferences, and lessons learned.
Update this file when you discover new ways of working that should persist.
`;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIfAbsent(filePath: string, content: string): Promise<void> {
  if (await fileExists(filePath)) return;
  await fs.writeFile(filePath, content, "utf8");
}

/**
 * Idempotently creates the PARA directory structure and seed files
 * inside an agent's home directory. Safe to call on every heartbeat —
 * existing files are never overwritten.
 */
export async function ensureAgentHomeStructure(homePath: string): Promise<void> {
  await Promise.all(
    PARA_DIRS.map((dir) => fs.mkdir(path.join(homePath, dir), { recursive: true })),
  );

  await Promise.all([
    writeIfAbsent(path.join(homePath, "life", "index.md"), LIFE_INDEX_CONTENT),
    writeIfAbsent(path.join(homePath, "MEMORY.md"), MEMORY_MD_CONTENT),
  ]);
}
