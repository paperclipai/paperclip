/**
 * Declarative v1beta1 SandboxClaim, SandboxTemplate, and SandboxWarmPool
 * helpers for kubernetes-sigs/agent-sandbox (`extensions.agents.x-k8s.io/v1beta1`).
 *
 * Key invariants:
 * - Clean zero-credential warm pods: `SandboxTemplate` omits `envFrom` / per-run
 *   Secrets so warm pods hold no user credentials or workspace state.
 * - Mandatory TTL bounds: `SandboxClaim` always sets `spec.lifecycle.shutdownTime`
 *   and `shutdownPolicy: "DeleteForeground"` to prevent leaked sandboxes.
 * - Anti-stale & anti-CrashLoop readiness: `waitForSandboxClaimReady` requires
 *   `status.observedGeneration >= metadata.generation`, `Ready=True`, a non-empty
 *   `status.sandbox.name`, and a secondary Pod `GET` verifying `phase === "Running"`,
 *   no `deletionTimestamp`, and `restartCount === 0`.
 * - Idempotent Foreground deletion: `deleteSandboxClaim` treats HTTP 404 as success.
 */

import type { KubeClients } from "./kube-client.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";

export const SANDBOX_EXTENSIONS_GROUP = "extensions.agents.x-k8s.io";
export const SANDBOX_EXTENSIONS_VERSION = "v1beta1";
export const SANDBOX_EXTENSIONS_API_VERSION =
  `${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_EXTENSIONS_VERSION}` as const;
export const SANDBOX_CLAIMS_PLURAL = "sandboxclaims";
export const SANDBOX_TEMPLATES_PLURAL = "sandboxtemplates";
export const SANDBOX_WARMPOOLS_PLURAL = "sandboxwarmpools";

export const DEFAULT_CLAIM_TTL_SECONDS = 3600;
export const DEFAULT_SHUTDOWN_POLICY = "DeleteForeground" as const;

export class SandboxClaimTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `SandboxClaim ${namespace}/${name} did not become Ready within ${timeoutMs}ms`,
    );
    this.name = "SandboxClaimTimeoutError";
  }
}

export interface BuildSandboxClaimInput {
  namespace: string;
  claimName: string;
  templateName: string;
  runId: string;
  companyId: string;
  /** Mandatory positive-integer TTL in seconds; translated to UTC `shutdownTime`. */
  ttlSeconds?: number;
  /** Optional clock override for deterministic tests. */
  nowMs?: number;
  extraLabels?: Record<string, string>;
}

export function buildSandboxClaimManifest(
  input: BuildSandboxClaimInput,
): Record<string, unknown> {
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`SandboxClaim requires a positive integer ttlSeconds (got ${ttlSeconds})`);
  }
  const now = input.nowMs ?? Date.now();
  const shutdownTime = new Date(now + ttlSeconds * 1000).toISOString();

  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxClaim",
    metadata: {
      name: input.claimName,
      namespace: input.namespace,
      labels: {
        ...(input.extraLabels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
        "paperclip.io/run-id": input.runId,
        "paperclip.io/company-id": input.companyId,
      },
    },
    spec: {
      sandboxTemplateRef: {
        name: input.templateName,
      },
      lifecycle: {
        shutdownTime,
        shutdownPolicy: DEFAULT_SHUTDOWN_POLICY,
      },
    },
  };
}

export interface BuildSandboxTemplateInput {
  namespace: string;
  templateName: string;
  image: string;
  serviceAccountName: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  nodeSelector?: Record<string, string>;
  priorityClassName?: string;
  runtimeClassName?: string;
  imagePullSecrets?: string[];
  workspaceSizeLimit?: string;
  tmpSizeLimit?: string;
  labels?: Record<string, string>;
}

/**
 * Builds a clean zero-credential `SandboxTemplate` (`extensions.agents.x-k8s.io/v1beta1`)
 * aligned with `buildSandboxCrManifest` (container `agent`, UID 1000, `restartPolicy: Always`,
 * Tini sleep-infinity entrypoint, `HOME=/home/paperclip`, PSS `restricted`, and no `envFrom`).
 */
export function buildSandboxTemplateManifest(
  input: BuildSandboxTemplateInput,
): Record<string, unknown> {
  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxTemplate",
    metadata: {
      name: input.templateName,
      namespace: input.namespace,
      labels: {
        ...(input.labels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
      },
    },
    spec: {
      podTemplate: {
        metadata: {
          labels: {
            ...(input.labels ?? {}),
            "paperclip.io/role": "agent",
            "paperclip.io/managed-by": "paperclip-k8s-plugin",
          },
        },
        spec: {
          serviceAccountName: input.serviceAccountName,
          automountServiceAccountToken: false,
          restartPolicy: "Always",
          ...(input.nodeSelector && Object.keys(input.nodeSelector).length > 0
            ? { nodeSelector: { ...input.nodeSelector } }
            : {}),
          ...(input.priorityClassName ? { priorityClassName: input.priorityClassName } : {}),
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/tini", "--", "/bin/sh", "-c", "sleep infinity"],
              env: [{ name: "HOME", value: "/home/paperclip" }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources?.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources?.limits ?? { cpu: "2", memory: "4Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: input.workspaceSizeLimit ?? "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: input.tmpSizeLimit ?? "2Gi" } },
          ],
        },
      },
    },
  };
}

