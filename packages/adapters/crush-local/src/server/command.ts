import os from "node:os";
import path from "node:path";
import { asStringArray } from "@paperclipai/adapter-utils/server-utils";

export function crushDataDir(companyId: string, agentId: string): string {
  return path.join(os.homedir(), ".paperclip", "crush", companyId, agentId);
}

export function crushSkillsDir(companyId: string, agentId: string): string {
  return path.join(crushDataDir(companyId, agentId), "skills");
}

export function crushExtraArgs(config: Record<string, unknown>): string[] {
  const extraArgs = asStringArray(config.extraArgs);
  return extraArgs.length > 0 ? extraArgs : asStringArray(config.args);
}

export function crushRunArgs(input: {
  cwd: string;
  dataDir: string;
  model: string;
  extraArgs: string[];
  sessionId?: string | null;
  prompt: string;
}): string[] {
  const args = ["run", "--quiet", "--cwd", input.cwd, "--data-dir", input.dataDir];
  if (input.sessionId) args.push("--session", input.sessionId);
  if (input.model) args.push("--model", input.model);
  args.push(...input.extraArgs, input.prompt);
  return args;
}
