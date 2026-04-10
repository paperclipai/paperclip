import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveQodoSkillsHome() {
  return path.join(os.homedir(), ".qodo", "skills");
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter;
}

async function findKiroSkillsDir(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".kiro", "skills");
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

async function scanKiroSkills(config: Record<string, unknown>): Promise<AdapterSkillEntry[]> {
  const cwd =
    typeof config.cwd === "string" && config.cwd.length > 0
      ? config.cwd
      : process.cwd();
  const skillsDir = await findKiroSkillsDir(cwd);
  if (!skillsDir) return [];

  const entries: AdapterSkillEntry[] = [];
  let items: import("node:fs").Dirent[];
  try {
    items = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const item of items) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const skillDir = path.join(skillsDir, item.name);
    const skillMd = path.join(skillDir, "SKILL.md");
    const stat = await fs.stat(skillMd).catch(() => null);
    if (!stat) continue;

    let description: string | null = null;
    try {
      const content = await fs.readFile(skillMd, "utf8");
      const fm = parseSkillFrontmatter(content);
      description = fm.description ?? null;
    } catch {
      // ignore
    }

    entries.push({
      key: item.name,
      runtimeName: item.name,
      desired: true,
      managed: false,
      state: "installed",
      origin: "user_installed",
      originLabel: "Skill (via skillz MCP)",
      locationLabel: `.agents/skills/${item.name}`,
      readOnly: true,
      sourcePath: skillDir,
      targetPath: null,
      detail: description,
    });
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveQodoSkillsHome();
  const installed = await readInstalledSkillTargets(skillsHome);
  const snapshot = await buildPersistentSkillSnapshot({
    adapterType: "qodo_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.qodo/skills",
    missingDetail: "Configured but not currently linked into the Qodo skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });

  // Merge .kiro/skills/ entries (loaded at runtime via skillz MCP)
  const kiroSkills = await scanKiroSkills(config);
  const existingKeys = new Set(snapshot.entries.map((e) => e.key));
  for (const entry of kiroSkills) {
    if (existingKeys.has(entry.key)) continue;
    snapshot.entries.push(entry);
  }

  return snapshot;
}

export async function listQodoSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncQodoSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((e) => e.required).map((e) => e.key),
  ]);
  const skillsHome = resolveQodoSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((e) => [e.runtimeName, e]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(available.source, path.join(skillsHome, available.runtimeName));
  }

  for (const [name, entry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (entry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildSnapshot(ctx.config);
}
