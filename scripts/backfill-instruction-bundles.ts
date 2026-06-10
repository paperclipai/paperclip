/**
 * One-time backfill: copy each agent's on-disk instruction bundle into the new
 * agents.instruction_bundle column (the DB-backed source of truth).
 *
 * MUST run on the Railway runtime (which has the instructions volume mounted). The Vercel
 * control plane can't see the volume. Run idempotently — agents that already have a bundle
 * set are skipped. Reads files from adapterConfig.instructionsRootPath (falls back to the
 * directory of instructionsFilePath).
 *
 * Usage (on the worker, with DATABASE_URL set):
 *   tsx scripts/backfill-instruction-bundles.ts            # apply
 *   tsx scripts/backfill-instruction-bundles.ts --dry-run  # report only
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createDb, agents } from "@valadrien-os/db";
import { eq } from "drizzle-orm";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile() && !IGNORED_FILES.has(entry.name)) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await walk(root, "");
  return out;
}

const rows = await db.select().from(agents);
let updated = 0;
let skipped = 0;

for (const agent of rows) {
  if (agent.instructionBundle && Array.isArray((agent.instructionBundle as { files?: unknown[] }).files)) {
    skipped += 1;
    continue;
  }
  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const filePath = asString(config.instructionsFilePath);
  const rootPath = asString(config.instructionsRootPath) ?? (filePath ? path.dirname(filePath) : null);
  const entryFile = asString(config.instructionsEntryFile) ?? (filePath ? path.basename(filePath) : "AGENTS.md");
  if (!rootPath) {
    console.log(`skip ${agent.name} (${agent.id}): no instructionsRootPath`);
    skipped += 1;
    continue;
  }
  const relPaths = await listFiles(rootPath);
  if (relPaths.length === 0) {
    console.log(`skip ${agent.name} (${agent.id}): no files at ${rootPath}`);
    skipped += 1;
    continue;
  }
  const files = await Promise.all(
    relPaths.map(async (rel) => ({ path: rel, content: await fs.readFile(path.join(rootPath, rel), "utf8") })),
  );
  const bundle = { entryFile, files };
  console.log(
    `${dryRun ? "[dry-run] would backfill" : "backfill"} ${agent.name} (${agent.id}): ${files.length} file(s) from ${rootPath} (entry ${entryFile})`,
  );
  if (!dryRun) {
    await db.update(agents).set({ instructionBundle: bundle, updatedAt: new Date() }).where(eq(agents.id, agent.id));
    updated += 1;
  }
}

console.log(`Done. ${dryRun ? "(dry-run) " : ""}updated=${updated} skipped=${skipped} total=${rows.length}`);
process.exit(0);
