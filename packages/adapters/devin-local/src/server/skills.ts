import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from '@paperclipai/adapter-utils';
import {
  asString,
  parseObject,
  buildPersistentSkillSnapshot,
  buildRuntimeMountedSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from '@paperclipai/adapter-utils/server-utils';

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDevinSkillsHome(config: Record<string, unknown>) {
  const cwd = asString(config.cwd, '');
  if (!path.isAbsolute(cwd))
    throw new Error(
      'An absolute working directory is required for persistent Devin skills.',
    );
  return path.join(cwd, '.devin', 'skills');
}

async function buildDevinSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(
    config,
    __moduleDir,
  );
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(
    config,
    availableEntries,
  );
  if (!asString(config.cwd, '')) {
    return buildRuntimeMountedSkillSnapshot({
      adapterType: 'devin_local',
      availableEntries,
      desiredSkills,
      configuredDetail:
        'Configured for the working directory resolved for each run.',
    });
  }
  const skillsHome = resolveDevinSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: 'devin_local',
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: '<cwd>/.devin/skills',
    missingDetail:
      'Configured but not currently linked into the Devin project skills directory.',
    externalConflictDetail:
      'Skill name is occupied by an external installation.',
    externalDetail: 'Installed outside Paperclip management.',
  });
}

export async function listDevinSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildDevinSkillSnapshot(ctx.config);
}

export async function ensureDevinSkillsInjected(
  config: Record<string, unknown>,
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => Promise<void>,
): Promise<void> {
  try {
    const availableEntries = await readPaperclipRuntimeSkillEntries(
      config,
      __moduleDir,
    );
    if (availableEntries.length === 0) return;
    const desiredSkills = resolveDevinDesiredSkillNames(
      config,
      availableEntries,
    );

    const desiredSet = new Set(desiredSkills);
    const skillsHome = resolveDevinSkillsHome(config);
    if (desiredSkills.length > 0) {
      await fs.mkdir(skillsHome, { recursive: true });
    }
    const installed = await readInstalledSkillTargets(skillsHome);
    const availableByRuntimeName = new Map(
      availableEntries.map((entry) => [entry.runtimeName, entry]),
    );

    let changed = 0;

    for (const available of availableEntries) {
      if (!desiredSet.has(available.key)) continue;
      const target = path.join(skillsHome, available.runtimeName);
      try {
        const result = await ensurePaperclipSkillSymlink(available.source, target);
        if (result !== 'skipped') changed += 1;
        else {
          const linkedPath = await fs.readlink(target).catch(() => null);
          if (!linkedPath || path.resolve(path.dirname(target), linkedPath) !== path.resolve(available.source)) {
            await onLog('stderr', `[paperclip] Devin skill "${available.key}" was not linked because its project skill path is occupied by an external installation.\n`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await onLog(
          'stderr',
          `[paperclip] Failed to sync Devin skill "${available.key}" into ${skillsHome}: ${message}\n`,
        );
      }
    }

    for (const [name, installedEntry] of installed.entries()) {
      const available = availableByRuntimeName.get(name);
      if (!available) continue;
      if (desiredSet.has(available.key)) continue;
      if (installedEntry.targetPath !== available.source) continue;
      try {
        await fs.unlink(path.join(skillsHome, name));
        changed += 1;
      } catch {
        // ignore missing/stale unlink races
      }
    }

    if (changed > 0) {
      await onLog(
        'stdout',
        `[paperclip] Synced ${changed} Devin skill(s) into ${skillsHome}\n`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await onLog(
      'stderr',
      `[paperclip] Failed to sync Devin skills: ${message}\n`,
    );
  }
}

export async function syncDevinSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  if (!asString(ctx.config.cwd, '')) {
    return buildDevinSkillSnapshot({
      ...ctx.config,
      paperclipSkillSync: {
        ...parseObject(ctx.config.paperclipSkillSync),
        desiredSkills,
      },
    });
  }
  const availableEntries = await readPaperclipRuntimeSkillEntries(
    ctx.config,
    __moduleDir,
  );
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveDevinSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(
    availableEntries.map((entry) => [entry.runtimeName, entry]),
  );

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

  return buildDevinSkillSnapshot(ctx.config);
}

export function resolveDevinDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
