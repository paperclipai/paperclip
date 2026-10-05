import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
  type InstalledSkillTarget,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// The OpenCode version line whose skills home should be targeted. Structurally
// identical to `OpenCodeVersionLine` in ./version.js; declared locally so this
// module stays usable before the version probe is wired into the callers.
export type OpenCodeSkillsTargetLine = "v1" | "v2" | "unknown";

// why: OpenCode v1 discovers Paperclip skills in the shared Claude skills home
// (~/.claude/skills). v2 prefers its own native global skills dir
// (~/.config/opencode/skills) and treats ~/.claude/skills as a lower-precedence
// compat source (r4 delta §4 / M15). Skill IDs are path-derived in v2, so the
// leaf directory name must stay stable across both homes.
const OPENCODE_SKILLS_SUBPATH_V1 = [".claude", "skills"] as const;
const OPENCODE_SKILLS_SUBPATH_V2 = ["opencode", "skills"] as const;

type InstalledSkillTargets = Map<string, InstalledSkillTarget>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveOpenCodeHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

// Resolve the skills home(s) a run should inject into for the detected OpenCode
// version line. Omitted/`v1` keeps the historical single `~/.claude/skills`
// target; `v2` targets the native global dir; `unknown` targets both so a run
// works whichever line is installed. The v2 home is resolved against the
// EFFECTIVE config home the run will see — the isolated `XDG_CONFIG_HOME` from
// prepareOpenCodeRuntimeConfig when active — because v2 locates its native
// skills dir via XDG_CONFIG_HOME; without it a v2 run never sees injected
// skills. The v1 home stays HOME-based.
export function resolveOpenCodeSkillsHomes(
  config: Record<string, unknown>,
  versionLine?: OpenCodeSkillsTargetLine,
  effectiveXdgConfigHome?: string | null,
): string[] {
  const home = resolveOpenCodeHome(config);
  const v1Home = path.join(home, ...OPENCODE_SKILLS_SUBPATH_V1);
  const configHome =
    (typeof effectiveXdgConfigHome === "string" && effectiveXdgConfigHome.trim()) ||
    path.join(home, ".config");
  const v2Home = path.join(configHome, ...OPENCODE_SKILLS_SUBPATH_V2);
  switch (versionLine) {
    case "v2":
      return [v2Home];
    case "unknown":
      return [v1Home, v2Home];
    case "v1":
      return [v1Home];
    default:
      return [v1Home];
  }
}

// why: skill management (the registered list/sync entry points) runs without a
// version line, so it must consider BOTH homes — `~/.claude/skills` and the
// HOME-based `~/.config/opencode/skills` — or the skills UI installed-state
// misses whatever the other run line installed. Management has no run env, so
// the v2 home here is HOME-based (not an isolated runtime config home).
export function allSkillsHomes(config: Record<string, unknown>): string[] {
  return resolveOpenCodeSkillsHomes(config, "unknown");
}

// Management considers both homes when no version line is known.
function resolveManagementSkillsHomes(
  config: Record<string, unknown>,
  versionLine?: OpenCodeSkillsTargetLine,
): string[] {
  return versionLine ? resolveOpenCodeSkillsHomes(config, versionLine) : allSkillsHomes(config);
}

interface SkillsTargetDescription {
  locationLabel: string;
  warning: string;
  installedDetail: string;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
}

