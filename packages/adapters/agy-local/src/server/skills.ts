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

export async function linkSkillDirectory(source: string, target: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await fs.symlink(source, target, "junction");
      return;
    } catch {
      // Fallback to default symlink if junction creation fails
    }
  }
  await fs.symlink(source, target);
}

export async function unlinkSkillDirectory(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (!stat.isSymbolicLink()) {
    const err = new Error(`Cannot unlink non-symlink: ${target}`);
    (err as NodeJS.ErrnoException).code = process.platform === "win32" ? "EPERM" : "EISDIR";
    throw err;
  }
  if (process.platform === "win32") {
    try {
      await fs.unlink(target);
      return;
    } catch {
      const recheck = await fs.lstat(target).catch(() => null);
      if (recheck?.isSymbolicLink()) {
        await fs.rmdir(target);
      }
      return;
    }
  }
  await fs.unlink(target);
}

export const ADAPTER_TYPE = "agy_local";

/** Path segment agy scans for skills beneath every `--add-dir` root. */
export const AGY_WORKSPACE_SKILL_SUBPATH = path.join(".agents", "skills");

/** agy's global customization root. Always scanned, shared by every agy run on the host. */
export const AGY_GLOBAL_SKILLS_HOME_SEGMENTS = [".gemini", "config", "skills"] as const;

/** Root for the per-agent skill trees this adapter owns. */
export const AGY_AGENT_SKILL_ROOT_SEGMENTS = [".agy-paperclip", "agents"] as const;

export type AgySkillScope = "agent";

export interface AgySkillRoot {
  scope: AgySkillScope;
  /**
   * Directory to pass to agy as an extra `--add-dir`. Always non-null to guarantee
   * agent and company isolation.
   */
  addDir: string;
  /** Directory holding `<runtimeName>/SKILL.md`. */
  skillsHome: string;
  /** Legacy directory holding `<runtimeName>/SKILL.md` before agent-scoping was applied. */
  legacySkillsHome?: string;
  /** Company ID this agent belongs to. */
  companyId?: string | null;
  /** Human-readable location for the Paperclip skills UI. */
  locationLabel: string;
  warnings?: string[];
}

export interface ResolveAgySkillRootInput {
  config: Record<string, unknown>;
  agentId?: string | null;
  companyId?: string | null;
  /** Overridable for tests; defaults to the process user's home directory. */
  homeDir?: string;
}

function normalizeScope(_value: unknown): AgySkillScope {
  return "agent";
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
 * Always resolves to an isolated per-agent directory to guarantee company boundaries.
 */
export function resolveAgySkillRoot(input: ResolveAgySkillRootInput): AgySkillRoot {
  const { config } = input;
  const agentId = input.agentId ?? "default";
  const companyId = input.companyId ?? (asString(config.companyId, "") || null);
  const homeDir = input.homeDir ?? os.homedir();
  const scope = normalizeScope(config.skillsScope);

  const safeAgentId = sanitizeAgentIdSegment(agentId);
  const configuredRoot = asString(config.skillsRootPath, "").trim();
  let addDir: string;
  let legacySkillsHome: string | undefined;
  if (configuredRoot) {
    const resolvedRoot = path.resolve(configuredRoot);
    if (path.basename(resolvedRoot) === safeAgentId) {
      addDir = resolvedRoot;
    } else {
      addDir = path.join(resolvedRoot, safeAgentId);
      legacySkillsHome = path.join(resolvedRoot, AGY_WORKSPACE_SKILL_SUBPATH);
    }
  } else {
    addDir = path.join(homeDir, ...AGY_AGENT_SKILL_ROOT_SEGMENTS, safeAgentId);
  }

  const hasGlobalScope =
    typeof config.skillsScope === "string" &&
    config.skillsScope.trim().toLowerCase() === "global";

  return {
    scope,
    addDir,
    skillsHome: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
    legacySkillsHome,
    companyId,
    locationLabel: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
    warnings: hasGlobalScope
      ? [
          'skillsScope "global" is disabled to prevent cross-company skill leakage on shared hosts; using an isolated per-agent skill root instead.',
        ]
      : [],
  };
}

export function resolveAgySkillsHome(
  config: Record<string, unknown>,
  agentId?: string | null,
): string {
  return resolveAgySkillRoot({ config, agentId }).skillsHome;
}

function warningsForRoot(root: AgySkillRoot): string[] {
  return root.warnings ? [...root.warnings] : [];
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
      "Linked into this agent's agy skill root and passed to the run with --add-dir.",
    missingDetail: "Not linked into an agy skills directory yet; run a skill sync.",
    externalConflictDetail:
      "A different skill directory already occupies this name in agy's skills directory. Paperclip will not overwrite it.",
    externalDetail: "Installed in agy's skills directory outside Paperclip management.",
    warnings,
  });
}

