import type { KubeConfig } from "@kubernetes/client-node";
import type { KubeClients } from "./kube-client.js";
import type { execInPod } from "./pod-exec.js";

export async function assertPodContainerReady(
  clients: KubeClients,
  namespace: string,
  podName: string,
  containerName: string,
): Promise<void> {
  const pod = await clients.core.readNamespacedPod({ namespace, name: podName }) as {
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; status?: string }>;
      containerStatuses?: Array<{
        name?: string;
        ready?: boolean;
        state?: { running?: unknown };
      }>;
    };
  };
  const status = pod.status;
  const podReady = status?.phase === "Running" &&
    status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
  const container = status?.containerStatuses?.find((c) => c.name === containerName);
  if (!podReady || !container?.ready || !container.state?.running) {
    throw new Error(`Refusing Kubernetes exec: pod/container ${namespace}/${podName}/${containerName} is not running, ready, and executable.`);
  }
}

export async function execInReadyPod(
  kc: KubeConfig,
  clients: KubeClients,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  exec: typeof execInPod,
  stdin?: string | Buffer,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await assertPodContainerReady(clients, namespace, podName, containerName);
  return exec(kc, namespace, podName, containerName, command, stdin, timeoutMs);
}
