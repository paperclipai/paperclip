import { createHash } from "node:crypto";

export interface PoolRunnerScope {
  environmentId: string | null;
}

export function poolRunnerCooldownIdentity(credentialIdentity: string, config: Record<string, unknown>, environmentId: string | null): string {
  const harness = [config.provider, config.provider === "acpx" ? config.acpxAgent : null];
  return `runner:v2:${createHash("sha256").update(JSON.stringify([credentialIdentity, harness, environmentId])).digest("hex")}`;
}