export interface MigrateLegacySkillsOptions {
  companyId?: string | null;
  availableEntries?: PaperclipSkillEntry[];
}

export function extractCompanyIdFromSkillMarkdown(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/);
  if (!match) return null;
  const frontmatter = match[1];

  const lines = frontmatter.split(/\r?\n/);
  for (const line of lines) {
    const fieldMatch = line.match(
      /^\s*(?:companyId|company_id|company|ownerCompanyId)\s*:\s*['"]?([a-zA-Z0-9_-]+)['"]?\s*$/i,
    );
    if (fieldMatch) {
      return fieldMatch[1];
    }
  }

  return null;
}

export async function readSkillDirectoryCompanyId(dirPath: string): Promise<string | null> {
  const textFiles = [".companyId", ".company"];
  for (const filename of textFiles) {
    try {
      const raw = (await fs.readFile(path.join(dirPath, filename), "utf8")).trim();
      if (!raw) continue;
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          const cid = asString(
            parsed.companyId ?? parsed.company_id ?? parsed.company ?? parsed.ownerCompanyId,
            "",
          ).trim();
          if (cid) return cid;
        } catch {
          // not json
        }
      }
      if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
        return raw;
      }
    } catch {
      // not found
    }
  }

  const jsonFiles = ["company.json", "skill.json", "metadata.json", ".paperclip.json"];
  for (const filename of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dirPath, filename), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const cid = asString(
          parsed.companyId ?? parsed.company_id ?? parsed.company ?? parsed.ownerCompanyId,
          "",
        ).trim();
        if (cid) return cid;
      }
    } catch {
      // not found or invalid json
    }
  }

  try {
    const raw = await fs.readFile(path.join(dirPath, "SKILL.md"), "utf8");
    const cid = extractCompanyIdFromSkillMarkdown(raw);
    if (cid) return cid;
  } catch {
    // SKILL.md not found
  }

  return null;
}

export function extractCompanyIdFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(?:skills|companies)\/([a-zA-Z0-9_-]+)(?:\/|$)/i);
  if (match) {
    const candidate = match[1];
    if (!candidate.startsWith("__")) {
      return candidate;
    }
  }
  return null;
}

function extractCompanyFromPathSegment(filePath: string, currentCompanyId: string | null): string | null {
  const fromStandard = extractCompanyIdFromPath(filePath);
  if (fromStandard) return fromStandard;

  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(company-[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+-company)(?:\/|$)/i);
  if (match) {
    return match[1];
  }
  return null;
}

