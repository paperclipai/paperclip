import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOpenCodeRemoteConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // url is a standard CreateConfigValues field
  if (v.url) ac.url = v.url;

  // directory and providerID come from custom form fields stored in cwd/args
  // The config-fields.tsx component stores these via mark("adapterConfig", ...) in edit mode
  // and via set({...}) in create mode. The builder reads standard fields.
  if (v.model) ac.model = v.model;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  // Operational
  ac.timeoutSec = 0;

  return ac;
}
