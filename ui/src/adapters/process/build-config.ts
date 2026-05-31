import type { CreateConfigValues } from "../../components/AgentConfigForm";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildProcessConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  ac.timeoutSec = Math.max(0, Number(v.timeoutSec ?? 1800));
  ac.graceSec = Math.max(1, Number(v.graceSec ?? 20));
  if (v.command) ac.command = v.command;
  if (v.args) ac.args = parseCommaArgs(v.args);
  return ac;
}
