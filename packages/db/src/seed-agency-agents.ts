/**
 * Agency-Agents Import — Seed 178 agents from msitarzewski/agency-agents
 *
 * Reads .md files from the agency-agents repo, parses YAML frontmatter,
 * and inserts each as a Paperclip agent under EVOHAUS AI company.
 *
 * Run: npx tsx packages/db/src/seed-agency-agents.ts
 */

import { createDb } from "./client.js";
import { agents } from "./schema/index.js";
import { eq, and } from "drizzle-orm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const url = process.env.DATABASE_URL!;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const COMPANY_ID = "e4f86ad5-bcdd-4ac9-9972-11ed5f6c7820";
const AGENCY_AGENTS_DIR = "/Users/evohaus/Desktop/Projects/Emir/tmp_atlas/agency-agents";

const DIVISIONS = [
  "academic",
  "design",
  "engineering",
  "game-development",
  "marketing",
  "paid-media",
  "product",
  "project-management",
  "sales",
  "spatial-computing",
  "specialized",
  "strategy",
  "support",
  "testing",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface AgentFrontmatter {
  name: string;
  description: string;
  color: string;
  emoji: string;
  vibe: string;
}

function parseFrontmatter(content: string): AgentFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const get = (key: string): string => {
    const line = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!line) return "";
    // Strip surrounding quotes
    return line[1].replace(/^["']|["']$/g, "").trim();
  };

  const name = get("name");
  if (!name) return null;

  return {
    name,
    description: get("description"),
    color: get("color") || "gray",
    emoji: get("emoji") || "🤖",
    vibe: get("vibe"),
  };
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md") && !["README.md", "CONTRIBUTING.md", "LICENSE.md"].includes(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function buildRuntimeConfig(heartbeatStr: string): Record<string, unknown> {
  const match = heartbeatStr.match(/^(\d+)(h|m|s)$/);
  const intervalSec = match
    ? parseInt(match[1], 10) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1)
    : 0;
  return {
    heartbeat: {
      enabled: true,
      intervalSec,
      wakeOnDemand: true,
      maxConcurrentRuns: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Agency-Agents Import — Starting\n");

  let imported = 0;
  let skipped = 0;

  for (const division of DIVISIONS) {
    const divDir = join(AGENCY_AGENTS_DIR, division);
    try {
      statSync(divDir);
    } catch {
      console.log(`  [SKIP] Division not found: ${division}`);
      continue;
    }

    const files = findMarkdownFiles(divDir);

    for (const filePath of files) {
      const content = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) {
        console.log(`  [SKIP] No frontmatter: ${basename(filePath)}`);
        skipped++;
        continue;
      }

      // Check for existing agent with same name under same company
      const existing = await db.query.agents.findFirst({
        where: and(eq(agents.companyId, COMPANY_ID), eq(agents.name, fm.name)),
        columns: { id: true },
      });

      if (existing) {
        console.log(`  [EXISTS] ${fm.name} (${division})`);
        skipped++;
        continue;
      }

      const filename = basename(filePath, ".md");
      const role = `agency_${slugify(division)}_${slugify(fm.name)}`;

      await db.insert(agents).values({
        companyId: COMPANY_ID,
        name: fm.name,
        role,
        title: fm.name,
        icon: fm.emoji,
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        capabilities: `${division}-specialist`,
        budgetMonthlyCents: 0,
        metadata: {
          level: "agency",
          division,
          filename,
          description: fm.description,
          emoji: fm.emoji,
          color: fm.color,
          vibe: fm.vibe,
          source: "msitarzewski/agency-agents",
          platforms: ["claude-code", "gemini-cli", "codex"],
        },
        runtimeConfig: buildRuntimeConfig("1h"),
        permissions: { shared: true },
      });

      imported++;
      console.log(`  [OK] ${fm.name} (${division})`);
    }
  }

  console.log(`\nDone! Imported: ${imported}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
