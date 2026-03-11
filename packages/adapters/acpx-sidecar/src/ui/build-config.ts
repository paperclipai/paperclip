import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildAcpxSidecarConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.command) ac.agentCommand = v.command;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.model) ac.model = v.model;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  ac.timeoutSec = v.timeoutSec ? Number(v.timeoutSec) : 300;
  return ac;
}
