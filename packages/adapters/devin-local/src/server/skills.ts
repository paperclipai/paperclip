import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from '@paperclipai/adapter-utils';
import {
  parseObject,
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from '@paperclipai/adapter-utils/server-utils';

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveDevinDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}

// Run-scoped staging (skill-leases.ts) owns the filesystem; list/sync only
// report and update the desired set held in config.
async function buildDevinSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(
    config,
    __moduleDir,
  );
  const desiredSkills = resolveDevinDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: 'devin_local',
    availableEntries,
    desiredSkills,
    configuredDetail:
      'Linked into the run working directory at run start and removed when the run ends.',
  });
}

export async function listDevinSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildDevinSkillSnapshot(ctx.config);
}

export async function syncDevinSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildDevinSkillSnapshot({
    ...ctx.config,
    paperclipSkillSync: {
      ...parseObject(ctx.config.paperclipSkillSync),
      desiredSkills,
    },
  });
}
