import { execSync } from "node:child_process";

/**
 * Test-only helper that bootstraps metrics-server inside a kind cluster.
 *
 * kind's kubelet uses a self-signed serving cert, so the upstream
 * metrics-server manifest needs to be patched with `--kubelet-insecure-tls`
 * before it can scrape kubelet stats. We apply the upstream manifest, patch
 * the deployment's container args, and poll `kubectl top nodes` until it
 * succeeds (typically 60-120s after the deployment becomes Ready).
 *
 * This is exercised by the empirical-measurement integration test (M2 Task 28
 * — Risk #4 partial resolution); production clusters are expected to have
 * metrics-server (or an equivalent metrics.k8s.io provider) installed by the
 * cluster operator, so the adapter itself does not depend on it.
 */

const METRICS_SERVER_MANIFEST_URL =
  "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml";

export function installMetricsServer(kubeconfigPath: string): void {
  execSync(
    `KUBECONFIG=${kubeconfigPath} kubectl apply -f ${METRICS_SERVER_MANIFEST_URL}`,
    { stdio: "inherit" },
  );

  // Patch the deployment to add `--kubelet-insecure-tls`. The upstream
  // manifest's args are written as a single container; we replace them
  // wholesale via a strategic-merge patch keyed on container name.
  const patch = JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "metrics-server",
              args: [
                "--cert-dir=/tmp",
                "--secure-port=10250",
                "--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname",
                "--kubelet-insecure-tls",
                "--kubelet-use-node-status-port",
                "--metric-resolution=15s",
              ],
            },
          ],
        },
      },
    },
  });

  execSync(
    `KUBECONFIG=${kubeconfigPath} kubectl -n kube-system patch deployment metrics-server --type=strategic --patch='${patch}'`,
    { stdio: "inherit" },
  );
}

export async function waitForMetricsServerReady(
  kubeconfigPath: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // `kubectl top nodes` is a thin wrapper over the metrics.k8s.io API; if
      // it returns a non-empty table the APIService is healthy and the scrape
      // pipeline has produced at least one sample. Suppress stderr (the API
      // returns 503 "metrics not available yet" for the first ~60s).
      const out = execSync(
        `KUBECONFIG=${kubeconfigPath} kubectl top nodes --no-headers 2>/dev/null`,
        { encoding: "utf-8" },
      );
      if (out.trim().length > 0) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("metrics-server did not become ready in time");
}

export interface PodMetricSample {
  name: string;
  cpuMillicores: number;
  memoryMi: number;
}

/**
 * Reads the current pod metrics in a namespace by parsing `kubectl top pod`
 * stdout. We deliberately avoid wiring the metrics.k8s.io client (it would
 * require an extra `@kubernetes/client-node` API constructor and custom URL
 * handling) — the parsing surface here is small and fully under test control.
 *
 * Throws on any execSync failure; callers should guard with try/catch
 * because metrics-server can briefly 503 between scrapes.
 */
export function readPodMetrics(
  namespace: string,
  kubeconfigPath: string,
): PodMetricSample[] {
  const out = execSync(
    `KUBECONFIG=${kubeconfigPath} kubectl top pod -n ${namespace} --no-headers --containers=false`,
    { encoding: "utf-8" },
  );
  const lines = out.trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const cols = line.split(/\s+/).filter(Boolean);
    // Expected layout: NAME  CPU(cores)  MEMORY(bytes)
    const [name, cpu, mem] = cols;
    return {
      name,
      cpuMillicores: parseCpuMillicores(cpu),
      memoryMi: parseMemoryMi(mem),
    };
  });
}

function parseCpuMillicores(value: string | undefined): number {
  if (!value) return 0;
  if (value.endsWith("m")) return parseInt(value.slice(0, -1), 10) || 0;
  // Bare integer means whole cores.
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

function parseMemoryMi(value: string | undefined): number {
  if (!value) return 0;
  if (value.endsWith("Mi")) return parseInt(value.slice(0, -2), 10) || 0;
  if (value.endsWith("Ki")) return Math.round((parseInt(value.slice(0, -2), 10) || 0) / 1024);
  if (value.endsWith("Gi")) return (parseInt(value.slice(0, -2), 10) || 0) * 1024;
  // Bare bytes fallback.
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.round(n / 1024 / 1024) : 0;
}