export async function isEntryOwnedByOtherCompany(
  legacySkillsHome: string,
  entry: import("node:fs").Dirent,
  options: MigrateLegacySkillsOptions,
): Promise<boolean> {
  const currentCompanyId = options.companyId?.trim() || null;
  const availableEntries = options.availableEntries ?? [];
  const src = path.join(legacySkillsHome, entry.name);

  if (entry.isSymbolicLink()) {
    let linkTarget: string | null = null;
    try {
      linkTarget = await fs.readlink(src);
    } catch {
      return false;
    }
    const resolvedTarget = path.resolve(path.dirname(src), linkTarget);

    // 1. If symlink points directly to one of current company's available skill sources,
    // it belongs to current company.
    if (availableEntries.some((e) => path.resolve(e.source) === resolvedTarget)) {
      return false;
    }

    // 2. If current company has an available skill with matching runtimeName or key,
    // but the symlink target does NOT match its source, this symlink belongs to another company.
    const matchingAvailable = availableEntries.find(
      (e) => e.runtimeName === entry.name || e.key === entry.name,
    );
    if (matchingAvailable && path.resolve(matchingAvailable.source) !== resolvedTarget) {
      return true;
    }

    // 3. Check company ID from path (e.g. /skills/<companyId>/ or /companies/<companyId>/)
    const pathCompanyId =
      extractCompanyIdFromPath(resolvedTarget) ||
      extractCompanyIdFromPath(linkTarget) ||
      extractCompanyFromPathSegment(resolvedTarget, currentCompanyId) ||
      extractCompanyFromPathSegment(linkTarget, currentCompanyId);
    if (pathCompanyId && currentCompanyId && pathCompanyId !== currentCompanyId) {
      return true;
    }

    // 4. Check company ID from resolved target directory metadata
    const targetDirCompanyId = await readSkillDirectoryCompanyId(resolvedTarget);
    if (targetDirCompanyId && currentCompanyId && targetDirCompanyId !== currentCompanyId) {
      return true;
    }

    return false;
  }

  // Directory or file directly in legacySkillsHome
  const dirCompanyId = await readSkillDirectoryCompanyId(src);
  if (dirCompanyId && currentCompanyId && dirCompanyId !== currentCompanyId) {
    return true;
  }

  return false;
}

/**
 * Migrates existing custom skills from the un-scoped legacy directory
 * (e.g. `<configuredRoot>/.agents/skills`) into the agent-scoped directory
 * (`<configuredRoot>/<agentId>/.agents/skills`), while preserving any skills
 * owned by other companies on a shared host.
 */
