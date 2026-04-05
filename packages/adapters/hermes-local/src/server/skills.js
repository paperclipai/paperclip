import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asStringArray,
  asTrimmedString,
  ensureDir,
  readFileIfExists,
  resolveHermesHome,
} from '../shared/utils.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_ROOT = path.resolve(MODULE_DIR, '..', '..', 'skills');
const COMPANION_SKILL_REQUIRED_REASON = 'Paperclip companion skills should stay available for Hermes agents.';
const MANAGED_MISSING_DETAIL = 'Configured but not currently installed into the Hermes skills home.';
const MANAGED_EXTERNAL_CONFLICT_DETAIL = 'Skill name is occupied by another Hermes installation.';
const MANAGED_EXTERNAL_DETAIL = 'Installed outside Paperclip management.';

function builtinsRoot() {
  return BUNDLED_SKILLS_ROOT;
}

function normalizePortablePath(value) {
  return value.replaceAll('\\', '/');
}

function lastKeySegment(value, fallback = '') {
  const segments = String(value || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] || fallback;
}

function shortKeyHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
}

function isPaperclipBundledKey(key) {
  return typeof key === 'string' && key.startsWith('paperclipai/paperclip/');
}

function inferManagedCategory(entry) {
  if (entry.sourceKind === 'bundled') return entry.category;
  if (entry.required || isPaperclipBundledKey(entry.key)) return 'paperclip';
  return 'company';
}

function inferPreferredSkillName(entry) {
  if (entry.sourceKind === 'bundled') return entry.runtimeName;
  return lastKeySegment(entry.key, entry.runtimeName) || entry.runtimeName;
}

function groupByRuntimeName(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.runtimeName;
    const current = grouped.get(key) || [];
    current.push(entry);
    grouped.set(key, current);
  }
  return grouped;
}

async function pathExists(candidate) {
  const stats = await fs.stat(candidate).catch(() => null);
  return Boolean(stats);
}

async function collectSkillDirs(root, current = root, out = []) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    out.push(current);
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    await collectSkillDirs(root, path.join(current, entry.name), out);
  }

  return out;
}

async function scanSkillTree(root) {
  const rootStats = await fs.stat(root).catch(() => null);
  if (!rootStats?.isDirectory()) return [];

  const skillDirs = await collectSkillDirs(root);
  const entries = [];

  for (const skillDir of skillDirs.sort((left, right) => left.localeCompare(right))) {
    const skillFile = path.join(skillDir, 'SKILL.md');
    const content = await readFileIfExists(skillFile);
    const relativeDir = normalizePortablePath(path.relative(root, skillDir));
    const parts = relativeDir && relativeDir !== '.'
      ? relativeDir.split('/').filter(Boolean)
      : [path.basename(skillDir)];
    const runtimeName = parts[parts.length - 1] || path.basename(skillDir);
    const category = parts.length > 1 ? parts.slice(0, -1).join('/') : 'general';

    entries.push({
      runtimeName,
      category,
      sourcePath: skillDir,
      skillFile,
      detail: parseSkillDescription(content || ''),
    });
  }

  return entries;
}

function resolveRawDesiredSkillNames(config, desiredSkills = null) {
  if (Array.isArray(desiredSkills)) {
    return desiredSkills
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim());
  }
  return asStringArray(config.desiredSkills || config.skills || config.enabledSkills);
}

function canonicalizeDesiredSkillReference(reference, availableEntries) {
  const normalizedReference = String(reference || '').trim().toLowerCase();
  if (!normalizedReference) return '';

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byInstallName = availableEntries.filter(
    (entry) => entry.installName.trim().toLowerCase() === normalizedReference,
  );
  if (byInstallName.length === 1) return byInstallName[0].key;

  const byRuntimeName = availableEntries.filter(
    (entry) => entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0].key;

  const bySlug = availableEntries.filter(
    (entry) => lastKeySegment(entry.key, '').toLowerCase() === normalizedReference,
  );
  if (bySlug.length === 1) return bySlug[0].key;

  return normalizedReference;
}

async function scanBundledSkills() {
  const bundled = await scanSkillTree(builtinsRoot());
  return bundled.map((entry) => ({
    key: entry.runtimeName,
    runtimeName: entry.runtimeName,
    installName: entry.runtimeName,
    preferredName: entry.runtimeName,
    category: entry.category,
    sourcePath: entry.sourcePath,
    detail: entry.detail,
    sourceKind: 'bundled',
    required: true,
    requiredReason: COMPANION_SKILL_REQUIRED_REASON,
  }));
}

