import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillEntry, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function findKiroSkillsDir(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, ".kiro", "skills");
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
    // Also check if it's a symlink to a directory
    const lstat = stat ? null : await fs.lstat(candidate).catch(() => null);
    if (lstat?.isSymbolicLink()) {
      const resolved = await fs.stat(candidate).catch(() => null);
      if (resolved?.isDirectory()) return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

async function resolveKiroSkillsHome(config: Record<string, unknown>): Promise<string> {
  const cwd =
    typeof config.cwd === "string" && config.cwd.length > 0
      ? config.cwd
      : process.cwd();
  // Try configured/current dir first, then walk up to find .kiro/skills/
  const direct = path.join(cwd, ".kiro", "skills");
  const stat = await fs.stat(direct).catch(() => null);
  if (stat?.isDirectory()) return direct;
  const found = await findKiroSkillsDir(cwd);
  return found ?? direct;
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

async function scanKiroSkills(skillsHome: string): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];
  let items: import("node:fs").Dirent[];
  try {
    items = await fs.readdir(skillsHome, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const item of items) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const skillDir = path.join(skillsHome, item.name);
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
      originLabel: "Kiro skill",
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
  const skillsHome = await resolveKiroSkillsHome(config);

  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  const kiroSkillEntries = await scanKiroSkills(skillsHome);

  const entries: AdapterSkillEntry[] = [];

  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      locationLabel: `.agents/skills/${entry.runtimeName}`,
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired ? "Available on the next run via Kiro skill loading." : null,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason ?? null,
    });
  }

  for (const entry of kiroSkillEntries) {
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  return {
    adapterType: "kiro_local",
    supported: true,
    mode: "persistent" as const,
    desiredSkills,
    entries,
    warnings: [],
  };
}

export async function listKiroSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}

export async function syncKiroSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config);
}
