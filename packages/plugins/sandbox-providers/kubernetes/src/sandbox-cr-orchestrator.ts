/**
 * SandboxOrchestrator implementation backed by the kubernetes-sigs/agent-sandbox
 * Sandbox CRD (agents.x-k8s.io/v1alpha1).
 *
 * The Sandbox CR creates a long-lived pod that paperclip-server can exec into
 * for multi-command adapter-install workflows — the key architectural win over
 * the batch/v1 Job backend.
 *
 * Key semantic differences from jobOrchestrator:
 * - claim() creates a Sandbox CR via CustomObjectsApi instead of a batch Job
 * - getStatus() maps Sandbox phase (Pending|Ready|Terminating|Failed) to SandboxStatus
 * - findPod() reads status.podName from the Sandbox CR (falls back to label query)
 * - waitForCompletion() means "wait until pod is Ready to exec" NOT "wait until
 *   workload finishes". The Sandbox pod runs sleep infinity; execution completion
 *   is tracked by the individual execInPod() calls.
 * - release() deletes the Sandbox CR with Foreground propagation (controller
 *   tears down the underlying pod).
 *
 * NOTE: streamLogs() is provided for interface conformance but is limited —
 * the sleep-infinity pod has no meaningful stdout. Callers in execute mode
 * should use execInPod() and capture its stdout/stderr directly.
 */

import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

export class SandboxCrTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `Sandbox ${namespace}/${name} did not reach Ready phase within ${timeoutMs}ms`,
    );
    this.name = "SandboxCrTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a Sandbox CR status.phase value to our SandboxStatus shape.
 * Sandbox phases: Pending | Ready | Terminating | Failed
 */
function mapSandboxPhase(
  cr: Record<string, unknown>,
): SandboxStatus {
  const status = (cr.status as Record<string, unknown>) ?? {};
  const phase = (status.phase as string) ?? "Pending";

  switch (phase) {
    case "Ready":
      return {
        phase: "Running", // SandboxStatus.phase uses Job semantics; "Running" = active pod
        complete: false,
        active: 1,
        succeeded: 0,
        failed: 0,
      };
    case "Terminating":
      return {
        phase: "Running",
        complete: false,
        active: 0,
        succeeded: 0,
        failed: 0,
        reason: "Terminating",
      };
    case "Failed": {
      const conditions = (status.conditions as { type?: string; reason?: string; message?: string }[]) ?? [];
      const failedCond = conditions.find((c) => c.type === "Failed");
      return {
        phase: "Failed",
        complete: false,
        active: 0,
        succeeded: 0,
        failed: 1,
        reason: failedCond?.reason,
        message: failedCond?.message,
      };
    }
    default:
      // "Pending" or unknown
      return {
        phase: "Pending",
        complete: false,
        active: 0,
        succeeded: 0,
        failed: 0,
      };
  }
}

export async function createSandboxCr(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("Sandbox CR created without a UID");
  return { uid };
}

export async function getSandboxCrStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<SandboxStatus> {
  const result = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  });
  return mapSandboxPhase(result as Record<string, unknown>);
}

/**
 * Returns the pod name backing a Sandbox CR.
 * Primary: read status.podName from the CR (set by the controller once ready).
 * Fallback: list pods in the namespace filtered by the paperclip.io/managed-by
 * label and the sandbox name label set on the pod template.
 */
export async function findPodForSandbox(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<string | null> {
  // Primary: read status.podName from the Sandbox CR
  const cr = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  }) as Record<string, unknown>;

  const status = (cr.status as Record<string, unknown>) ?? {};
  const podName = status.podName as string | undefined;
  if (podName && podName.trim().length > 0) {
    return podName;
  }

  // Fallback: list pods by the controller's sandbox-name label, which uniquely
  // identifies the pod for THIS sandbox. A broader managed-by selector plus
  // name-prefix narrowing could match a concurrent sandbox whose generated
  // name shares a prefix, and exec would target the wrong lease's pod.
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `agents.x-k8s.io/sandbox-name=${name}`,
  });
  const items =
    (
      (
        result as {
          items?: {
            metadata?: { name?: string; labels?: Record<string, string> };
            status?: { phase?: string };
          }[];
        }
      ).items
    ) ?? [];

  // The label selector already scopes to exactly this sandbox's pod(s); keep a
  // defensive re-check on the label value only (no name-prefix matching).
  const matching = items.filter(
    (p) => (p.metadata?.labels ?? {})["agents.x-k8s.io/sandbox-name"] === name,
  );

  const running = matching.find((p) => p.status?.phase === "Running");
  return (running ?? matching[0])?.metadata?.name ?? null;
}