async function normalizePaperclipRuntimeSkillEntries(config) {
  if (!Array.isArray(config.paperclipRuntimeSkills)) return [];

  const out = [];
  for (const rawEntry of config.paperclipRuntimeSkills) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) continue;
    const entry = rawEntry;
    const key = asTrimmedString(entry.key) || asTrimmedString(entry.name);
    const runtimeName = asTrimmedString(entry.runtimeName) || asTrimmedString(entry.name);
    const sourcePath = asTrimmedString(entry.source);
    if (!key || !runtimeName || !sourcePath) continue;
    const detail = await readFileIfExists(path.join(sourcePath, 'SKILL.md'))
      .then((content) => parseSkillDescription(content || ''));
    const required = entry.required === true;
    out.push({
      key,
      runtimeName,
      installName: runtimeName,
      preferredName: inferPreferredSkillName({ key, runtimeName, sourceKind: 'paperclip_runtime' }),
      category: inferManagedCategory({ key, runtimeName, sourceKind: 'paperclip_runtime', required }),
      sourcePath,
      detail,
      sourceKind: 'paperclip_runtime',
      required,
      requiredReason:
        required && typeof entry.requiredReason === 'string' && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : (required ? 'Bundled Paperclip skills are always available for local adapters.' : null),
    });
  }

  return out;
}

async function scanHermesHomeSkills(config) {
  return scanSkillTree(path.join(resolveHermesHome(config), 'skills'));
}

function resolveManagedTargetPath(config, entry) {
  return path.join(resolveHermesHome(config), 'skills', entry.category, entry.installName);
}

function chooseInstallName(entry, localRoot, installedByName, usedNames) {
  const preferred = inferPreferredSkillName(entry) || entry.runtimeName;
  const preferredWithHash = `${preferred}--${shortKeyHash(entry.key)}`;
  const candidates = Array.from(new Set([
    preferred,
    entry.runtimeName,
    preferredWithHash,
  ].filter(Boolean)));

  for (const candidate of candidates) {
    if (usedNames.has(candidate)) continue;
    const expectedTarget = path.join(localRoot, entry.category, candidate);
    const installedEntries = installedByName.get(candidate) || [];
    const occupiedByOther = installedEntries.some(
      (installed) => path.resolve(installed.sourcePath) !== path.resolve(expectedTarget),
    );
    if (occupiedByOther) continue;
    return candidate;
  }

  return `${entry.runtimeName}--${shortKeyHash(entry.key)}`;
}

function assignInstallNames(entries, localRoot, installedEntries) {
  const installedByName = groupByRuntimeName(installedEntries);
  const usedNames = new Set();
  return entries.map((entry) => {
    const installName = chooseInstallName(entry, localRoot, installedByName, usedNames);
    usedNames.add(installName);
    return {
      ...entry,
      installName,
      category: inferManagedCategory(entry),
      preferredName: inferPreferredSkillName(entry),
    };
  });
}

function buildManagedOrigin(entry) {
  if (entry.sourceKind === 'bundled') {
    return {
      origin: 'paperclip_required',
      originLabel: 'Bundled with adapter',
      readOnly: false,
    };
  }
  if (entry.required) {
    return {
      origin: 'paperclip_required',
      originLabel: 'Required by Paperclip',
      readOnly: false,
    };
  }
  return {
    origin: 'company_managed',
    originLabel: 'Managed by Paperclip',
    readOnly: false,
  };
}

/**
 * @param {string} content
 */
export function parseSkillDescription(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('description:')) continue;
    return line.slice('description:'.length).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

export async function listHermesSkills(ctx) {
  return buildSkillSnapshot(ctx.config, null);
}

export async function syncHermesSkills(ctx, desiredSkills = []) {
  return buildSkillSnapshot(ctx.config, desiredSkills, true);
}

export function resolveHermesDesiredSkillNames(config, availableEntries, desiredSkills = null) {
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  const desired = resolveRawDesiredSkillNames(config, desiredSkills)
    .map((reference) => canonicalizeDesiredSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desired]));
}

