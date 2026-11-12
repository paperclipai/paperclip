import { createHash } from "node:crypto";

export const POOL_ACCOUNT_DEFAULT_COOLDOWN_MS = 2 * 60 * 60_000;

export interface PoolRunnerScope {
  environmentId: string | null;
}

export function poolRunnerCooldownIdentity(credentialIdentity: string, config: Record<string, unknown>, environmentId: string | null, adapterType = "paperclip_runner"): string {
  const harness = [config.provider, config.provider === "acpx" ? config.acpxAgent : null, ...(adapterType !== "paperclip_runner" ? [adapterType, config.engine ?? "auto"] : [])];
  return `runner:v2:${createHash("sha256").update(JSON.stringify([credentialIdentity, harness, environmentId])).digest("hex")}`;
}