export async function streamSandboxLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout. The
  // sleep-infinity pod will have minimal output; this is provided for interface
  // conformance. For actual command output, use execInPod() directly.
  const result = await clients.core.readNamespacedPodLog({
    namespace,
    name: podName,
  });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteSandboxCr(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.custom.deleteNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
    propagationPolicy: "Foreground",
  });
}

/**
 * Wait until the Sandbox CR's pod reaches Ready phase (i.e., the pod is up and
 * exec-able). This is NOT waiting for a workload to finish — the Sandbox pod
 * runs sleep infinity indefinitely. Execution completion is tracked by the
 * individual execInPod() calls.
 *
 * Throws SandboxCrTimeoutError if Ready is not reached within timeoutMs.
 * Throws if the Sandbox transitions to Failed.
 */
export async function waitForSandboxReady(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = {
    timeoutMs: 120_000,
    pollMs: 2000,
  },
): Promise<SandboxStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;

  while (Date.now() < deadline) {
    const cr = await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace,
      plural: SANDBOX_PLURAL,
      name,
    }) as Record<string, unknown>;

    const status = (cr.status as Record<string, unknown>) ?? {};
    // agent-sandbox v1alpha1 uses status.conditions[type=Ready,status=True],
    // not status.phase. Fall back to phase for forward-compat.
    const conditions = Array.isArray(status.conditions) ? status.conditions as Array<Record<string, unknown>> : [];
    const readyCondition = conditions.find((c) => c.type === "Ready");
    const failedCondition = conditions.find((c) => c.type === "Failed" || (c.type === "Ready" && c.status === "False" && typeof c.reason === "string" && /failed/i.test(c.reason)));
    const phase = (status.phase as string) ?? "";

    if (readyCondition?.status === "True" || phase === "Ready") {
      return mapSandboxPhase(cr);
    }
    if (failedCondition?.status === "True" || phase === "Failed") {
      const mapped = mapSandboxPhase(cr);
      throw new Error(
        `Sandbox ${namespace}/${name} failed: ${mapped.reason ?? (failedCondition?.reason as string) ?? "unknown reason"} — ${mapped.message ?? (failedCondition?.message as string) ?? ""}`,
      );
    }
    if (phase === "Terminating") {
      // A Sandbox being torn down will never transition to Ready. Polling
      // until the deadline would burn the full timeoutMs (potentially
      // 30+ minutes) before throwing a generic timeout. Fail fast instead
      // so the caller can surface a clear "the lease is being released"
      // error and decide whether to retry against a fresh Sandbox.
      throw new Error(
        `Sandbox ${namespace}/${name} is Terminating — cannot wait for Ready`,
      );
    }
    // Pending — keep polling
    await sleep(pollMs);
  }

  throw new SandboxCrTimeoutError(namespace, name, opts.timeoutMs);
}

/**
 * Sandbox CR-backed conformance to SandboxOrchestrator.
 *
 * waitForCompletion semantics change: for this backend, "completion" means
 * "pod is up and Ready to exec into" — NOT "workload finished". The actual
 * command execution and its completion is handled by execInPod().
 */
export const sandboxCrOrchestrator: SandboxOrchestrator = {
  claim: createSandboxCr,
  getStatus: getSandboxCrStatus,
  findPod: findPodForSandbox,
  streamLogs: streamSandboxLogs,
  release: deleteSandboxCr,
  waitForCompletion: waitForSandboxReady,
};
