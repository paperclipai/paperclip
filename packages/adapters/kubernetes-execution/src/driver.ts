import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterKubernetesExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { ensureTenantNamespace, type EnsureTenantInput } from "./orchestrator/ensure-tenant.js";
import { createKubernetesApiClient } from "./client.js";
import { deriveNamespaceName } from "./orchestrator/naming.js";
import { buildAgentWorkspacePvc, applyAgentWorkspacePvc } from "./orchestrator/pvc.js";
import {
  buildEphemeralSecret, applyEphemeralSecret, deleteEphemeralSecret,
  patchEphemeralSecretOwnerReference,
} from "./orchestrator/secret.js";
import { buildAgentJob, createAgentJob } from "./orchestrator/job.js";
import { startLogStream } from "./orchestrator/log-stream.js";
import { startEventWatch } from "./orchestrator/event-watch.js";
import { cancelJob } from "./orchestrator/cancellation.js";
import { mapTerminalState } from "./orchestrator/failure-mapping.js";
import { newRunUlidDns } from "./orchestrator/run-id.js";
import { PAPERCLIP_RUN_ID } from "./orchestrator/labels.js";
import { createRedactor, noopRedactor, type Redactor } from "./redaction.js";
import type { BootstrapTokenMinter } from "./bootstrap/token.js";
import type { KubernetesApiClient, ResolvedClusterConnection } from "./types.js";

export interface KubernetesDriverDeps {
  resolveConnection: (id: string) => Promise<ResolvedClusterConnection | null>;
  /**
   * Mints a single-use bootstrap token bound to (agentId, companyId, runId).
   * The driver injects the resulting token value into the per-Job Secret so
   * the agent shim can exchange it for a run-scoped JWT inside the pod.
   *
   * In M1 this is allowed to be omitted; run() will return an
   * `execution_target_not_yet_supported` error in that case so server tests
   * keep working without DB plumbing.
   */
  bootstrapTokenMinter?: BootstrapTokenMinter;
  /**
   * Resolves the runtime context the driver needs to call ensureTenant
   * (companySlug, controlPlane topology, adapterAllowFqdns, image
   * pull secret JSON, optional tenantPolicy). Server-side wiring fills this
   * in; M1 callers that only test ensureTenant can pass through
   * `ensureTenant()` directly with the older `clusterConnectionId` shape.
   *
   * Optional in M1 — when omitted, `run()` falls back to a stub error.
   */
  resolveRunContext?: (input: ResolveRunContextInput) => Promise<ResolvedRunContext | null>;
  /** Wall-clock for tests. Defaults to Date.now / new Date(). */
  now?: () => Date;
  /**
   * Override the polling interval in ms. Defaults to 1000ms. Tests inject
   * smaller values to keep run-loop tests fast.
   */
  pollIntervalMs?: number;
}

export interface ResolveRunContextInput {
  agent: AdapterExecutionContext["agent"];
  target: AdapterKubernetesExecutionTarget;
  connection: ResolvedClusterConnection;
}

export interface ResolvedRunContext {
  /** Sanitized company slug for namespace + label derivation. */
  companySlug: string;
  /** Resolved namespace; defaults to deriveNamespaceName(...) when omitted. */
  namespaceOverride?: string | null;
  /** Image to run for the main agent container. */
  image: string;
  /** Init container image (always agent-runtime-base). */
  initImage: string;
  /** Optional list of imagePullSecret names to attach to the pod. */
  imagePullSecrets?: string[];
  /** Hard ceiling for the run; defaults to 1800s. */
  activeDeadlineSeconds?: number;
  /** Job TTL after completion; defaults to 300s. */
  ttlSecondsAfterFinished?: number;
  /** Workspace strategy serialized as JSON for the init container. */
  workspaceStrategyJson: string;
  /** Trace context propagated into the pod. */
  traceparent?: string;
  /** Public URL of the Paperclip control plane (where the shim exchanges its bootstrap token). */
  paperclipPublicUrl: string;
  /** Adapter-supplied env that the shim should expose via the env Secret. */
  adapterEnv?: Record<string, string>;
  /** PVC sizeGi override; defaults to 10. */
  storageSizeGi?: number;
  /** Storage class override; defaults to connection.capabilities.storageClass. */
  storageClassName?: string;
  /** Strategy key tag for the PVC annotation. Free-form. */
  workspaceStrategyKey: string;
  /** Emit Job podFailurePolicy only for clusters known to support it. */
  enablePodFailurePolicy?: boolean;
}

