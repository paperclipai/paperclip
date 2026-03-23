#!/usr/bin/env tsx
/**
 * Vault + Claude-mem → Knowledge Store bulk importer
 * Usage: tsx scripts/import-vault-to-knowledge.ts [--api-url http://localhost:3100]
 */

import fs from "node:fs";
import path from "node:path";

const API_URL = process.argv.includes("--api-url")
  ? process.argv[process.argv.indexOf("--api-url") + 1]
  : "http://localhost:3100";

const VAULT_DIR = path.join(
  process.env.HOME ?? "/Users/evohaus",
  "Documents/EvoHaus-Vault/Hafiza",
);

const CLAUDE_MEM_URL = "http://localhost:37777";

// Category mapping from Vault directory names
const CATEGORY_MAP: Record<string, string> = {
  dersler: "lesson",
  hatalar: "bugfix",
  patternler: "pattern",
  retrospektif: "discovery",
  oturum: "session_log",
  "geri-bildirim": "feedback",
  referans: "reference",
  raporlar: "report",
  orkestrasyon: "decision",
  "guvenlik-audit": "security",
  zeka: "skill_note",
  "skill-atlas": "skill_note",
  snapshots: "session_log",
  codex: "observation",
  gemini: "observation",
  openclaw: "observation",
  "session-snapshots": "session_log",
};

function getCategoryFromPath(relPath: string): string {
  const dir = path.dirname(relPath).split("/")[0];
  return CATEGORY_MAP[dir] ?? "observation";
}

function getTagsFromPath(relPath: string): string[] {
  const parts = relPath.split("/");
  const tags: string[] = ["vault"];
  if (parts.length > 1) tags.push(parts[0]);
  return tags;
}

async function importVault() {
  console.log(`\n=== Vault → Knowledge Store ===`);
  console.log(`Vault: ${VAULT_DIR}`);
  console.log(`API: ${API_URL}`);

  if (!fs.existsSync(VAULT_DIR)) {
    console.error(`Vault directory not found: ${VAULT_DIR}`);
    return 0;
  }

  const entries: Array<{
    title: string;
    body: string;
    category: string;
    tags: string[];
    sourcePlatform: string;
  }> = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith(".md") && entry.name !== "_index.md") {
        const relPath = path.relative(VAULT_DIR, fullPath);
        const content = fs.readFileSync(fullPath, "utf-8");

        // Extract title from YAML frontmatter or filename
        let title = entry.name.replace(".md", "").replace(/-/g, " ");
        const frontmatterMatch = content.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/);
        if (frontmatterMatch) {
          title = frontmatterMatch[1].trim();
        }

        // Truncate body to 5000 chars for token efficiency
        const body = content.slice(0, 5000);

        entries.push({
          title,
          body,
          category: getCategoryFromPath(relPath),
          tags: getTagsFromPath(relPath),
          sourcePlatform: "vault",
        });
      }
    }
  }

  walkDir(VAULT_DIR);
  console.log(`Found ${entries.length} Vault files`);

  if (entries.length === 0) return 0;

  // Import in batches of 10 to avoid payload issues
  let imported = 0;
  const BATCH_SIZE = 10;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    try {
      const resp = await fetch(`${API_URL}/api/knowledge/bulk-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: batch }),
      });
      if (resp.ok) {
        const result = await resp.json();
        imported += result.imported;
        process.stdout.write(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: +${result.imported}\n`);
      } else {
        console.error(`  batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${resp.status}`);
        // Try one by one
        for (const entry of batch) {
          try {
            const singleResp = await fetch(`${API_URL}/api/knowledge`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(entry),
            });
            if (singleResp.ok) imported++;
            else console.error(`    skip: ${entry.title} (${singleResp.status})`);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error(`  batch error: ${err}`);
    }
  }

  console.log(`Imported ${imported} Vault entries`);
  return imported;
}

