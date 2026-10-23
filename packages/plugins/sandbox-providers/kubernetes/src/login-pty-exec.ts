import { Exec, type KubeConfig } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { LoginLeaseScope, LoginPtyConnection, LoginPtyConnector } from "./login-pty.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { sandboxCrOrchestrator } from "./sandbox-cr-orchestrator.js";

/** A persistent Kubernetes WebSocket exec: never end stdin until closing. */
export async function connectKubernetesLoginPty(
  scope: LoginLeaseScope,
  command: string[],
  io: Parameters<LoginPtyConnector>[2],
  kubeConfig?: KubeConfig,
  resolvePod?: (namespace: string, leaseId: string) => Promise<string>,
): Promise<LoginPtyConnection> {
  const kc = kubeConfig ?? createKubeConfig(scope.config);
  // BUGFIX: always wait for the Sandbox CR to reach Ready before execing, even
  // when `scope.podName` is already known. `podName` is recorded right after
  // Sandbox creation (see plugin.ts onEnvironmentAcquireLease), before the pod
  // is necessarily Ready — a pod object can exist (and be resolvable by name)
  // while still Pending/ContainerCreating. Execing against a not-yet-Ready pod
  // fails near-instantly with a non-zero/null exit code, which is exactly the
  // "Setup-token login command ended with a non-zero exit code" failure this
  // fix addresses. Waiting here (not just resolving a name) is required for
  // correctness regardless of whether a podName was already cached.
  if (!scope.leaseId) throw new Error("Kubernetes login PTY requires a lease ID");
  const podName = await (resolvePod ?? (async (namespace, leaseId) => {
    const clients = makeKubeClients(kc);
    await sandboxCrOrchestrator.waitForCompletion(clients, namespace, leaseId, { timeoutMs: 30_000, pollMs: 1_000 });
    const found = await sandboxCrOrchestrator.findPod(clients, namespace, leaseId);
    if (!found) throw new Error("Kubernetes login PTY sandbox pod is unavailable");
    return found;
  }))(scope.namespace, scope.leaseId);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let ended = false;
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    io.exit(code);
  };
  stdout.on("data", (chunk: Buffer) => io.output(chunk));
  stderr.on("data", (chunk: Buffer) => io.output(chunk));
  stdout.on("error", () => finish(null));
  stderr.on("error", () => finish(null));
  stdin.on("error", () => finish(null));
  const exec = new Exec(kc);
  const socket = await exec.exec(
    scope.namespace, podName, "agent", command,
    stdout, stderr, stdin, true,
    (status) => {
      const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
      const parsed = cause?.message ? Number(cause.message) : NaN;
      finish(status.status === "Success" ? 0 : Number.isInteger(parsed) && parsed >= 0 ? parsed : null);
    },
  );
  // The SDK's stdin end handler closes the entire WebSocket. We keep stdin open
  // for delayed browser input and explicitly manage socket closure ourselves.
  stdin.removeAllListeners("end");
  socket.on("close", () => finish(null));
  socket.on("error", () => finish(null));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.close(); } finally { stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  };
  return {
    write(data) {
      if (closed || ended) return;
      // Exec forwards stdin data directly to ws.send(), draining the stream
      // synchronously even when WebSocket frames remain queued.
      if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") + 1 > 256 * 1024) {
        finish(null);
        close();
        return;
      }
      stdin.write(data);
      if (socket.bufferedAmount > 256 * 1024) {
        finish(null);
        close();
      }
    },
    close,
  };
}
