import type { heartbeatRuns } from "@paperclipai/db";
import type { NativeRestartRecoveryClaim } from "../native-runtime/native-restart-recovery.js";

/**
 * True when restart recovery is reconnecting this exact run to its retained
 * remote Runner under the claim's own lease owner. Preparation may then reuse
 * what the Runner was admitted with instead of rebuilding it on this server.
 */
export function adoptsLiveRemoteRunner(input: {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "runtimeMode">;
  restartRecovery?: NativeRestartRecoveryClaim;
  leaseOwner?: string;
}): boolean {
  const claim = input.restartRecovery;
  return claim?.kind === "reattach_remote_runner"
    && claim.runId === input.run.id
    && input.leaseOwner !== undefined
    && claim.leaseOwner === input.leaseOwner
    && input.run.runtimeMode === "native";
}