async function importClaudeMem() {
  console.log(`\n=== Claude-mem → Knowledge Store ===`);

  // Check if claude-mem is running
  try {
    const health = await fetch(`${CLAUDE_MEM_URL}/api/health`);
    if (!health.ok) throw new Error("not ok");
  } catch {
    console.log("Claude-mem worker not running, skipping");
    return 0;
  }

  // Get all observations
  const searchResp = await fetch(
    `${CLAUDE_MEM_URL}/api/search?query=&limit=200`,
  );
  if (!searchResp.ok) {
    console.error("Failed to fetch claude-mem observations");
    return 0;
  }

  const searchData = await searchResp.json();
  const text = searchData.content?.[0]?.text ?? "";

  // Parse observation IDs from the table
  const idMatches = text.match(/#(\d+)/g);
  if (!idMatches || idMatches.length === 0) {
    console.log("No claude-mem observations found");
    return 0;
  }

  console.log(`Found ${idMatches.length} claude-mem observation references`);

  // Import via knowledge API with claude-mem source marker
  const entries = idMatches.map((id: string) => ({
    title: `Claude-mem observation ${id}`,
    body: `Imported from claude-mem ${id}`,
    category: "observation",
    tags: ["claude-mem"],
    sourcePlatform: "claude_mem",
  }));

  // We'll do a simpler approach — import the raw search text as a single knowledge entry
  const resp = await fetch(`${API_URL}/api/knowledge/bulk-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entries: [
        {
          title: "Claude-mem Full Index (auto-import)",
          body: text.slice(0, 10000),
          category: "observation",
          tags: ["claude-mem", "auto-import"],
          sourcePlatform: "claude_mem",
        },
      ],
    }),
  });

  if (!resp.ok) {
    console.error(`Claude-mem import failed: ${resp.status}`);
    return 0;
  }

  const result = await resp.json();
  console.log(`Imported ${result.imported} claude-mem entries`);
  return result.imported;
}

async function importProjectMemory() {
  console.log(`\n=== Project Memory → Knowledge Store ===`);

  const memDir = path.join(
    process.env.HOME ?? "/Users/evohaus",
    ".claude/projects/-Users-evohaus-Desktop-Projects-paperclip/memory",
  );

  if (!fs.existsSync(memDir)) {
    console.log("No project memory directory found");
    return 0;
  }

  const entries: Array<{
    title: string;
    body: string;
    category: string;
    tags: string[];
    sourcePlatform: string;
  }> = [];

  for (const file of fs.readdirSync(memDir)) {
    if (!file.endsWith(".md") || file === "MEMORY.md") continue;
    const content = fs.readFileSync(path.join(memDir, file), "utf-8");

    // Extract type from frontmatter
    const typeMatch = content.match(/type:\s*(\w+)/);
    const category = typeMatch?.[1] ?? "observation";

    entries.push({
      title: file.replace(".md", "").replace(/_/g, " "),
      body: content.slice(0, 5000),
      category,
      tags: ["project-memory", "paperclip"],
      sourcePlatform: "claude_local",
    });
  }

  console.log(`Found ${entries.length} project memory files`);

  if (entries.length === 0) return 0;

  const resp = await fetch(`${API_URL}/api/knowledge/bulk-import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });

  if (!resp.ok) {
    console.error(`Project memory import failed: ${resp.status}`);
    return 0;
  }

  const result = await resp.json();
  console.log(`Imported ${result.imported} project memory entries`);
  return result.imported;
}

async function main() {
  console.log("EvoHaus Unified Brain — Knowledge Import");
  console.log("=========================================");

  let total = 0;
  total += await importVault();
  total += await importClaudeMem();
  total += await importProjectMemory();

  console.log(`\n=========================================`);
  console.log(`Total imported: ${total} entries`);

  // Verify
  const statsResp = await fetch(`${API_URL}/api/knowledge/stats`);
  if (statsResp.ok) {
    const stats = await statsResp.json();
    console.log(`Knowledge Store stats:`, JSON.stringify(stats, null, 2));
  }
}

main().catch(console.error);
