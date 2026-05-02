import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

// Hermes manages its own skill registry (~/.hermes/skills/).
// Paperclip skill injection is deferred to V2 (see DESIGN.md §7).
const emptySnapshot = (): AdapterSkillSnapshot => ({
  adapterType: "hermes_local",
  supported: true,
  mode: "persistent",
  desiredSkills: [],
  entries: [],
  warnings: [],
});

export async function listSkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return emptySnapshot();
}

export async function syncSkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return emptySnapshot();
}
