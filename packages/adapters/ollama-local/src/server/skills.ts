import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

const ADAPTER_TYPE = "ollama_local";

/**
 * v0.1: skill-bundle injection is not yet implemented. Returning a snapshot with
 * `supported: false, mode: "unsupported"` matches the host's expectation for
 * adapters that don't materialize runtime skills (see
 * `requiresMaterializedRuntimeSkills: false` in the registry entry).
 */
export async function listOllamaSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: ADAPTER_TYPE,
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}

export async function syncOllamaSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return listOllamaSkills(_ctx);
}