export async function buildSkillSnapshot(config, desiredSkills = null, shouldSync = false) {
  const localRoot = path.join(resolveHermesHome(config), 'skills');
  const installedBefore = await scanHermesHomeSkills(config);
  const availableManagedBase = [
    ...(await scanBundledSkills()),
    ...(await normalizePaperclipRuntimeSkillEntries(config)),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const availableManaged = assignInstallNames(availableManagedBase, localRoot, installedBefore);
  const desired = resolveHermesDesiredSkillNames(config, availableManaged, desiredSkills);
  const desiredSet = new Set(desired);
  const warnings = [];

  if (shouldSync) {
    await ensureDir(localRoot);
    for (const entry of availableManaged) {
      const targetPath = resolveManagedTargetPath(config, entry);
      if (desiredSet.has(entry.key)) {
        if (!(await pathExists(entry.sourcePath))) {
          warnings.push(`Managed skill "${entry.key}" is missing its runtime source at ${entry.sourcePath}.`);
          continue;
        }
        await installManagedSkill(entry.sourcePath, targetPath);
        continue;
      }
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  const installedAfter = await scanHermesHomeSkills(config);
  const installedByPath = new Map(installedAfter.map((entry) => [path.resolve(entry.sourcePath), entry]));
  const installedByName = groupByRuntimeName(installedAfter);
  const managedTargets = new Set();
  const entries = [];

  for (const entry of availableManaged) {
    const targetPath = resolveManagedTargetPath(config, entry);
    const resolvedTargetPath = path.resolve(targetPath);
    const installedEntry = installedByPath.get(resolvedTargetPath) || null;
    const nameConflicts = (installedByName.get(entry.installName) || []).filter(
      (installed) => path.resolve(installed.sourcePath) !== resolvedTargetPath,
    );
    const desiredFlag = desiredSet.has(entry.key);
    const sourceExists = await pathExists(entry.sourcePath);
    managedTargets.add(resolvedTargetPath);

    let state = 'available';
    let managed = false;
    let detail = entry.detail || null;

    if (installedEntry) {
      managed = true;
      state = desiredFlag ? 'installed' : 'stale';
      detail = installedEntry.detail || detail;
    } else if (nameConflicts.length > 0) {
      state = 'external';
      detail = desiredFlag ? MANAGED_EXTERNAL_CONFLICT_DETAIL : MANAGED_EXTERNAL_DETAIL;
      if (desiredFlag) {
        warnings.push(`Managed skill "${entry.key}" is blocked by another Hermes skill named "${entry.installName}".`);
      }
    } else if (!sourceExists && desiredFlag) {
      state = 'missing';
      detail = `Paperclip could not find the runtime skill source at ${entry.sourcePath}.`;
      warnings.push(`Managed skill "${entry.key}" could not be materialized at ${entry.sourcePath}.`);
    } else if (desiredFlag) {
      state = 'missing';
      detail = MANAGED_MISSING_DETAIL;
    }

    entries.push({
      key: entry.key,
      runtimeName: entry.installName,
      desired: desiredFlag,
      managed,
      state,
      sourcePath: entry.sourcePath,
      targetPath,
      detail,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason || null,
      ...buildManagedOrigin(entry),
    });
  }

  for (const installed of installedAfter) {
    const resolvedInstalledPath = path.resolve(installed.sourcePath);
    if (managedTargets.has(resolvedInstalledPath)) continue;
    entries.push({
      key: installed.runtimeName,
      runtimeName: installed.runtimeName,
      desired: false,
      managed: false,
      state: 'installed',
      origin: 'user_installed',
      originLabel: 'Hermes user skill',
      locationLabel: installed.sourcePath,
      readOnly: true,
      sourcePath: installed.sourcePath,
      targetPath: installed.sourcePath,
      detail: installed.detail || null,
    });
  }

  for (const desiredSkill of desired) {
    if (availableManaged.some((entry) => entry.key === desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is unknown.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: false,
      state: 'missing',
      origin: 'external_unknown',
      originLabel: 'Unknown skill',
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: 'Desired skill was not found in bundled Paperclip skills or Hermes home.',
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: 'hermes_local',
    supported: true,
    mode: 'persistent',
    desiredSkills: desired,
    entries,
    warnings,
  };
}

async function installManagedSkill(sourceDir, targetDir) {
  await ensureDir(path.dirname(targetDir));
  await copyDirectory(sourceDir, targetDir);
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else {
      await fs.copyFile(source, target);
    }
  }
}