export async function migrateLegacySkills(
  root: AgySkillRoot,
  options?: MigrateLegacySkillsOptions,
): Promise<string[]> {
  const { legacySkillsHome, skillsHome } = root;
  if (!legacySkillsHome || legacySkillsHome === skillsHome) {
    return [];
  }

  const effectiveOptions: MigrateLegacySkillsOptions = {
    companyId: options?.companyId ?? root.companyId ?? null,
    availableEntries: options?.availableEntries ?? [],
  };

  let entries: import("node:fs").Dirent[];
  try {
    const stat = await fs.stat(legacySkillsHome);
    if (!stat.isDirectory()) return [];
    entries = await fs.readdir(legacySkillsHome, { withFileTypes: true });
  } catch {
    return [];
  }

  if (entries.length === 0) {
    await fs.rmdir(legacySkillsHome).catch(() => {});
    await fs.rmdir(path.dirname(legacySkillsHome)).catch(() => {});
    return [];
  }

  await fs.mkdir(skillsHome, { recursive: true });

  const migrated: string[] = [];

  for (const entry of entries) {
    if (await isEntryOwnedByOtherCompany(legacySkillsHome, entry, effectiveOptions)) {
      continue;
    }

    const src = path.join(legacySkillsHome, entry.name);
    const dest = path.join(skillsHome, entry.name);

    const destStat = await fs.lstat(dest).catch(() => null);
    if (destStat) {
      continue;
    }

    const currentCompanyId = effectiveOptions.companyId?.trim() || null;
    let isExplicitlyCompanyOwned = false;

    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await fs.readlink(src);
        const resolvedTarget = path.resolve(path.dirname(src), linkTarget);
        if (effectiveOptions.availableEntries?.some((e) => path.resolve(e.source) === resolvedTarget)) {
          isExplicitlyCompanyOwned = true;
        } else {
          const targetDirCompanyId = await readSkillDirectoryCompanyId(resolvedTarget);
          if (targetDirCompanyId && currentCompanyId && targetDirCompanyId === currentCompanyId) {
            isExplicitlyCompanyOwned = true;
          }
        }
      } catch {
        // failed reading symlink
      }
    } else {
      const dirCompanyId = await readSkillDirectoryCompanyId(src);
      if (dirCompanyId && currentCompanyId && dirCompanyId === currentCompanyId) {
        isExplicitlyCompanyOwned = true;
      }
    }

    if (isExplicitlyCompanyOwned) {
      try {
        if (entry.isSymbolicLink()) {
          const linkTarget = await fs.readlink(src);
          const resolvedTarget = path.resolve(path.dirname(src), linkTarget);
          await linkSkillDirectory(resolvedTarget, dest);
          await unlinkSkillDirectory(src);
          migrated.push(entry.name);
        } else {
          await fs.rename(src, dest);
          migrated.push(entry.name);
        }
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "EXDEV") {
          try {
            if (entry.isSymbolicLink()) {
              const linkTarget = await fs.readlink(src);
              const resolvedTarget = path.resolve(path.dirname(src), linkTarget);
              await linkSkillDirectory(resolvedTarget, dest);
              await unlinkSkillDirectory(src);
            } else {
              await fs.cp(src, dest, { recursive: true });
              await fs.rm(src, { recursive: true, force: true });
            }
            migrated.push(entry.name);
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  const remaining = await fs.readdir(legacySkillsHome).catch(() => []);
  if (remaining.length === 0) {
    await fs.rmdir(legacySkillsHome).catch(() => {});
    await fs.rmdir(path.dirname(legacySkillsHome)).catch(() => {});
  }

  return migrated;
}

export async function listAgySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const root = resolveAgySkillRoot({
    config: ctx.config,
    agentId: ctx.agentId,
    companyId: ctx.companyId,
  });
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  await migrateLegacySkills(root, { companyId: ctx.companyId, availableEntries });
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
  const root = resolveAgySkillRoot({
    config: ctx.config,
    agentId: ctx.agentId,
    companyId: ctx.companyId,
  });
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  await migrateLegacySkills(root, { companyId: ctx.companyId, availableEntries });
  const desiredSet = new Set(desiredSkills);
  const warnings = warningsForRoot(root);

  await fs.mkdir(root.skillsHome, { recursive: true });

  // Remove links this adapter previously created for skills no longer
  // desired. A deselected skill also disappears from the configured runtime
  // skill list, so current entries alone cannot identify its old link; the
  // managed-links manifest recorded at each sync names the links this
  // adapter created and where they point.
  const previouslyManaged = await readManagedSkillsManifest(root);
  const installedBefore = await readInstalledSkillTargets(root.skillsHome);
  for (const [runtimeName, installedEntry] of installedBefore) {
    if (installedEntry.kind !== "symlink") continue;
    if (!installedEntry.targetPath) continue;
    const entry = availableEntries.find((candidate) => candidate.runtimeName === runtimeName);
    if (entry && desiredSet.has(entry.key)) continue;
    const isRecordedLink = previouslyManaged[runtimeName] === installedEntry.targetPath;
    const isCurrentEntryLink = entry !== undefined && installedEntry.targetPath === entry.source;
    if (!isRecordedLink && !isCurrentEntryLink) continue;
    await unlinkSkillDirectory(path.join(root.skillsHome, runtimeName)).catch(() => {});
  }

  // Link everything desired
  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      warnings.push(`Skipped "${entry.runtimeName}": its skill files are not available on disk.`);
      continue;
    }
    const target = path.join(root.skillsHome, entry.runtimeName);
    const existing = installedBefore.get(entry.runtimeName);
    if (
      existing?.kind === "symlink" &&
      existing.targetPath &&
      existing.targetPath !== entry.source &&
      previouslyManaged[entry.runtimeName] === existing.targetPath
    ) {
      await unlinkSkillDirectory(target).catch(() => {});
    }
    try {
      const outcome = await ensurePaperclipSkillSymlink(
        entry.source,
        target,
        linkSkillDirectory,
        unlinkSkillDirectory,
      );
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

  const installed = await readInstalledSkillTargets(root.skillsHome);
  // Record exactly the managed links now in place so the next sync can
  // prune a skill that has since been deselected (and dropped from the
  // configured list), including when the next desired list is empty.
  const managedLinks: Record<string, string> = {};
  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    const installedEntry = installed.get(entry.runtimeName);
    if (installedEntry?.kind === "symlink" && installedEntry.targetPath === entry.source) {
      managedLinks[entry.runtimeName] = entry.source;
    }
  }
  await writeManagedSkillsManifest(root, managedLinks);
  return buildSnapshot({ availableEntries, desiredSkills, installed, root, warnings });
}

