import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_LM_STUDIO_BASE_URL } from "../index.js";

export function buildLmStudioLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  ac.baseUrl = v.url || DEFAULT_LM_STUDIO_BASE_URL;
  ac.model = v.model || "";
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  ac.dangerouslyBypassApprovalsAndSandbox = true;
  if (v.command) ac.command = v.command;
  return ac;
}
