import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

export async function createJob(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.batch.createNamespacedJob({ namespace, body: manifest as never });
  const body = (result as { body?: { metadata?: { uid?: string } } }).body;
  const uid = body?.metadata?.uid;
  if (!uid) throw new Error("Job created without a UID");
  return { uid };
}

export type JobStatus = SandboxStatus;

export async function getJobStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<JobStatus> {
  const result = await clients.batch.readNamespacedJobStatus({ namespace, name });
  const body = (result as { body?: Record<string, unknown> }).body ?? {};
  const status = (body.status as Record<string, unknown>) ?? {};
  const active = (status.active as number) ?? 0;
  const succeeded = (status.succeeded as number) ?? 0;
  const failed = (status.failed as number) ?? 0;
  const conditions = (status.conditions as { type: string; status: string; reason?: string; message?: string }[]) ?? [];
  const completed = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
  if (failedCond || failed > 0) {
    return { phase: "Failed", complete: false, active, succeeded, failed, reason: failedCond?.reason, message: failedCond?.message };
  }
  if (completed || succeeded > 0) {
    return { phase: "Succeeded", complete: true, active, succeeded, failed };
  }
  if (active > 0) {
    return { phase: "Running", complete: false, active, succeeded, failed };
  }
  return { phase: "Pending", complete: false, active, succeeded, failed };
}

export async function findPodForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const items = ((result as { body?: { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] } }).body?.items) ?? [];
  const running = items.find((p) => p.status?.phase === "Running");
  return (running ?? items[0])?.metadata?.name ?? null;
}

export async function streamPodLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  const result = await clients.core.readNamespacedPodLog({ namespace, name: podName });
  const text = ((result as { body?: string }).body) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteJob(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.batch.deleteNamespacedJob({
    namespace,
    name,
    body: { propagationPolicy: "Foreground" },
  });
}

export async function waitForJobCompletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") return status;
    await sleep(pollMs);
  }
  throw new Error(`Job ${namespace}/${name} did not complete within ${opts.timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job-backed conformance to SandboxOrchestrator. Plugin.ts imports THIS value
 * (the swap point) — to use a different backend, swap this import for another
 * module exposing a SandboxOrchestrator-shaped default export.
 */
export const jobOrchestrator: SandboxOrchestrator = {
  claim: createJob,
  getStatus: getJobStatus,
  findPod: findPodForJob,
  streamLogs: streamPodLogs,
  release: deleteJob,
  waitForCompletion: waitForJobCompletion,
};