export type EnsureTenantDriverInput = Omit<EnsureTenantInput, "connection"> & {
  clusterConnectionId: string;
};

export interface KubernetesExecutionDriver {
  type: "kubernetes";
  validateTarget(target: unknown): Promise<void>;
  ensureTenant(input: EnsureTenantDriverInput): Promise<{ namespace: string; ciliumApplied: boolean }>;
  run(input: {
    ctx: AdapterExecutionContext;
    target: AdapterKubernetesExecutionTarget;
  }): Promise<AdapterExecutionResult>;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ACTIVE_DEADLINE_SECONDS = 1800;
const DEFAULT_TTL_SECONDS_AFTER_FINISHED = 300;
const DEFAULT_BOOTSTRAP_TTL_SECONDS = 600;
const RUNTIME_COMMAND_SECRET_KEY = "PAPERCLIP_RUNTIME_COMMAND_JSON";

/**
 * Derive a DNS-1123-friendly agent slug from the agent UUID. Used in PVC,
 * Job, and Secret names. We pick the first 8 chars of the UUID's leading
 * hex segment, lowercased, to keep names short while still readable across
 * a tenant's k8s namespace.
 */
function deriveAgentSlug(agentId: string): string {
  const cleaned = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.slice(0, 8) || "agent";
}

function isJobTerminal(job: V1Job): { done: true; succeeded: boolean } | { done: false } {
  if ((job.status?.succeeded ?? 0) >= 1) return { done: true, succeeded: true };
  if ((job.status?.failed ?? 0) >= 1) return { done: true, succeeded: false };
  for (const cond of job.status?.conditions ?? []) {
    if (cond.status === "True" && (cond.type === "Complete" || cond.type === "Failed")) {
      return { done: true, succeeded: cond.type === "Complete" };
    }
  }
  return { done: false };
}

async function readPodForRun(
  client: KubernetesApiClient,
  namespace: string,
  runId: string,
): Promise<V1Pod | undefined> {
  const labelSelector = `${PAPERCLIP_RUN_ID}=${runId}`;
  const list = await client.core.listNamespacedPod(
    namespace,
    undefined, undefined, undefined, undefined,
    labelSelector,
  );
  return list.body.items[0];
}

async function waitMs(ms: number, abort?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      abort?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    abort?.addEventListener("abort", onAbort, { once: true });
  });
}

async function safeStop<T extends { abort: () => void; done: Promise<void> } | null | undefined>(handle: T): Promise<void> {
  if (!handle) return;
  handle.abort();
  try {
    await handle.done;
  } catch {
    /* swallow — abort is best-effort */
  }
}

interface RunCancellation {
  signal: AbortSignal;
  dispose(): void;
}

function buildRunCancellation(ctx: AdapterExecutionContext): RunCancellation {
  // AdapterExecutionContext does not (yet) expose an AbortSignal, but the
  // surrounding heartbeat dispatch may register a `paperclipCancel` callback
  // on `ctx.context`. Until that lands we expose an AbortController so callers
  // can wire it up; the production path will populate this from heartbeat
  // cancellation hooks once the contract is updated.
  const ctlr = new AbortController();
  const ctxAny = ctx.context as Record<string, unknown> | undefined;
  const externalSignal = (ctxAny?.paperclipCancellationSignal as AbortSignal | undefined) ?? null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctlr.abort();
    } else {
      const onAbort = () => ctlr.abort();
      externalSignal.addEventListener("abort", onAbort, { once: true });
      return {
        signal: ctlr.signal,
        dispose: () => externalSignal.removeEventListener("abort", onAbort),
      };
    }
  }
  return {
    signal: ctlr.signal,
    dispose: () => { /* noop */ },
  };
}

