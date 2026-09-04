import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from '@paperclipai/adapter-utils';
import {
  asString,
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from '@paperclipai/adapter-utils/server-utils';

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDevinSkillsHome(config: Record<string, unknown>) {
  return path.join(asString(config.cwd, os.homedir()), '.devin', 'skills');
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
    const desiredSkills = resolveDevinDesiredSkillNames(
      config,
      availableEntries,
    );
    if (desiredSkills.length === 0) return;

    const desiredSet = new Set(desiredSkills);
    const skillsHome = resolveDevinSkillsHome(config);
    await fs.mkdir(skillsHome, { recursive: true });
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
