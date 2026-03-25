/**
 * Export Superpowers skills from plugin_state to filesystem skill directories.
 *
 * Writes each skill as <skillId>/SKILL.md into every target directory so
 * Claude Code, Codex, Gemini, and pi agents can find them on the filesystem.
 *
 * Default target dirs (all under HOME):
 *   .agents/skills/      — shared path picked up by all adapter skill scanners
 *   .claude/skills/      — Claude Code native path
 *   .codex/skills/       — Codex native path
 *
 * Production:
 *   docker cp scripts/superpowers-export-skills-to-fs.mjs paperclip-server-1:/tmp/ssefs.mjs
 *   docker exec -u node -w /app/server \
 *     -e PAPERCLIP_SUPERPLUGIN_ID='b42c55cb-a415-4247-9b27-91f28133f367' \
 *     paperclip-server-1 \
 *     node --import ./node_modules/tsx/dist/loader.mjs /tmp/ssefs.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDb, pluginState } from "@paperclipai/db";
import { and, eq, like } from "drizzle-orm";

const pluginId = process.env.PAPERCLIP_SUPERPLUGIN_ID?.trim();
if (!pluginId) { console.error("PAPERCLIP_SUPERPLUGIN_ID is required"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const HOME = process.env.HOME ?? os.homedir();
const TARGET_DIRS = (process.env.SKILL_TARGET_DIRS ?? "").split(",")
  .map(d => d.trim()).filter(Boolean);

const DEFAULT_TARGETS = [
  path.join(HOME, ".agents", "skills"),
  path.join(HOME, ".claude", "skills"),
  path.join(HOME, ".codex", "skills"),
];

const targets = TARGET_DIRS.length > 0 ? TARGET_DIRS : DEFAULT_TARGETS;

const db = createDb(process.env.DATABASE_URL);

const rows = await db
  .select()
  .from(pluginState)
  .where(
    and(
      eq(pluginState.pluginId, pluginId),
      eq(pluginState.scopeKind, "instance"),
      like(pluginState.stateKey, "skill:%"),
    ),
  );

if (rows.length === 0) {
  console.error("No skills found in plugin_state. Run superpowers-bulk-assign-all.mjs first.");
  process.exit(1);
}

let written = 0;
for (const row of rows) {
  const skill = row.valueJson;
  if (!skill?.id || !skill?.name || !skill?.content) continue;

  const frontmatter = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description ?? ""}`,
    `category: ${skill.category ?? "other"}`,
    "---",
  ].join("\n");

  const skillMd = `${frontmatter}\n\n${skill.content}\n`;

  for (const dir of targets) {
    const skillDir = path.join(dir, skill.id);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd, "utf8");
  }

  // Write companion files if present
  if (skill.companionFiles && typeof skill.companionFiles === "object") {
    for (const [filename, content] of Object.entries(skill.companionFiles)) {
      if (typeof content !== "string") continue;
      for (const dir of targets) {
        const skillDir = path.join(dir, skill.id);
        await fs.writeFile(path.join(skillDir, filename), content, "utf8");
      }
    }
  }

  written++;
  console.log(`  wrote ${skill.id} (${skill.name})`);
}

console.log(JSON.stringify({ ok: true, skills: written, targets }));
