import * as k8s from "@kubernetes/client-node";

import { logger } from "../middleware/logger.js";

// Namespace where the claude_k8s / opencode_k8s adapters create their agent
// Job pods. Matches the chart's deploy namespace; an explicit env override
// is supported for unusual deployments.
const PAPERCLIP_K8S_NAMESPACE = process.env.PAPERCLIP_K8S_NAMESPACE ?? "paperclip";
const ENABLE_K8S_JOB_LIVENESS_IN_TESTS =
  process.env.PAPERCLIP_ENABLE_K8S_JOB_LIVENESS_IN_TESTS === "true";
const IS_TEST_ENVIRONMENT = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const K8S_JOB_LIVENESS_TIMEOUT_MS = Number(
  process.env.PAPERCLIP_K8S_JOB_LIVENESS_TIMEOUT_MS ??
    (IS_TEST_ENVIRONMENT ? "100" : "2000"),
);
const K8S_JOB_LIVENESS_TIMEOUT_SECONDS = Math.max(
  1,
  Math.ceil(K8S_JOB_LIVENESS_TIMEOUT_MS / 1000),
);

// Agent Job manifests carry app.kubernetes.io/managed-by=paperclip and a
// paperclip.io/run-id label that maps directly to heartbeat_runs.id. The
// adapters set both unconditionally; see paperclip-adapter-claude-k8s
// job-manifest.ts for the source of truth.
const AGENT_JOB_LABEL_SELECTOR = "app.kubernetes.io/managed-by=paperclip";
const RUN_ID_LABEL = "paperclip.io/run-id";

export type AgentJobRunStatus = {
  phase: "active" | "succeeded" | "failed";
  reason?: string | null;
  message?: string | null;
  // The backing Job's metadata.name. Populated by listAgentJobRunStatuses so
  // callers can persist run→Job navigability onto the heartbeat_run record
  // (heartbeat_runs.external_run_id). classifyAgentJobRunStatus itself does not
  // set it — it only classifies phase.
  name?: string | null;
};

export type AgentJobRunStatusByName =
  | AgentJobRunStatus
  | {
      phase: "missing";
      reason: "NotFound";
      message?: string | null;
      name: string;
    };

type ClientState =
  | { kind: "uninitialized" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; batchApi: k8s.BatchV1Api; coreApi: k8s.CoreV1Api };

let clientState: ClientState = { kind: "uninitialized" };

function requestOptionsWithTimeout() {
  return {
    middlewareMergeStrategy: "append" as const,
    promiseMiddleware: [
      {
        async pre(context: { setSignal(signal: AbortSignal): void }) {
          context.setSignal(AbortSignal.timeout(K8S_JOB_LIVENESS_TIMEOUT_MS));
          return context;
        },
        async post<T>(context: T) {
          return context;
        },
      },
    ],
  };
}

function initClient(): ClientState {
  if (clientState.kind !== "uninitialized") return clientState;
  try {
    const kc = new k8s.KubeConfig();
    if (IS_TEST_ENVIRONMENT && !ENABLE_K8S_JOB_LIVENESS_IN_TESTS) {
      clientState = { kind: "unavailable", reason: "disabled in test environment" };
      return clientState;
    }
    // In-cluster (mounted SA token) is the production path. For local dev
    // we deliberately don't fall back to loadFromDefault — the reaper would
    // otherwise hit the developer's personal kubeconfig and list Jobs in
    // a cluster it has nothing to do with.
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      clientState = { kind: "unavailable", reason: "not running in a kubernetes pod" };
      return clientState;
    }
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    clientState = { kind: "ready", batchApi, coreApi };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ error: reason }, "k8s job-liveness client init failed; falling back to staleness heuristic");
    clientState = { kind: "unavailable", reason };
  }
  return clientState;
}

const RUN_ID_LABEL_FILTER_PREFIX = `${RUN_ID_LABEL}=`;

function conditionIsTrue(condition: k8s.V1JobCondition | undefined) {
  return condition?.status === "True";
}

function readNumericField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : null;
}

