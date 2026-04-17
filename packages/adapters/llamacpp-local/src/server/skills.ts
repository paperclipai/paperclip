import { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

export async function listLlamaToolSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  // Unlike Gemini/Claude, local models don't auto-discover skills from filesystem
  // Instead, return available tools from registry
  // These get converted to JSON schemas in buildLlamaToolSchema()

  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);

  return {
    adapterType: "llamacpp_local",
    available: availableEntries,
    installed: [], // All tools are "installed" by being in registry
    // ...
  };
}

// Placeholder - this would need to be implemented based on the actual skill system
async function readPaperclipRuntimeSkillEntries(config: Record<string, unknown>, moduleDir: string) {
  // This is a placeholder implementation
  // In the real system, this would read from the skill registry
  return [];
}