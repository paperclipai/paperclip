import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenCodeRemoteConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.url) ac.url = v.url;
  if (v.directory) ac.directory = v.directory;
  if (v.providerID) ac.providerID = v.providerID;

  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  // Operational — default to no timeout, but allow override
  ac.timeoutSec = v.timeoutSec ?? 0;

  return ac;
}
