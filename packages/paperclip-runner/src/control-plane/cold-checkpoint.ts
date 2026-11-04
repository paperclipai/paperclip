import { createHash } from "node:crypto";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import type { RunnerColdCheckpoint } from "./runner-execution-driver.js";

/** Stable object encoding shared with execution providers; source bytes remain immutable. */
export function coldCheckpointStateDigest(state: Record<string, unknown>): string {
  const quoted = (value: string) => JSON.stringify(value).replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  const encode = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "string") return quoted(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(key => `${quoted(key)}:${encode((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    throw new Error("native_runner_cold_checkpoint_state_not_json");
  };
  return `sha256:${createHash("sha256").update(encode(state)).digest("hex")}`;
}

/** A captured ready state is a cold source, never proof that its live owner stopped. */
export function assertColdCheckpointRunnerState(state: Record<string, unknown>, identity: DurableRecoveryIdentity,
  checkpoint: RunnerColdCheckpoint): void {
  if (checkpoint.schema !== "paperclip.runner.cold-checkpoint.v1" ||
      !checkpoint.sourceId || !checkpoint.providerSessionId || !/^sha256:[a-f0-9]{64}$/.test(checkpoint.sha256) ||
      Object.entries(identity).some(([key, value]) => checkpoint.identity[key as keyof DurableRecoveryIdentity] !== value || state[key] !== value) ||
      state.schema !== "paperclip.runner.durable.state.v1" || state.lifecycle !== "ready" ||
      !Array.isArray(state.outbox) || state.outbox.length !== 0 || state.pendingTerminalDelivery != null ||
      state.pendingProviderCleanup != null || state.warmTransition != null ||
      coldCheckpointStateDigest(state) !== checkpoint.runnerStateSha256) {
    throw new Error("native_runner_cold_checkpoint_integrity_mismatch");
  }
}
