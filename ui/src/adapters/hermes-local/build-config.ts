import type { CreateConfigValues } from "@paperclipai/adapter-utils";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
/** 0 = unlimited Hermes run duration at the Paperclip process layer (user can set a positive cap in agent settings). */
const DEFAULT_TIMEOUT_SEC = 0;

export function buildHermesConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  ac.model = v.model || DEFAULT_MODEL;
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  ac.persistSession = true;

  if (v.cwd) ac.cwd = v.cwd;
  if (v.command) ac.hermesCommand = v.command;
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);
  }
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;

  return ac;
}
