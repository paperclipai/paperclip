/**
 * Skill delivery for Antigravity (agy).
 *
 * agy has a first-class skill loader with the same on-disk shape as Claude Code
 * (`<name>/SKILL.md` with `name` / `description` frontmatter), so Paperclip
 * skills need no transformation — only to land in a directory agy actually
 * scans. Probing agy confirms:
 *
 *   scanned      ~/.gemini/config/skills/<name>/SKILL.md
 *   scanned      <any --add-dir root>/.agents/skills/<name>/SKILL.md
 *   NOT scanned  ~/.gemini/skills/<name>/SKILL.md
 *   NOT scanned  <workspace>/.claude/skills, <workspace>/.gemini/skills
 *
 * `~/.gemini/skills` was where the legacy `gemini_local` lane linked skills,
 * but agy ignores it entirely. This module ensures skills are never targeted there.
 *
 * That `--add-dir` roots each contribute their own `.agents/skills` enables
 * per-agent isolation: the adapter passes `--add-dir <cwd>` to bind the workspace,
 * and an extra `--add-dir` pointing to a Paperclip-managed directory delivers
 * skills without writing into the user's workspace repo.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterExecutionContext,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  asString,
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  type InstalledSkillTarget,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const ADAPTER_TYPE = "agy_local";

/** Path segment agy scans for skills beneath every `--add-dir` root. */
export const AGY_WORKSPACE_SKILL_SUBPATH = path.join(".agents", "skills");

/** agy's global customization root. Always scanned, shared by every agy run on the host. */
export const AGY_GLOBAL_SKILLS_HOME_SEGMENTS = [".gemini", "config", "skills"] as const;

/** Root for the per-agent skill trees this adapter owns. */
export const AGY_AGENT_SKILL_ROOT_SEGMENTS = [".agy-paperclip", "agents"] as const;

export type AgySkillScope = "agent" | "global";

export interface AgySkillRoot {
  scope: AgySkillScope;
  /**
   * Directory to pass to agy as an extra `--add-dir`, or null when the skills
   * home is a root agy scans unconditionally.
   */
  addDir: string | null;
  /** Directory holding `<runtimeName>/SKILL.md`. */
  skillsHome: string;
  /** Human-readable location for the Paperclip skills UI. */
  locationLabel: string;
}

export interface ResolveAgySkillRootInput {
  config: Record<string, unknown>;
  agentId?: string | null;
  /** Overridable for tests; defaults to the process user's home directory. */
  homeDir?: string;
}

function normalizeScope(value: unknown): AgySkillScope {
  return typeof value === "string" && value.trim().toLowerCase() === "global"
    ? "global"
    : "agent";
}

/**
 * Sanitize an agent id into a single path segment.
 */
export function sanitizeAgentIdSegment(agentId: string): string {
  const cleaned = agentId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "unknown-agent";
  return cleaned;
}

/**
 * Decide where this agent's skills live based on configuration and scope.
 */
export function resolveAgySkillRoot(input: ResolveAgySkillRootInput): AgySkillRoot {
  const { config } = input;
  const agentId = input.agentId ?? "default";
  const homeDir = input.homeDir ?? os.homedir();
  const scope = normalizeScope(config.skillsScope);

  if (scope === "global") {
    const skillsHome = path.join(homeDir, ...AGY_GLOBAL_SKILLS_HOME_SEGMENTS);
    return {
      scope,
      addDir: null,
      skillsHome,
      locationLabel: skillsHome,
    };
  }

  const configuredRoot = asString(config.skillsRootPath, "").trim();
  const addDir = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(homeDir, ...AGY_AGENT_SKILL_ROOT_SEGMENTS, sanitizeAgentIdSegment(agentId));

  return {
    scope,
    addDir,
    skillsHome: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
    locationLabel: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
  };
}

export function resolveAgySkillsHome(
  config: Record<string, unknown>,
  agentId?: string | null,
): string {
  return resolveAgySkillRoot({ config, agentId }).skillsHome;
}

function warningsForRoot(root: AgySkillRoot): string[] {
  if (root.scope !== "global") return [];
  return [
    'skillsScope is "global": every agy agent on this host shares ' +
      `${root.skillsHome}, so skills synced for one agent are visible to all of them.`,
  ];
}

function buildSnapshot(options: {
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  root: AgySkillRoot;
  warnings: string[];
}): AdapterSkillSnapshot {
  const { availableEntries, desiredSkills, installed, root, warnings } = options;
  return buildPersistentSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome: root.skillsHome,
    locationLabel: root.locationLabel,
    installedDetail:
      root.scope === "global"
        ? "Linked into agy's global skills directory."
        : "Linked into this agent's agy skill root and passed to the run with --add-dir.",
    missingDetail: "Not linked into an agy skills directory yet; run a skill sync.",
    externalConflictDetail:
      "A different skill directory already occupies this name in agy's skills directory. Paperclip will not overwrite it.",
    externalDetail: "Installed in agy's skills directory outside Paperclip management.",
    warnings,
  });
}

export async function listAgySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const root = resolveAgySkillRoot({ config: ctx.config, agentId: ctx.agentId });
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(ctx.config, availableEntries);
  const installed = await readInstalledSkillTargets(root.skillsHome);
  return buildSnapshot({
    availableEntries,
    desiredSkills,
    installed,
    root,
    warnings: warningsForRoot(root),
  });
}

