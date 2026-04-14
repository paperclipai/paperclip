import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

/**
 * Ollama does not support Paperclip skills (there is no skills injection
 * mechanism for Ollama models). Return a snapshot with supported: false.
 */

function buildUnsupportedSkillSnapshot(adapterType: string): AdapterSkillSnapshot {
  return {
    adapterType,
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [
      "ollama_local does not support Paperclip skills. Skills are not available for Ollama-based agents.",
    ],
  };
}

export async function listOllamaSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildUnsupportedSkillSnapshot(ctx.adapterType);
}

export async function syncOllamaSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildUnsupportedSkillSnapshot(ctx.adapterType);
}
