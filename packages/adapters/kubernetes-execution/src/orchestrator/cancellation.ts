import type { KubernetesApiClient } from "../types.js";

/**
 * Cancels a Job by deleting it with foreground propagation. Foreground
 * propagation guarantees that pods owned by the Job are torn down before
 * the Job object itself disappears, so finalizers and per-Job ephemeral
 * Secrets (which carry an OwnerReference back to the Job) get GC'd
 * deterministically.
 *
 * Default grace period is 30 seconds — enough time for the agent shim to
 * flush its final stdout/event payload before SIGKILL.
 */
export interface CancelJobInput {
  client: KubernetesApiClient;
  namespace: string;
  jobName: string;
  graceSeconds?: number;
}

export async function cancelJob(input: CancelJobInput): Promise<void> {
  const grace = input.graceSeconds ?? 30;
  await input.client.batch.deleteNamespacedJob(
    input.jobName,
    input.namespace,
    undefined, // pretty
    undefined, // dryRun
    grace, // gracePeriodSeconds
    undefined, // orphanDependents
    "Foreground", // propagationPolicy
  );
}