function isKubernetesNotFoundError(error: unknown) {
  if (readNumericField(error, "code") === 404 || readNumericField(error, "statusCode") === 404) {
    return true;
  }
  const response = error && typeof error === "object"
    ? (error as Record<string, unknown>).response
    : null;
  return readNumericField(response, "statusCode") === 404 ||
    readNumericField(response, "status") === 404;
}

export function classifyAgentJobRunStatus(job: k8s.V1Job): AgentJobRunStatus {
  const conditions = job.status?.conditions ?? [];
  const failedCondition = conditions.find((condition) => condition.type === "Failed");
  if (conditionIsTrue(failedCondition)) {
    return {
      phase: "failed",
      reason: failedCondition?.reason ?? null,
      message: failedCondition?.message ?? null,
    };
  }

  const completeCondition = conditions.find((condition) => condition.type === "Complete");
  const active = job.status?.active ?? 0;
  const succeeded = job.status?.succeeded ?? 0;
  const expectedCompletions = job.spec?.completions ?? 1;
  if (conditionIsTrue(completeCondition) || (active <= 0 && succeeded >= expectedCompletions)) {
    return {
      phase: "succeeded",
      reason: completeCondition?.reason ?? "Complete",
      message: completeCondition?.message ?? null,
    };
  }

  return { phase: "active", reason: null, message: null };
}

/**
 * Reads one persisted backing Job by name. A successful namespace-wide list can
 * still miss a just-deleted Job, so callers use this exact lookup to
 * distinguish "not in the list yet" from "the recorded Job is actually gone".
 */
export async function readAgentJobRunStatusByName(
  name: string,
): Promise<AgentJobRunStatusByName | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const job = await state.batchApi.readNamespacedJob(
      {
        name: trimmed,
        namespace: PAPERCLIP_K8S_NAMESPACE,
      },
      requestOptionsWithTimeout(),
    );
    return {
      ...classifyAgentJobRunStatus(job),
      name: job.metadata?.name ?? trimmed,
    };
  } catch (error) {
    if (isKubernetesNotFoundError(error)) {
      return {
        phase: "missing",
        reason: "NotFound",
        message: `Kubernetes Job ${trimmed} was not found`,
        name: trimmed,
      };
    }
    logger.warn(
      { jobName: trimmed, error: error instanceof Error ? error.message : String(error) },
      "k8s job-liveness exact Job lookup failed; falling back to staleness heuristic",
    );
    return null;
  }
}

/**
 * Returns the current Kubernetes Job phase by heartbeat run ID for managed
 * external-lifecycle agent Jobs, or null when the kube API cannot be queried.
 */
export async function listAgentJobRunStatuses(): Promise<Map<string, AgentJobRunStatus> | null> {
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const list = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: AGENT_JOB_LABEL_SELECTOR,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    const statuses = new Map<string, AgentJobRunStatus>();
    for (const job of list.items ?? []) {
      const runId = job.metadata?.labels?.[RUN_ID_LABEL];
      if (typeof runId === "string" && runId.length > 0) {
        statuses.set(runId, {
          ...classifyAgentJobRunStatus(job),
          name: job.metadata?.name ?? null,
        });
      }
    }
    return statuses;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "k8s job-liveness status list failed; falling back to staleness heuristic",
    );
    return null;
  }
}

/**
 * Returns the set of heartbeat run IDs that currently have a live Job in the
 * paperclip namespace. Runs whose Job has completed or failed are absent from
 * the set so callers that only understand liveness don't treat terminal Jobs
 * as still running.
 *
 * Returns null when the kube API is unavailable (not in cluster, RBAC missing,
 * transient API error). Callers fall back to the time-based staleness window
 * in that case.
 */
export async function listLiveAgentJobRunIds(): Promise<Set<string> | null> {
  const statuses = await listAgentJobRunStatuses();
  if (statuses === null) return null;
  const runIds = new Set<string>();
  for (const [runId, status] of statuses) {
    if (status.phase === "active") runIds.add(runId);
  }
  return runIds;
}

