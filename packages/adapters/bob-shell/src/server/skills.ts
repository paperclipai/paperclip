import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";

/**
 * Resolves which skills should be materialized for Bob Shell
 * Follows the same logic as Claude adapter
 */
export function resolveBobShellDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

/**
 * Lists available skills for Bob Shell
 * Bob Shell uses ephemeral mode - skills are materialized into .bob/rules-{mode}/ on each run
 */
export async function listBobShellSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: "bob_shell",
    supported: true,
    mode: "ephemeral",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}

/**
 * Syncs skills for Bob Shell
 * Bob Shell uses ephemeral mode - skills are materialized into .bob/rules-{mode}/ on each run
 * No persistent sync needed
 */
export async function syncBobShellSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return listBobShellSkills(ctx);
}