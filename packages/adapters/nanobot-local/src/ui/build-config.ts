import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildNanobotLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  const bindings = v.envBindings as Record<string, unknown> | undefined;
  const apiKey = typeof bindings?.nanobotApiKey === "string" ? bindings.nanobotApiKey : "";
  if (apiKey) ac.apiKey = apiKey;
  const timeout = typeof bindings?.nanobotTimeoutSec === "number" ? bindings.nanobotTimeoutSec : 300;
  ac.timeoutSec = timeout;
  return ac;
}
