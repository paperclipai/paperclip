import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterRuntimeSkillCatalog,
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveClaudeHomeDir() {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.resolve(path.join(os.homedir(), ".claude"));
}

function resolveClaudeSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".claude", "skills");
}

function parseSkillFrontmatter(markdown: string): { title: string | null; description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { title: null, description: "" };
  const yaml = match[1];
  const nameMatch = yaml.match(
    /^name:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?([^"'\n]+?)["']?\s*$)/m,
  );
  let title: string | null = null;
  if (nameMatch) {
    const rawName = nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? "";
    const collapsed = rawName
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    title = collapsed.length > 0 ? collapsed : null;
  }
  const descMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m,
  );
  if (!descMatch) return { title, description: "" };
  const raw = descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "";
  return {
    title,
    description: raw
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

function normalizeEnabledPluginsValue(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v === true || v === 1 || v === "true")
      .map(([k]) => k.trim())
      .filter(Boolean);
  }
  return [];
}

function readJsonFileIfExists(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function resolvePaperclipSkillNames(): Promise<Set<string>> {
  const skillNames = new Set<string>();
  try {
    const entries = await readPaperclipRuntimeSkillEntries({}, __moduleDir);
    for (const entry of entries) {
      if (entry.runtimeName) skillNames.add(entry.runtimeName);
    }
    return skillNames;
  } catch {
    // Fall back to an empty set if runtime skill resolution is unavailable.
  }
  return skillNames;
}

async function buildClaudeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveClaudeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be materialized into the stable Paperclip-managed Claude prompt bundle on the next run."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: "Installed outside Paperclip management in the Claude skills home.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "claude_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listClaudeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export async function syncClaudeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildClaudeSkillSnapshot(ctx.config);
}

export function resolveClaudeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function listClaudeRuntimeSkillCatalog(): Promise<AdapterRuntimeSkillCatalog> {
  const claudeHomeDir = resolveClaudeHomeDir();
  const skillsDir = path.join(claudeHomeDir, "skills");
  const paperclipSkillNames = await resolvePaperclipSkillNames();
  const skills: AdapterRuntimeSkillCatalog["skills"] = [];

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      let title: string | null = null;
      let description = "";
      try {
        const markdown = fs.readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
        const parsed = parseSkillFrontmatter(markdown);
        title = parsed.title;
        description = parsed.description;
      } catch {
        // SKILL.md is optional.
      }
      skills.push({
        name: entry.name,
        title,
        description,
        isPaperclipManaged: paperclipSkillNames.has(entry.name),
      });
    }
  } catch {
    // Missing skills dir is a valid empty state.
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  const base = readJsonFileIfExists(path.join(claudeHomeDir, "settings.json"));
  const local = readJsonFileIfExists(path.join(claudeHomeDir, "settings.local.json"));
  const enabledPlugins = new Set([
    ...normalizeEnabledPluginsValue(base?.enabledPlugins),
    ...normalizeEnabledPluginsValue(local?.enabledPlugins),
  ]);

  return {
    adapterType: "claude_local",
    label: "Claude Code",
    readOnly: true,
    locationLabel: process.env.CLAUDE_HOME?.trim() ? "$CLAUDE_HOME" : "~/.claude",
    skills,
    sections: [
      {
        key: "enabled_plugins",
        label: "Enabled plugins",
        items: [...enabledPlugins].sort((a, b) => a.localeCompare(b)),
      },
    ],
    warnings: [],
  };
}
