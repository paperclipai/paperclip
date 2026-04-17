import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildBastionclawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.bastionclaw_root = v.url;
  ac.timeout_sec = 1800;
  ac.poll_interval_sec = 5;
  return ac;
}
