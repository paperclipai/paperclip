import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildHermesProfileConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  // v.command holds the profile name (the create form uses the generic `command` field for this)
  if (v.command) ac.profile = v.command;
  if (v.cwd) ac.cwd = v.cwd;
  ac.persistSession = true;
  ac.timeoutSec = 0;
  ac.graceSec = 10;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (v.envVars && typeof v.envVars === "string") {
    const env: Record<string, string> = {};
    for (const line of v.envVars.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
    }
    if (Object.keys(env).length > 0) ac.env = env;
  }
  return ac;
}