/**
 * Cascade-delete the Job(s) whose `paperclip.io/run-id` label matches the given
 * run, propagating to the Pod (Background propagation = the Job controller
 * cleans up child Pods asynchronously). Used by the reaper when an
 * external-lifecycle run is being marked `process_lost` so its dispatch lock
 * unwedges; without this the next dispatch precondition check finds the live
 * Job and rejects with "Concurrent run blocked".
 *
 * Returns the number of Jobs deleted, or null when the kube API is unavailable
 * or fails. Caller should treat null as best-effort (the run still gets the
 * status flip; the operator may have to clean the Job by hand).
 */
export async function deleteAgentJobsForRun(runId: string): Promise<number | null> {
  if (!runId) return 0;
  const state = initClient();
  if (state.kind !== "ready") return null;
  try {
    const list = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${RUN_ID_LABEL_FILTER_PREFIX}${runId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    let deleted = 0;
    for (const job of list.items ?? []) {
      const name = job.metadata?.name;
      if (!name) continue;
      try {
        await state.batchApi.deleteNamespacedJob(
          {
            name,
            namespace: PAPERCLIP_K8S_NAMESPACE,
            propagationPolicy: "Background",
          },
          requestOptionsWithTimeout(),
        );
        deleted += 1;
      } catch (error) {
        logger.warn(
          { runId, jobName: name, error: error instanceof Error ? error.message : String(error) },
          "k8s deleteAgentJobsForRun: per-job delete failed",
        );
      }
    }
    return deleted;
  } catch (error) {
    logger.warn(
      { runId, error: error instanceof Error ? error.message : String(error) },
      "k8s deleteAgentJobsForRun: list failed",
    );
    return null;
  }
}

// Verified against production Job pod labels (kubectl get pods -l app.kubernetes.io/managed-by=paperclip)
// and adapter sources at paperclip-adapter-{claude,opencode}-k8s/src/server/job-manifest.ts
// which set "paperclip.io/agent-id" (hyphen) on every agent Job.
const AGENT_ID_LABEL = "paperclip.io/agent-id";

export function isActiveOrTerminatingAgentPod(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return true;
  const phase = pod.status?.phase;
  return phase !== "Succeeded" && phase !== "Failed";
}

/**
 * Returns true when there is at least one active (not yet completed) Job for
 * the given agent in the paperclip namespace. Returns false when the kube API
 * is unavailable (not in cluster, RBAC missing, transient error) so the
 * caller can degrade to DB-only in-flight detection.
 */
export async function hasActiveJobForAgent(agentId: string): Promise<boolean> {
  const state = initClient();
  if (state.kind !== "ready") return false;
  try {
    const res = await state.batchApi.listNamespacedJob(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${AGENT_ID_LABEL}=${agentId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    const items = res.items ?? [];
    const hasActiveJob = items.some((job) => {
      const status = job.status;
      if (!status) return true;
      const active = status.active ?? 0;
      const succeeded = status.succeeded ?? 0;
      const failed = status.failed ?? 0;
      return active > 0 || (succeeded === 0 && failed === 0);
    });
    if (hasActiveJob) {
      return true;
    }

    // A just-deleted Job can already look terminal while its Pod is still
    // terminating and holding a ReadWriteOnce agent PVC on the old node.
    const podRes = await state.coreApi.listNamespacedPod(
      {
        namespace: PAPERCLIP_K8S_NAMESPACE,
        labelSelector: `${AGENT_JOB_LABEL_SELECTOR},${AGENT_ID_LABEL}=${agentId}`,
        timeoutSeconds: K8S_JOB_LIVENESS_TIMEOUT_SECONDS,
      },
      requestOptionsWithTimeout(),
    );
    return (podRes.items ?? []).some(isActiveOrTerminatingAgentPod);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ agentId, error: reason }, "k8s in-flight check failed; falling back to DB-only");
    return false;
  }
}

/** Test-only hook to force re-init (e.g. after env changes). */
export function __resetK8sJobLivenessClient() {
  clientState = { kind: "uninitialized" };
}