function describeSkillsTarget(
  versionLine?: OpenCodeSkillsTargetLine,
): SkillsTargetDescription {
  switch (versionLine) {
    case "v2":
      return {
        locationLabel: "~/.config/opencode/skills",
        warning:
          "OpenCode v2 discovers skills in its native global skills home (~/.config/opencode/skills).",
        installedDetail: "Installed in the OpenCode v2 native skills home.",
        missingDetail:
          "Configured but not currently linked into the OpenCode v2 native skills home.",
        externalConflictDetail:
          "Skill name is occupied by an external installation in the OpenCode v2 native skills home.",
        externalDetail:
          "Installed outside Paperclip management in the OpenCode v2 native skills home.",
      };
    case "unknown":
      return {
        locationLabel: "~/.claude/skills and ~/.config/opencode/skills",
        warning:
          "OpenCode version is unknown; skills are linked into both the legacy (~/.claude/skills) and v2 native (~/.config/opencode/skills) skills homes.",
        installedDetail: "Installed in the shared Claude/OpenCode skills home.",
        missingDetail:
          "Configured but not currently linked into either OpenCode skills home.",
        externalConflictDetail:
          "Skill name is occupied by an external installation in an OpenCode skills home.",
        externalDetail: "Installed outside Paperclip management in an OpenCode skills home.",
      };
    case "v1":
      return {
        locationLabel: "~/.claude/skills",
        warning: "OpenCode v1 uses the shared Claude skills home (~/.claude/skills).",
        installedDetail: "Installed in the shared Claude/OpenCode skills home.",
        missingDetail:
          "Configured but not currently linked into the shared Claude/OpenCode skills home.",
        externalConflictDetail:
          "Skill name is occupied by an external installation in the shared skills home.",
        externalDetail: "Installed outside Paperclip management in the shared skills home.",
      };
    default:
      return {
        locationLabel: "~/.claude/skills",
        warning:
          "OpenCode currently uses the shared Claude skills home (~/.claude/skills).",
        installedDetail: "Installed in the shared Claude/OpenCode skills home.",
        missingDetail:
          "Configured but not currently linked into the shared Claude/OpenCode skills home.",
        externalConflictDetail:
          "Skill name is occupied by an external installation in the shared skills home.",
        externalDetail: "Installed outside Paperclip management in the shared skills home.",
      };
  }
}

// why: the `unknown` version line injects into both skills homes, so a skill is
// "installed" if it is linked into either one. Merge the per-home directory
// reads, preferring an entry whose link resolves to a Paperclip-managed source
// over an unrelated same-named entry in the other home.
async function readInstalledSkillTargetsForHomes(
  homes: string[],
  managedSources: ReadonlySet<string>,
): Promise<InstalledSkillTargets> {
  const merged: InstalledSkillTargets = new Map();
  const isManaged = (target: InstalledSkillTarget) =>
    target.targetPath !== null && managedSources.has(target.targetPath);
  for (const skillsHome of homes) {
    const installed = await readInstalledSkillTargets(skillsHome);
    for (const [name, target] of installed) {
      const existing = merged.get(name);
      if (!existing || (isManaged(target) && !isManaged(existing))) {
        merged.set(name, target);
      }
    }
  }
  return merged;
}

async function buildOpenCodeSkillSnapshot(
  config: Record<string, unknown>,
  versionLine?: OpenCodeSkillsTargetLine,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const homes = resolveManagementSkillsHomes(config, versionLine);
  const installed = await readInstalledSkillTargetsForHomes(
    homes,
    new Set(availableEntries.map((entry) => entry.source)),
  );
  const target = describeSkillsTarget(versionLine);
  return buildPersistentSkillSnapshot({
    adapterType: "opencode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome: homes[0],
    locationLabel: target.locationLabel,
    installedDetail: target.installedDetail,
    missingDetail: target.missingDetail,
    externalConflictDetail: target.externalConflictDetail,
    externalDetail: target.externalDetail,
    warnings: [target.warning],
  });
}

// Management entry points: called without a version line, they consider BOTH
// skills homes (see resolveManagementSkillsHomes) so the installed-state matches
// whatever line a run actually used. A caller that knows the line narrows the
// homes to that line.
export async function listOpenCodeSkills(
  ctx: AdapterSkillContext,
  versionLine?: OpenCodeSkillsTargetLine,
): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config, versionLine);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
  versionLine?: OpenCodeSkillsTargetLine,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const homes = resolveManagementSkillsHomes(ctx.config, versionLine);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const skillsHome of homes) {
    await fs.mkdir(skillsHome, { recursive: true });
    const installed = await readInstalledSkillTargets(skillsHome);

    for (const available of availableEntries) {
      if (!desiredSet.has(available.key)) continue;
      const target = path.join(skillsHome, available.runtimeName);
      await ensurePaperclipSkillSymlink(available.source, target);
    }

    for (const [name, installedEntry] of installed.entries()) {
      const available = availableByRuntimeName.get(name);
      if (!available) continue;
      if (desiredSet.has(available.key)) continue;
      if (installedEntry.targetPath !== available.source) continue;
      await fs.unlink(path.join(skillsHome, name)).catch(() => {});
    }
  }

  return buildOpenCodeSkillSnapshot(ctx.config, versionLine);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