export interface BuildSandboxWarmPoolInput {
  namespace: string;
  poolName: string;
  templateName: string;
  replicas: number;
  labels?: Record<string, string>;
}

export function buildSandboxWarmPoolManifest(
  input: BuildSandboxWarmPoolInput,
): Record<string, unknown> {
  if (!Number.isInteger(input.replicas) || input.replicas < 0) {
    throw new Error(`SandboxWarmPool requires a non-negative integer replicas (got ${input.replicas})`);
  }
  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxWarmPool",
    metadata: {
      name: input.poolName,
      namespace: input.namespace,
      labels: {
        ...(input.labels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
      },
    },
    spec: {
      replicas: input.replicas,
      sandboxTemplateRef: {
        name: input.templateName,
      },
    },
  };
}

export async function createSandboxClaim(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_EXTENSIONS_GROUP,
    version: SANDBOX_EXTENSIONS_VERSION,
    namespace,
    plural: SANDBOX_CLAIMS_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("SandboxClaim created without a UID");
  return { uid };
}

export interface ClaimReadyResult {
  sandboxName: string;
  podName: string;
  claimDurationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAgentRestartCount(pod: {
  status?: { containerStatuses?: Array<{ name?: string; restartCount?: number }> };
}): number {
  const statuses = pod.status?.containerStatuses ?? [];
  const agent = statuses.find((c) => c.name === "agent") ?? statuses[0];
  return typeof agent?.restartCount === "number" ? agent.restartCount : 0;
}

/**
 * Waits for a `SandboxClaim` (`extensions.agents.x-k8s.io/v1beta1`) to bind a
 * sandbox and become Ready:
 * 1. Verifies `status.observedGeneration >= metadata.generation` (no stale status).
 * 2. Requires `Ready=True` condition and non-empty `status.sandbox.name`.
 * 3. Performs a secondary Pod `GET` confirming `phase === "Running"`, no
 *    `deletionTimestamp`, and `restartCount === 0` (defends against CrashLoop
 *    false-ready pods).
 */
export async function waitForSandboxClaimReady(
  clients: KubeClients,
  namespace: string,
  claimName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ClaimReadyResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const claim = (await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_EXTENSIONS_GROUP,
      version: SANDBOX_EXTENSIONS_VERSION,
      namespace,
      plural: SANDBOX_CLAIMS_PLURAL,
      name: claimName,
    })) as {
      metadata?: { generation?: number; deletionTimestamp?: unknown };
      status?: {
        observedGeneration?: number;
        sandbox?: { name?: string };
        conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
      };
    };

    if (claim.metadata?.deletionTimestamp) {
      throw new Error(`SandboxClaim ${namespace}/${claimName} is Terminating`);
    }

    const generation = claim.metadata?.generation ?? 1;
    const status = claim.status ?? {};
    const observedGeneration = status.observedGeneration ?? 0;

    if (observedGeneration >= generation) {
      const conditions = Array.isArray(status.conditions) ? status.conditions : [];
      const failedCond = conditions.find(
        (c) =>
          c.type === "Failed" ||
          (c.type === "Ready" &&
            c.status === "False" &&
            typeof c.reason === "string" &&
            /failed|expired|invalid/i.test(c.reason)),
      );
      if (failedCond?.status === "True" || (failedCond?.type === "Ready" && failedCond.status === "False")) {
        throw new Error(
          `SandboxClaim ${namespace}/${claimName} failed: ${failedCond.reason ?? "unknown"} — ${failedCond.message ?? ""}`,
        );
      }

      const readyCond = conditions.find((c) => c.type === "Ready");
      const sandboxName = status.sandbox?.name?.trim();
      if (readyCond?.status === "True" && sandboxName) {
        const pod = (await clients.core.readNamespacedPod({
          namespace,
          name: sandboxName,
        })) as {
          metadata?: { name?: string; deletionTimestamp?: unknown };
          status?: {
            phase?: string;
            containerStatuses?: Array<{ name?: string; restartCount?: number }>;
          };
        };

        const podPhase = pod.status?.phase;
        const restartCount = getAgentRestartCount(pod);
        if (pod.metadata?.deletionTimestamp) {
          throw new Error(
            `Claimed pod ${namespace}/${sandboxName} is already terminating — refusing lease`,
          );
        }
        if (restartCount > 0) {
          throw new Error(
            `Claimed pod ${namespace}/${sandboxName} has restartCount=${restartCount} (CrashLoop guard)`,
          );
        }
        if (podPhase === "Running") {
          return {
            sandboxName,
            podName: pod.metadata?.name ?? sandboxName,
            claimDurationMs: Date.now() - startedAt,
          };
        }
      }
    }

    await sleep(pollMs);
  }

  throw new SandboxClaimTimeoutError(namespace, claimName, timeoutMs);
}

/**
 * Deletes a `SandboxClaim` with Foreground propagation, treating HTTP 404 as
 * idempotent success.
 */
export async function deleteSandboxClaim(
  clients: KubeClients,
  namespace: string,
  claimName: string,
): Promise<void> {
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: SANDBOX_EXTENSIONS_GROUP,
      version: SANDBOX_EXTENSIONS_VERSION,
      namespace,
      plural: SANDBOX_CLAIMS_PLURAL,
      name: claimName,
      propagationPolicy: "Foreground",
    });
  } catch (err) {
    if (!isKubeNotFoundError(err)) throw err;
  }
}
