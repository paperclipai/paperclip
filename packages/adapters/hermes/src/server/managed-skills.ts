import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

interface PreparedHermesManagedSkills {
  runtimeRoot: string;
  skillNames: string[];
  cleanup: () => Promise<void>;
}

const HERMES_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function configEnv(config: Record<string, unknown>): Record<string, unknown> {
  return typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
    ? (config.env as Record<string, unknown>)
    : {};
}

function envString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { value?: unknown }).value === "string" &&
    (value as { value: string }).value.trim()
  ) {
    return (value as { value: string }).value.trim();
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readProfile(extraArgs: unknown): string | null {
  const args = stringArray(extraArgs);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!.trim();
    const combined = arg.match(/^(?:--profile|-p)\s+(.+)$/);
    if (combined) return combined[1]!.trim() || null;
    if (arg === "--profile" || arg === "-p") return args[index + 1]?.trim() || null;
    if (arg.startsWith("--profile=") || arg.startsWith("-p=")) {
      return arg.slice(arg.indexOf("=") + 1).trim() || null;
    }
  }
  return null;
}

function resolveHermesSkillsHome(config: Record<string, unknown>): string {
  const env = configEnv(config);
  const explicitHermesHome = envString(env.HERMES_HOME);
  const home = envString(env.HOME);
  const hermesHome = explicitHermesHome
    ? path.resolve(explicitHermesHome)
    : path.join(home ? path.resolve(home) : os.homedir(), ".hermes");
  const profile = readProfile(config.extraArgs);
  if (profile && !HERMES_PROFILE_NAME_RE.test(profile)) {
    throw new Error(`Invalid Hermes profile name ${JSON.stringify(profile)}.`);
  }
  return profile ? path.join(hermesHome, "profiles", profile, "skills") : path.join(hermesHome, "skills");
}

function safeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_SEGMENT_RE.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid ${label} ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function safeRunSegment(runId: string): string {
  const normalized = runId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safeSegment(normalized || "run", "Hermes runtime skill run id");
}

async function copySkillDirectory(source: string, target: string): Promise<void> {
  const sourceRoot = path.resolve(source);
  const stat = await fs.stat(sourceRoot);
  if (!stat.isDirectory()) throw new Error(`Managed skill source is not a directory: ${sourceRoot}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(sourceRoot, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (candidate) => !(await fs.lstat(candidate)).isSymbolicLink(),
  });
}

export async function prepareHermesManagedSkills(input: {
  config: Record<string, unknown>;
  moduleDir: string;
  runId: string;
}): Promise<PreparedHermesManagedSkills> {
  const available = await readPaperclipRuntimeSkillEntries(input.config, input.moduleDir);
  const desiredNames = resolvePaperclipDesiredSkillNames(input.config, available);
  const desiredSet = new Set(desiredNames);
  if (desiredSet.size === 0) {
    return { runtimeRoot: "", skillNames: [], cleanup: async () => undefined };
  }

  const availableByKey = new Map(available.map((entry) => [entry.key, entry]));
  for (const desired of desiredNames) {
    const entry = availableByKey.get(desired);
    if (!entry) throw new Error(`Desired managed Hermes skill ${JSON.stringify(desired)} is unavailable.`);
    if (entry.sourceStatus === "missing") {
      throw new Error(entry.missingDetail || `Managed Hermes skill source is missing: ${entry.source}`);
    }
    await fs.stat(path.join(entry.source, "SKILL.md")).catch(() => {
      throw new Error(`Managed Hermes skill source is missing SKILL.md: ${entry.source}`);
    });
  }

  const skillsHome = resolveHermesSkillsHome(input.config);
  const runtimeRelativeRoot = path.posix.join(".paperclip-runtime", safeRunSegment(input.runId));
  const runtimeRoot = path.join(skillsHome, ...runtimeRelativeRoot.split("/"));
  await fs.rm(runtimeRoot, { recursive: true, force: true });

  const skillNames: string[] = [];
  try {
    for (const entry of available) {
      if (!desiredSet.has(entry.key)) continue;
      const runtimeName = safeSegment(entry.runtimeName, "Hermes managed skill runtime name");
      await copySkillDirectory(entry.source, path.join(runtimeRoot, runtimeName));
      skillNames.push(path.posix.join(runtimeRelativeRoot, runtimeName));
    }
  } catch (error) {
    await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    runtimeRoot,
    skillNames,
    cleanup: async () => {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    },
  };
}