export const syncSkills = syncAgySkills;

/** File (kept in the agent's add-dir root, outside the scanned skills tree)
 * recording the links this adapter created, so a later sync can remove a
 * link whose skill was deselected even after the skill disappears from the
 * configured runtime skill list. */
export const AGY_MANAGED_SKILLS_MANIFEST_FILENAME = ".paperclip-managed-skills.json";

export function managedSkillsManifestPath(root: AgySkillRoot): string {
  return path.join(root.addDir, AGY_MANAGED_SKILLS_MANIFEST_FILENAME);
}

async function readManagedSkillsManifest(root: AgySkillRoot): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(managedSkillsManifestPath(root), "utf8");
    const parsed = JSON.parse(raw) as { links?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.links || typeof parsed.links !== "object") {
      return {};
    }
    const links: Record<string, string> = {};
    for (const [runtimeName, target] of Object.entries(parsed.links as Record<string, unknown>)) {
      if (typeof target === "string" && target.length > 0) links[runtimeName] = target;
    }
    return links;
  } catch {
    return {};
  }
}

async function writeManagedSkillsManifest(
  root: AgySkillRoot,
  links: Record<string, string>,
): Promise<void> {
  try {
    await fs.mkdir(root.addDir, { recursive: true });
    await fs.writeFile(
      managedSkillsManifestPath(root),
      JSON.stringify({ version: 1, links }, null, 2) + "\n",
    );
  } catch {
    // Best-effort: without a manifest the next sync falls back to matching
    // links against the currently configured skill entries.
  }
}

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
  const root = resolveAgySkillRoot({ config, agentId, companyId });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  await migrateLegacySkills(root, { companyId, availableEntries });
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);

  if (desiredSkills.length === 0 && availableEntries.length === 0) {
    // Nothing to deliver — but links managed by an earlier assignment may
    // still be in place. Skip the sync only when none of those links are
    // installed; otherwise fall through so syncAgySkills can prune links
    // whose skills were deselected. User-installed skills in the same home
    // do not count: they are not Paperclip's to prune.
    const previouslyManaged = await readManagedSkillsManifest(root);
    const installed = await readInstalledSkillTargets(root.skillsHome);
    let hasManagedLink = false;
    for (const [runtimeName, installedEntry] of installed) {
      if (
        installedEntry.kind === "symlink" &&
        installedEntry.targetPath !== null &&
        previouslyManaged[runtimeName] === installedEntry.targetPath
      ) {
        hasManagedLink = true;
        break;
      }
    }
    if (!hasManagedLink) {
      return { root, snapshot: null, desiredSkills, warnings: root.warnings ? [...root.warnings] : [] };
    }
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
      const result = await ensurePaperclipSkillSymlink(
        entry.source,
        target,
        linkSkillDirectory,
        unlinkSkillDirectory,
      );
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
