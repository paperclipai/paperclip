import fs from "node:fs/promises";
import path from "node:path";
import { agents, createDb } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../server/src/home-paths.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IGNORED_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "Desktop.ini",
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const instanceRoot = resolvePaperclipInstanceRoot();

  const db = createDb(dbUrl);
  const allAgents = await db.select({
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
  }).from(agents);

  // 按 companyId + name 分组，检测同名 agent
  const nameKeyMap = new Map<string, { id: string; companyId: string; name: string }[]>();
  for (const agent of allAgents) {
    const key = `${agent.companyId}:${agent.name}`;
    const list = nameKeyMap.get(key) ?? [];
    list.push(agent);
    nameKeyMap.set(key, list);
  }

  let migrated = 0;
  let skipped = 0;
  let collisions = 0;

  for (const agent of allAgents) {
    // 跳过 UUID 格式的 agent name（不会产生 name-based 目录）
    if (UUID_PATTERN.test(agent.name)) continue;

    const nameBasedPath = path.resolve(
      instanceRoot,
      "companies",
      agent.companyId,
      "agents",
      agent.name,
      "instructions",
    );
    const nameStat = await fs.stat(nameBasedPath).catch(() => null);
    if (!nameStat?.isDirectory()) continue;

    const files = await listFilesRecursive(nameBasedPath);
    if (files.length === 0) continue;

    const uuidBasedPath = path.resolve(
      instanceRoot,
      "companies",
      agent.companyId,
      "agents",
      agent.id,
      "instructions",
    );
    const uuidStat = await fs.stat(uuidBasedPath).catch(() => null);
    if (uuidStat?.isDirectory()) {
      console.log(`SKIP: ${agent.name} (${agent.id}) — UUID-based instructions already exist at ${uuidBasedPath}`);
      skipped += 1;
      continue;
    }

    // 检测同名冲突
    const key = `${agent.companyId}:${agent.name}`;
    const sameNameAgents = nameKeyMap.get(key) ?? [];
    if (sameNameAgents.length > 1) {
      console.warn(
        `WARN: ${sameNameAgents.length} agents share the display name "${agent.name}" in company ${agent.companyId}. ` +
        `Name-based directory at ${nameBasedPath} is ambiguous — skipping automatic migration. ` +
        `Agent IDs: ${sameNameAgents.map((a) => a.id).join(", ")}`,
      );
      collisions += 1;
      continue;
    }

    console.log(
      `${apply ? "MIGRATE" : "DRY-RUN"}: ${agent.name} → ${agent.id} ` +
      `(${files.length} file${files.length === 1 ? "" : "s"} from ${nameBasedPath})`,
    );

    if (apply) {
      await fs.mkdir(uuidBasedPath, { recursive: true });
      for (const relativePath of files) {
        const srcPath = path.resolve(nameBasedPath, relativePath);
        const dstPath = path.resolve(uuidBasedPath, relativePath);
        await fs.mkdir(path.dirname(dstPath), { recursive: true });
        await fs.copyFile(srcPath, dstPath);
      }
    }

    migrated += 1;
  }

  if (!apply) {
    console.log(`\nDry run: ${migrated} agents would be migrated, ${skipped} skipped, ${collisions} collisions`);
    console.log("Re-run with --apply to persist changes");
  } else {
    console.log(`\nMigrated ${migrated} agents, ${skipped} skipped, ${collisions} collisions`);
    if (migrated > 0) {
      console.log("NOTE: Name-based source directories were NOT deleted — remove them manually after verifying the migration.");
    }
  }

  process.exit(0);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
});
