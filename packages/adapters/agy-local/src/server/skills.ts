import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";

// agy has no documented skills directory, and this adapter never writes into
// the agent's cwd. Skill sync is therefore reported as unsupported.
function unsupportedSnapshot(): AdapterSkillSnapshot {
  return {
    adapterType: "agy_local",
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: ["agy_local does not load Paperclip skills; use instructionsFilePath instead."],
  };
}

export async function listAgySkills(_ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return unsupportedSnapshot();
}

export async function syncAgySkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return unsupportedSnapshot();
}