export const listSkills = listAgySkills;

export async function syncAgySkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const root = resolveAgySkillRoot({ config: ctx.config, agentId: ctx.agentId });
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const warnings = warningsForRoot(root);

  await fs.mkdir(root.skillsHome, { recursive: true });

  // Link everything desired
  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      warnings.push(`Skipped "${entry.runtimeName}": its skill files are not available on disk.`);
      continue;
    }
    const target = path.join(root.skillsHome, entry.runtimeName);
    try {
      const outcome = await ensurePaperclipSkillSymlink(entry.source, target);
      if (outcome === "skipped") {
        const existing = await fs.lstat(target).catch(() => null);
        if (existing && !existing.isSymbolicLink()) {
          warnings.push(
            `Left "${entry.runtimeName}" alone: ${target} exists and is not a Paperclip-managed link.`,
          );
        }
      }
    } catch (err) {
      warnings.push(
        `Failed to link "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Remove links this adapter previously created for skills no longer desired
  const installedBefore = await readInstalledSkillTargets(root.skillsHome);
  const managedSources = new Set(availableEntries.map((entry) => entry.source));
  for (const [runtimeName, installedEntry] of installedBefore) {
    if (installedEntry.kind !== "symlink") continue;
    if (!installedEntry.targetPath || !managedSources.has(installedEntry.targetPath)) continue;
    const entry = availableEntries.find((candidate) => candidate.runtimeName === runtimeName);
    if (entry && desiredSet.has(entry.key)) continue;
    await fs.unlink(path.join(root.skillsHome, runtimeName)).catch(() => {});
  }

  const installed = await readInstalledSkillTargets(root.skillsHome);
  return buildSnapshot({ availableEntries, desiredSkills, installed, root, warnings });
}

export const syncSkills = syncAgySkills;

export interface RunSkillSync {
  root: AgySkillRoot;
  /** Null when the run performed no sync (global scope, or nothing to deliver). */
  snapshot: AdapterSkillSnapshot | null;
  /** Skill keys this run expected to be present. */
  desiredSkills: string[];
  warnings: string[];
}

/**
 * Reconcile this agent's skill root before a heartbeat run begins.
 */
export async function syncSkillsForRun(input: {
  config: Record<string, unknown>;
  agentId: string;
  companyId: string;
}): Promise<RunSkillSync> {
  const { config, agentId, companyId } = input;
  const root = resolveAgySkillRoot({ config, agentId });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);

  if (root.scope === "global") {
    return { root, snapshot: null, desiredSkills, warnings: [] };
  }
  if (desiredSkills.length === 0 && availableEntries.length === 0) {
    return { root, snapshot: null, desiredSkills, warnings: [] };
  }

  const snapshot = await syncAgySkills(
    { agentId, companyId, adapterType: ADAPTER_TYPE, config },
    desiredSkills,
  );
  return { root, snapshot, desiredSkills, warnings: snapshot.warnings };
}

/** Prefix every skill-sync receipt line carries, so a run log can be grepped for it. */
export const SKILL_SYNC_LOG_PREFIX = "[paperclip] skill sync:";

function shortVersion(versionId: string | null | undefined): string {
  const value = (versionId ?? "").trim();
  if (!value) return "unpinned";
  return value.length > 8 ? value.slice(0, 8) : value;
}

/**
 * Render a per-run receipt for what skill sync actually did.
 */
export function describeRunSkillSync(sync: RunSkillSync): string[] {
  const { root, snapshot, desiredSkills } = sync;

  if (root.scope === "global") {
    return [
      `${SKILL_SYNC_LOG_PREFIX} skipped — skillsScope is "global"; ${root.skillsHome} is ` +
        "shared host-wide and is only reconciled by an explicit sync, never per run.",
    ];
  }
  if (!snapshot) {
    return [
      `${SKILL_SYNC_LOG_PREFIX} nothing to deliver — no skills are assigned to this agent. ` +
        `Root: ${root.skillsHome}`,
    ];
  }

  const desiredSet = new Set(desiredSkills);
  const delivered = snapshot.entries.filter((entry) => entry.desired && entry.state === "installed");
  const undelivered = snapshot.entries.filter(
    (entry) => entry.desired && entry.state !== "installed",
  );
  const lines = [
    `${SKILL_SYNC_LOG_PREFIX} ${delivered.length}/${desiredSet.size} desired skill(s) installed` +
      `${undelivered.length > 0 ? `, ${undelivered.length} not installed` : ""}. ` +
      `Root: ${root.skillsHome}`,
  ];
  for (const entry of delivered) {
    lines.push(
      `${SKILL_SYNC_LOG_PREFIX}   installed ${entry.runtimeName ?? "(unnamed)"} ` +
        `version=${shortVersion(entry.versionId)} key=${entry.key}`,
    );
  }
  for (const entry of undelivered) {
    lines.push(
      `${SKILL_SYNC_LOG_PREFIX}   ${entry.state}` +
        `${entry.runtimeName ? ` ${entry.runtimeName}` : ""} key=${entry.key}`,
    );
  }
  return lines;
}

/** Legacy helper for backward compatibility */
export async function ensureAgySkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveAgySkillsHome({}),
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  await fs.mkdir(skillsHome, { recursive: true });
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Antigravity skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not link Antigravity skill "${entry.key}" into ${skillsHome}: ${reason}\n`,
      );
    }
  }
}

export function resolveAgyDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
