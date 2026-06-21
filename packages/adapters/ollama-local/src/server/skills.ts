// Ollama is a local model adapter and doesn't support skills in the same way as cloud adapters
// These functions are provided for API compatibility but return empty results
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

export async function listOllamaSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: "ollama_local",
    supported: false,
    mode: "ephemeral",
    desiredSkills: [],
    entries: [],
    warnings: ["Ollama does not support runtime skills"],
  };
}

export async function syncOllamaSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: "ollama_local",
    supported: false,
    mode: "ephemeral",
    desiredSkills,
    entries: [],
    warnings: ["Ollama does not support runtime skills"],
  };
}
