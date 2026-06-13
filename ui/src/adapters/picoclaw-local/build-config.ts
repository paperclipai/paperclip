import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildPicoClawConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = { timeoutSec: 300 };
  if (v.command) ac.command = v.command;
  if (v.cwd) ac.cwd = v.cwd;
  if (v.model?.trim()) ac.model = v.model.trim();
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (v.envBindings && Object.keys(v.envBindings).length > 0) {
    ac.env = v.envBindings;
  }
  return ac;
}
