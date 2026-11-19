import fs from "node:fs/promises";
import path from "node:path";

const PROFILE_SKILL_INSTRUCTIONS = `# Loading imported Claude profile skills

Use the descriptions in Claude's available skills to decide whether a skill applies to the task. When an imported personal or plugin skill applies, load it with the native Skill tool before following it. Reading SKILL.md directly is not a substitute: that can skip native skill metadata such as allowed tools or forked context. Do not invoke unrelated skills.

Paperclip-selected runtime skills that are explicitly delivered as files continue to follow Paperclip's runtime instructions.
`;

/** Add guidance only to the managed destination, preserving existing rules. */
export async function ensureManagedProfileSkillInstructions(configDir: string): Promise<void> {
  const rulesDir = path.join(configDir, "rules");
  const stat = await fs.lstat(rulesDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error("Managed Claude profile rules directory must not be a symbolic link");
  await fs.mkdir(rulesDir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(path.join(rulesDir, "paperclip-managed-profile.md"), PROFILE_SKILL_INSTRUCTIONS, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
