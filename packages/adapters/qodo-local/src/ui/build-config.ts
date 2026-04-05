import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildQodoLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.model) ac.model = v.model;
  ac.autoApprove = true;
  ac.actMode = true;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) {
    const parsed = v.extraArgs.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) ac.extraArgs = parsed;
  }
  if (v.envVars) {
    const env: Record<string, unknown> = {};
    for (const line of v.envVars.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = { type: "plain", value };
    }
    if (Object.keys(env).length > 0) ac.env = env;
  }
  return ac;
}
