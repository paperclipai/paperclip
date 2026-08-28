import type { KubeClients } from "./kube-client.js";

export interface SandboxStatus {
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  complete: boolean;
  active: number;
  succeeded: number;
  failed: number;
  reason?: string;
  message?: string;
}

/**
 * Abstract interface over a sandbox runtime backend. The current implementation
 * is Job-backed (job-orchestrator.ts). Future backends slot in by exporting an
 * object conforming to this shape — e.g. a Kata-FC warm-pool backend that
 * additionally implements the optional pause/resume slots, or a CRD-backed
 * backend on kubernetes-sigs/agent-sandbox once it reaches Beta.
 */
export interface SandboxOrchestrator {
  /** Provision the sandbox. Returns the runtime's stable UID. */
  claim(
    clients: KubeClients,
    namespace: string,
    manifest: Record<string, unknown>,
  ): Promise<{ uid: string }>;

  /** Read current lifecycle phase. */
  getStatus(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<SandboxStatus>;

  /** Locate the pod backing this sandbox (or null if none exists yet). */
  findPod(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<string | null>;

  /** Read logs from the sandbox's pod. V1: post-completion read. */
  streamLogs(
    clients: KubeClients,
    namespace: string,
    podName: string,
    onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
  ): Promise<void>;

  /** Tear down the sandbox. Implementations MUST cascade-delete child resources. */
  release(clients: KubeClients, namespace: string, name: string): Promise<void>;

  /** Block until phase is Succeeded or Failed, or throw on timeout. */
  waitForCompletion(
    clients: KubeClients,
    namespace: string,
    name: string,
    opts: { timeoutMs: number; pollMs?: number },
  ): Promise<SandboxStatus>;

  // Optional warm-pool / Kata-FC extension slots. Job-backed implementation
  // does not provide these; runtimes that do (e.g. Kata-FC microVM pause)
  // implement them and acquire the warm-pool capability.
  // TODO: requires custom in-cluster controller for k8s — kubelet does not
  // expose pause/resume at the pod level. Add when warm-pool design lands.
  pause?(clients: KubeClients, namespace: string, name: string): Promise<void>;
  resume?(clients: KubeClients, namespace: string, name: string): Promise<void>;
}
