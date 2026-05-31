import os from "node:os";
import path from "node:path";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveHermesHome(configEnv: Record<string, unknown>, companyId?: string): string {
  // 1. Check explicit override in adapter config
  const configuredHome = asString(configEnv.HOME) || asString(configEnv.HERMES_HOME);
  if (configuredHome) return path.resolve(configuredHome);

  // 2. Fall back to Paperclip managed isolation
  const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
  const inWorktree = TRUTHY_ENV_RE.test(process.env.PAPERCLIP_IN_WORKTREE ?? "");
  const paperclipHome = asString(process.env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = asString(process.env.PAPERCLIP_INSTANCE_ID) ?? "default";
  
  if (companyId) {
    return path.resolve(paperclipHome, "instances", instanceId, "companies", companyId, "hermes-home");
  }
  return path.resolve(paperclipHome, "instances", instanceId, "hermes-home");
}
