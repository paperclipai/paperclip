/**
 * Default-on shared skills (TECH-9129).
 *
 * The shared skills snapshot (shared-skills-source.ts) puts every shared skill in each company's library as
 * `shared/<slug>`. A library entry is not active for an agent until it is in that agent's desired set, so this module
 * decides, per run, which of them to switch on: a shared skill whose required tools the agent can use.
 *
 * The result is a run-scoped overlay. The caller merges the keys into the run's resolved configuration only; nothing is
 * written into the agent's saved skill preferences, so removing a skill from the library or the agent's tool access
 * takes effect on the next run. A skill the company has not imported yet is skipped by the normal run-time selection.
 * Any failure here adds nothing and never fails a run.
 *
 * Limitation: tool access comes from the agent's effective tool profiles. A block or approval policy that denies a tool
 * at call time is not reflected here; the skill is then enabled but its tool call is refused, which is harmless.
 *
 * Opt-out: the agent's saved skill preferences are a positive list with no way to say "never", so there is no per-agent
 * opt-out yet. Turning the feature off for everyone means unsetting the shared skills repository on the server.
 */
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { SHARED_SKILLS_KEY_PREFIX, readSharedSkillsConfig } from "./shared-skills-source.js";
import { toolAccessService } from "./tool-access.js";

export interface SharedSkillDefault {
  /** The skill's directory name in the shared repository, which becomes the `shared/<slug>` library key. */
  slug: string;
  /** Tool names the agent must be able to use, all of them. Empty means no tool is required. */
  requiredTools: readonly string[];
}

/** Add an entry to make another shared skill default-on. Skills not listed here are never switched on automatically. */
export const SHARED_SKILL_DEFAULTS: readonly SharedSkillDefault[] = [
  { slug: "personal-voice-add", requiredTools: ["voice_get_style_guide", "voice_save_style_guide", "voice_add_source_doc"] },
  { slug: "personal-voice-apply", requiredTools: ["voice_get_humanizer_checklist"] },
  { slug: "personal-voice-list", requiredTools: ["voice_list_voices"] },
  { slug: "personal-voice-show", requiredTools: ["voice_get_style_guide"] },
  { slug: "personal-voice-flag-slop", requiredTools: ["voice_add_humanizer_entry"] },
];

/** A tool matches by exact name or by a server prefix joined with an underscore (for example `server_voice_apply`). */
function hasTool(allowed: ReadonlySet<string>, tool: string): boolean {
  if (allowed.has(tool)) return true;
  for (const name of allowed) if (name.endsWith(`_${tool}`)) return true;
  return false;
}

/** Pure selection: the library keys of the default skills whose required tools are all present. */
export function sharedSkillDefaultKeys(
  allowedToolNames: Iterable<string>,
  defaults: readonly SharedSkillDefault[] = SHARED_SKILL_DEFAULTS,
): string[] {
  const allowed = new Set(allowedToolNames);
  return defaults
    .filter((entry) => entry.requiredTools.every((tool) => hasTool(allowed, tool)))
    .map((entry) => `${SHARED_SKILLS_KEY_PREFIX}${entry.slug}`);
}

export interface SharedSkillDefaultDeps {
  isConfigured?: () => boolean;
  allowedToolNames?: (companyId: string, agentId: string) => Promise<readonly string[]>;
}

/** Keys to add to this run's desired skills. Empty when the feature is off, the agent lacks the tools, or the lookup fails. */
export async function resolveSharedSkillDefaultKeys(
  db: Db,
  input: { companyId: string; agentId: string },
  deps: SharedSkillDefaultDeps = {},
): Promise<string[]> {
  try {
    if (!(deps.isConfigured ?? (() => readSharedSkillsConfig() !== null))()) return [];
    const names = deps.allowedToolNames
      ? await deps.allowedToolNames(input.companyId, input.agentId)
      : (await toolAccessService(db).getEffectiveToolAssignmentsForAgent(input.companyId, input.agentId)).allowedToolNames;
    return sharedSkillDefaultKeys(names);
  } catch (error) {
    logger.warn(
      { companyId: input.companyId, agentId: input.agentId, errorClass: error instanceof Error ? error.constructor.name : typeof error },
      "Shared skill defaults skipped: tool access lookup failed",
    );
    return [];
  }
}