export function createKubernetesExecutionDriver(deps: KubernetesDriverDeps): KubernetesExecutionDriver {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return {
    type: "kubernetes",

    async validateTarget(target) {
      const t = target as { kind?: string; clusterConnectionId?: string };
      if (t.kind !== "kubernetes") {
        throw new Error(
          `KubernetesExecutionDriver received target with kind=${t.kind ?? "(none)"}, expected "kubernetes"`,
        );
      }
      if (!t.clusterConnectionId) {
        throw new Error(`KubernetesExecutionDriver target is missing clusterConnectionId`);
      }
      const connection = await deps.resolveConnection(t.clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${t.clusterConnectionId} not found`);
      }
    },

    async ensureTenant({ clusterConnectionId, ...rest }) {
      const connection = await deps.resolveConnection(clusterConnectionId);
      if (!connection) {
        throw new Error(`Cluster connection ${clusterConnectionId} not found`);
      }
      const client = createKubernetesApiClient(connection);
      return ensureTenantNamespace(client, { connection, ...rest });
    },

    async run(input) {
      const { ctx, target } = input;

      // ---- M1 fallback paths ---------------------------------------------------
      // run() can only complete when both the bootstrap token minter and the
      // run-context resolver are wired (server boots both at startup). In any
      // other configuration we keep the M1 NOT_YET_SUPPORTED contract so that
      // callers without DB/server plumbing get a structured rejection instead
      // of a crash.
      if (!deps.bootstrapTokenMinter || !deps.resolveRunContext) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "execution_target_not_yet_supported",
          errorMessage:
            "Kubernetes agent execution requires the server-side bootstrap token minter " +
            "and run-context resolver to be wired into the driver registry.",
        };
      }

      const connection = await deps.resolveConnection(target.clusterConnectionId);
      if (!connection) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "execution_target_not_yet_supported",
          errorMessage: `Cluster connection ${target.clusterConnectionId} not found`,
        };
      }
      const client = createKubernetesApiClient(connection);

      const runContext = await deps.resolveRunContext({
        agent: ctx.agent,
        target,
        connection,
      });
      if (!runContext) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "execution_target_not_yet_supported",
          errorMessage: "Driver run-context resolver returned no context for this run",
        };
      }
      if (!ctx.runtimeCommandSpec?.command) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "execution_target_not_yet_supported",
          errorMessage: "Kubernetes execution requires an adapter runtime command spec",
        };
      }

      const namespace = (target.namespaceOverride ?? runContext.namespaceOverride ?? null)?.trim()
        || deriveNamespaceName({
          companySlug: runContext.companySlug,
          companyId: ctx.agent.companyId,
          prefix: connection.defaultNamespacePrefix,
        });

      const agentSlug = deriveAgentSlug(ctx.agent.id);
      const runUlid = newRunUlidDns(deps.now ? () => deps.now!().getTime() : undefined);
      const runId = ctx.runId;

      const cancellation = buildRunCancellation(ctx);
      const { signal: cancelSignal } = cancellation;

      // 1. PVC (idempotent — reused across runs for the same agent).
      const pvc = buildAgentWorkspacePvc({
        namespace,
        agentId: ctx.agent.id,
        agentSlug,
        companyId: ctx.agent.companyId,
        companySlug: runContext.companySlug,
        storageClass: runContext.storageClassName ?? connection.capabilities.storageClass,
        sizeGi: runContext.storageSizeGi,
        strategyKey: runContext.workspaceStrategyKey,
      });
      await applyAgentWorkspacePvc(client, pvc);

      // 2. Mint bootstrap token (V1: jobUid="" — see Risk #5 deferred to V2).
      const minted = await deps.bootstrapTokenMinter.mint({
        agentId: ctx.agent.id,
        companyId: ctx.agent.companyId,
        runId,
        jobUid: "",
        ttlSeconds: DEFAULT_BOOTSTRAP_TTL_SECONDS,
      });

      // 3. Materialize per-Job ephemeral Secret. We create it WITHOUT an
      //    OwnerReference first because the Job UID isn't known yet, then
      //    PATCH it after the Job is created (two-phase commit). This avoids
      //    a race where the pod starts before the Secret exists.
      const secretName = `agent-${agentSlug}-run-${runUlid}-env`;
      const adapterEnv = { ...(runContext.adapterEnv ?? {}) };
      const secretData: Record<string, string> = {
        ...adapterEnv,
        BOOTSTRAP_TOKEN: minted.token,
        [RUNTIME_COMMAND_SECRET_KEY]: JSON.stringify({
          command: ctx.runtimeCommandSpec.command,
          args: [],
          ...(ctx.runtimeCommandSpec.detectCommand ? { detectCommand: ctx.runtimeCommandSpec.detectCommand } : {}),
          ...(ctx.runtimeCommandSpec.installCommand ? { installCommand: ctx.runtimeCommandSpec.installCommand } : {}),
        }),
      };

      const redactor: Redactor =
        Object.values(secretData).length > 0
          ? createRedactor(Object.values(secretData))
          : noopRedactor;

      // Build a placeholder Secret with no owner reference for the initial
      // create; we'll patch the OwnerReference after the Job is created.
      const placeholderSecret = buildEphemeralSecret({
        namespace,
        agentSlug,
        runUlid,
        companyId: ctx.agent.companyId,
        companySlug: runContext.companySlug,
        runId,
        data: secretData,
        ownerJob: { name: `agent-${agentSlug}-run-${runUlid}`, uid: "00000000-0000-0000-0000-000000000000" },
      });
      // Strip placeholder ownerReferences — they can't reference a Job that doesn't exist yet.
      placeholderSecret.metadata!.ownerReferences = undefined;

      try {
        await applyEphemeralSecret(client, placeholderSecret);
      } catch (err) {
        cancellation.dispose();
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "agent_exit_nonzero",
          errorMessage: `Failed to create per-Job Secret: ${(err as Error).message}`,
        };
      }

      let jobName = `agent-${agentSlug}-run-${runUlid}`;
      let jobUid = "";
      // Tracks whether the Secret has an OwnerReference back to the Job. When
      // false at the end of the run, the finally block below explicitly
      // deletes the Secret because Kubernetes GC won't touch it.
      let ownerRefPatched = false;

      try {
        // 4. Create the Job referencing the Secret.
        const job = buildAgentJob({
          namespace,
          agentId: ctx.agent.id,
          agentSlug,
          runId,
          runUlid,
          companyId: ctx.agent.companyId,
          companySlug: runContext.companySlug,
          adapterType: ctx.agent.adapterType ?? "unknown",
          image: runContext.image,
          initImage: runContext.initImage,
          imagePullSecrets: runContext.imagePullSecrets,
          pvcName: pvc.metadata!.name!,
          envSecretName: secretName,
          resources: target.resources ?? undefined,
          activeDeadlineSeconds: runContext.activeDeadlineSeconds ?? DEFAULT_ACTIVE_DEADLINE_SECONDS,
          ttlSecondsAfterFinished: runContext.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS_AFTER_FINISHED,
          workspaceStrategyJson: runContext.workspaceStrategyJson,
          runtimeCommandSecretKey: RUNTIME_COMMAND_SECRET_KEY,
          paperclipPublicUrl: runContext.paperclipPublicUrl,
          traceparent: runContext.traceparent,
          enablePodFailurePolicy: runContext.enablePodFailurePolicy,
        });

        const created = await createAgentJob(client, job);
        jobName = created.name;
        jobUid = created.uid;

        // 5. Patch the Secret with the now-known Job UID so it gets GC'd
        //    automatically when the Job is deleted. Without the OwnerReference,
        //    TTLSecondsAfterFinished only deletes the Job — the Secret would
        //    persist indefinitely on long-lived clusters, accumulating spent
        //    bootstrap tokens. Retry transient failures with exponential
        //    backoff before falling back to a deferred delete in the finally
        //    block below.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await patchEphemeralSecretOwnerReference(client, namespace, secretName, {
              name: jobName,
              uid: jobUid,
            });
            ownerRefPatched = true;
            break;
          } catch (patchErr) {
            if (attempt === 2) {
              // Final attempt failed — log structured error so operators see
              // the leak path even if the cleanup below fails too.
              // eslint-disable-next-line no-console
              console.error("[k8s-execution] OwnerRef patch failed after 3 attempts; will delete Secret on cleanup", {
                namespace, secretName, jobName, jobUid,
                error: (patchErr as Error).message,
              });
            } else {
              await waitMs(50 * Math.pow(2, attempt));
            }
          }
        }
      } catch (err) {
        // Job creation failed AFTER Secret creation — clean up the orphan.
        try { await deleteEphemeralSecret(client, namespace, secretName); } catch { /* swallow */ }
        cancellation.dispose();
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: "agent_exit_nonzero",
          errorMessage: `Failed to create Job: ${(err as Error).message}`,
        };
      }

      // 6. Start log + event streams. Both attach to the Pod that the Job
      //    spawns; pod name resolution happens lazily inside the loop below
      //    once the pod has been scheduled.
      const adapterOnLog = ctx.onLog;
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        await adapterOnLog(stream, redactor.redact(chunk));
      };

      const eventWatch = startEventWatch({ client, namespace, jobName, onLog });

      // Resolve the Pod that the Job created. The Job pod has the same run-id
      // label so we can locate it via labelSelector.
      let podName: string | null = null;
      const POD_RESOLUTION_DEADLINE_MS = 30_000;
      const podDeadline = Date.now() + POD_RESOLUTION_DEADLINE_MS;
      while (!cancelSignal.aborted && Date.now() < podDeadline) {
        const pod = await readPodForRun(client, namespace, runId).catch(() => undefined);
        if (pod?.metadata?.name) {
          podName = pod.metadata.name;
          break;
        }
        await waitMs(500, cancelSignal);
      }

      const logStream = podName
        ? startLogStream({ client, namespace, podName, containerName: "agent", onLog })
        : null;

      // 7. Poll Job status until terminal or cancelled.
      let cancelled = false;
      let terminalJob: V1Job | null = null;
      try {
        while (!cancelSignal.aborted) {
          const jobRead = await client.batch
            .readNamespacedJob(jobName, namespace)
            .catch(() => null);
          const job = jobRead?.body ?? null;
          if (job) {
            const t = isJobTerminal(job);
            if (t.done) {
              terminalJob = job;
              break;
            }
          }
          await waitMs(pollIntervalMs, cancelSignal);
        }

        if (cancelSignal.aborted && !terminalJob) {
          cancelled = true;
          await cancelJob({ client, namespace, jobName }).catch(() => { /* swallow */ });
          // Re-poll briefly so we can read the final pod state for the Adapter result.
          const cancelDeadline = Date.now() + 35_000;
          while (Date.now() < cancelDeadline) {
            const jobRead = await client.batch.readNamespacedJob(jobName, namespace).catch(() => null);
            const job = jobRead?.body ?? null;
            if (job) {
              const t = isJobTerminal(job);
              if (t.done) {
                terminalJob = job;
                break;
              }
            }
            await waitMs(pollIntervalMs);
          }
        }
      } finally {
        await safeStop(logStream);
        await safeStop(eventWatch);
        cancellation.dispose();
        // If the OwnerReference patch never succeeded, the Secret has no
        // back-pointer to the Job and Kubernetes GC will never delete it
        // (TTLSecondsAfterFinished only governs the Job itself). Delete it
        // explicitly here. The bootstrap token has already been consumed at
        // this point so deleting the Secret is safe even mid-run.
        if (!ownerRefPatched) {
          try { await deleteEphemeralSecret(client, namespace, secretName); }
          catch { /* best-effort cleanup; log volume already covered above */ }
        }
      }

      if (cancelled && !terminalJob) {
        // Cancellation requested but we couldn't observe a terminal Job state
        // within the grace window. Surface a structured cancellation result.
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          errorCode: "agent_exit_nonzero",
          errorMessage: "Run cancelled before Job reached terminal state",
        };
      }

      // 8. Map the terminal state to an AdapterExecutionResult.
      const finalPod = await readPodForRun(client, namespace, runId).catch(() => undefined);
      const result = mapTerminalState({ job: terminalJob ?? ({} as V1Job), pod: finalPod });
      if (cancelled) {
        // Even if mapTerminalState saw a normal terminal, the user-visible
        // outcome is "cancelled". Preserve any failure-code mapping that's
        // strictly more informative (e.g. image_pull_failed) but otherwise
        // signal SIGTERM.
        if (!result.errorCode) {
          return {
            ...result,
            signal: "SIGTERM",
            errorCode: "agent_exit_nonzero",
            errorMessage: result.errorMessage ?? "Run cancelled",
          };
        }
      }
      return result;
    },
  };
}
