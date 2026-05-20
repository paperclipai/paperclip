import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  ensurePaperclipSkillSymlink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  execute as hermesExecute,
  sessionCodec as hermesSessionCodec,
  parseModelFromConfig as parseHermesModelFromConfig,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type HermesExecutionContext = Parameters<typeof hermesExecute>[0];
const PAPERCLIP_SKILLS_ROOT = path.resolve(__moduleDir, "../../../skills");
const REQUIRED_HERMES_PAPERCLIP_SKILLS = ["paperclip", "paperclip-create-agent"] as const;

export interface PreparedHermesPaperclipSkills {
  skillsHome: string;
  availableSkillNames: string[];
  preloadedSkillNames: string[];
  missingSkillNames: string[];
  warnings: string[];
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveSharedHermesHome(config: Record<string, unknown>): string {
  const env = readRecord(config.env);
  return path.resolve(
    readNonEmptyString(config.hermesHome)
      ?? readNonEmptyString(env.HERMES_HOME)
      ?? readNonEmptyString(process.env.HERMES_HOME)
      ?? path.join(os.homedir(), ".hermes"),
  );
}

function resolvePaperclipHermesSkillsHome(config: Record<string, unknown>): string {
  return path.join(resolveSharedHermesHome(config), "skills", "paperclip");
}

export async function prepareHermesPaperclipSkills(
  config: Record<string, unknown>,
): Promise<PreparedHermesPaperclipSkills> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir, [PAPERCLIP_SKILLS_ROOT]);
  const paperclipSkillsHome = resolvePaperclipHermesSkillsHome(config);
  await fs.mkdir(paperclipSkillsHome, { recursive: true });
  const availableSkillNames = availableEntries.map((entry) => entry.runtimeName).sort((a, b) => a.localeCompare(b));
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));
  const warnings: string[] = [];
  const preloadedSkillNames: string[] = [];

  for (const skillName of REQUIRED_HERMES_PAPERCLIP_SKILLS) {
    const available = availableByRuntimeName.get(skillName);
    if (!available) continue;
    const target = path.join(paperclipSkillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
    const hasSkillMd = await fs.stat(path.join(target, "SKILL.md")).then((stat) => stat.isFile()).catch(() => false);
    if (!hasSkillMd) {
      warnings.push(
        `Hermes skill ${available.runtimeName} could not be linked at ${target}; not preloading it.`,
      );
      continue;
    }
    preloadedSkillNames.push(available.runtimeName);
  }

  return {
    skillsHome: paperclipSkillsHome,
    availableSkillNames,
    preloadedSkillNames,
    missingSkillNames: REQUIRED_HERMES_PAPERCLIP_SKILLS.filter(
      (skillName) => !preloadedSkillNames.includes(skillName),
    ),
    warnings,
  };
}

function parseSkillDescription(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const description = frontmatter.match(/^\s*description\s*:\s*(.+?)\s*$/m)?.[1];
  if (!description) return null;
  return description.replace(/^['"]|['"]$/g, "").trim() || null;
}

async function scanUserHermesSkills(hermesHome: string): Promise<AdapterSkillEntry[]> {
  const skillsRoot = path.join(hermesHome, "skills");
  const categories = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const entries: AdapterSkillEntry[] = [];

  for (const category of categories) {
    if (!category.isDirectory() || category.name === "paperclip") continue;
    const categoryPath = path.join(skillsRoot, category.name);
    const topLevelSkillMd = path.join(categoryPath, "SKILL.md");
    if (await fs.stat(topLevelSkillMd).then((stat) => stat.isFile()).catch(() => false)) {
      entries.push(await buildUserHermesSkillEntry(category.name, category.name, topLevelSkillMd));
    }

    const children = await fs.readdir(categoryPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const skillMd = path.join(categoryPath, child.name, "SKILL.md");
      const hasSkillMd = await fs.stat(skillMd).then((stat) => stat.isFile()).catch(() => false);
      if (!hasSkillMd) continue;
      entries.push(await buildUserHermesSkillEntry(`${category.name}/${child.name}`, child.name, skillMd));
    }
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildUserHermesSkillEntry(
  key: string,
  runtimeName: string,
  skillMdPath: string,
): Promise<AdapterSkillEntry> {
  const content = await fs.readFile(skillMdPath, "utf8").catch(() => "");
  return {
    key: `hermes/${key}`,
    runtimeName,
    desired: true,
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: path.dirname(skillMdPath),
    readOnly: true,
    sourcePath: skillMdPath,
    targetPath: null,
    detail: parseSkillDescription(content),
  };
}

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const hermesHome = resolveSharedHermesHome(config);
  const paperclipSkillsHome = resolvePaperclipHermesSkillsHome(config);
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir, [PAPERCLIP_SKILLS_ROOT]);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const installed = await readInstalledSkillTargets(paperclipSkillsHome);
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    const managed = installedEntry?.targetPath === available.source;
    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state: managed ? (desired ? "installed" : "stale") : desired ? "missing" : "available",
      origin: available.required ? "paperclip_required" : "company_managed",
      originLabel: available.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: available.source,
      targetPath: path.join(paperclipSkillsHome, available.runtimeName),
      detail: managed
        ? "Installed in the shared Hermes skills home."
        : desired
          ? "Configured but not currently linked into the shared Hermes skills home."
          : null,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableEntries.some((entry) => entry.key === desiredSkill)) continue;
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
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.push(...await scanUserHermesSkills(hermesHome));
  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function executeHermesWrapper(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  try {
    await prepareHermesPaperclipSkills(readRecord(ctx.config));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[adapter:hermes_local] Failed to prepare Paperclip skills: ${message}\n`);
  }
  const wrappedCtx: HermesExecutionContext = {
    runId: ctx.runId,
    agent: ctx.agent,
    runtime: ctx.runtime,
    config: ctx.config,
    context: ctx.context,
    onLog: ctx.onLog,
    onMeta: ctx.onMeta,
    onSpawn: ctx.onSpawn
      ? (meta) =>
          ctx.onSpawn!({
            pid: meta.pid,
            processGroupId: null,
            startedAt: meta.startedAt,
          })
      : undefined,
    authToken: ctx.authToken,
  };
  return hermesExecute(wrappedCtx);
}

export async function testEnvironmentHermesWrapper(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { testEnvironment } = await import("./hermes-test.js");
  return testEnvironment({
    ...ctx,
    adapterType: "hermes_local",
  });
}

export async function listHermesSkillsWrapper(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function syncHermesSkillsWrapper(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir, [PAPERCLIP_SKILLS_ROOT]);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const paperclipSkillsHome = resolvePaperclipHermesSkillsHome(ctx.config);
  await fs.mkdir(paperclipSkillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(paperclipSkillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    await ensurePaperclipSkillSymlink(
      available.source,
      path.join(paperclipSkillsHome, available.runtimeName),
    );
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(paperclipSkillsHome, name)).catch(() => {});
  }

  return buildHermesSkillSnapshot(ctx.config);
}

export async function detectModelFromHermesWrapper(
  hermesHome = readNonEmptyString(process.env.HERMES_HOME) ?? "/paperclip/hermes",
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const configPath = path.join(hermesHome, "config.yaml");
  const content = await fs.readFile(configPath, "utf8").catch(() => null);
  if (!content) return null;
  const detected = parseHermesModelFromConfig(content);
  if (!detected?.model) return null;
  return {
    model: detected.model,
    provider: detected.provider || "auto",
    source: configPath,
  };
}

export {
  hermesSessionCodec,
  hermesAgentConfigurationDoc,
  hermesModels,
};
