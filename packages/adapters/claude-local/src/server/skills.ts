import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveClaudeSkillsHome(config: Record<string, unknown>): { skillsHome: string; locationLabel: string } {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  // Claude Code reads skills from $CLAUDE_CONFIG_DIR/skills when the variable is set.
  // The agent env overrides the host env, the same as for the spawned process.
  const configDir = asString(env.CLAUDE_CONFIG_DIR) ?? asString(process.env.CLAUDE_CONFIG_DIR);
  if (configDir) {
    // Claude resolves a relative value against its working directory. The run uses
    // config.cwd when no issue workspace overrides it, so resolve against that.
    const baseDir = asString(config.cwd) ?? process.cwd();
    const skillsHome = path.join(path.resolve(baseDir, configDir), "skills");
    return { skillsHome, locationLabel: skillsHome };
  }
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return { skillsHome: path.join(home, ".claude", "skills"), locationLabel: "~/.claude/skills" };
}

async function buildClaudeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const { skillsHome, locationLabel } = resolveClaudeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "claude_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be materialized into the stable Paperclip-managed Claude prompt bundle on the next run.",
    externalInstalled: installed,
    externalLocationLabel: locationLabel,
    externalDetail: "Installed outside Paperclip management in the Claude skills home.",
    skillsHome,
  });
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
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
