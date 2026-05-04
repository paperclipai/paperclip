import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildPicoClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = { timeoutSec: 300 };
  if (v.cwd) ac.cwd = v.cwd;
  return ac;
}
