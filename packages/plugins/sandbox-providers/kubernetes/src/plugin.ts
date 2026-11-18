import { randomBytes } from "node:crypto";
import path from "node:path";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginSyncOperation,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { eksIamNotAllowedMessage, isEksIamClusterAllowed } from "./eks-iam-auth.js";
import { getAdapterDefaults, buildAdapterEnv, resolveRunAdapterType } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { buildSandboxCrManifest } from "./sandbox-cr-builder.js";
import {
  assertPodCapacity,
  ensureTenantCached,
  invalidateTenantCache,
  OverCapacityError,
} from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import { jobOrchestrator, JobTimeoutError } from "./job-orchestrator.js";
import {
  DEFAULT_READY_POLL_MS,
  sandboxCrOrchestrator,
  SandboxCrTimeoutError,
} from "./sandbox-cr-orchestrator.js";
import { execInPod, execInPodStreaming, wrapCommandWithEnv } from "./pod-exec.js";
import { performSyncIn, performSyncOut, type PodStreamExec } from "./file-sync.js";
import { checkLeaseResumable, destroyLeaseResources } from "./lease-lifecycle.js";
import {
  beginLeaseExec,
  evictLongestIdleLease,
  forgetLease,
  startIdleReaper,
  trackReusableLease,
} from "./reuse-registry.js";
import { scrubPod } from "./pod-scrub.js";
import { podQuotaNeed, type PodQuotaNeed } from "./quota-math.js";
import {
  appendNetworkEgressDenyHint,
  createScopedNetworkEgressPolicyOrReleaseWorkload,
  NETWORK_EGRESS_GRANT_PATH,
  parseScopedNetworkEgressGrant,
} from "./scoped-network-egress.js";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  newRunUlidDns,
  paperclipLabels,
} from "./utils.js";

// The namespace paperclip-server itself runs in. Used when building
// NetworkPolicy manifests so the tenant namespace allows inbound traffic
// from the server pod.
const PAPERCLIP_SERVER_NAMESPACE = "paperclip";

// Name of the ServiceAccount created inside each tenant namespace by ensureTenant.
const TENANT_SERVICE_ACCOUNT = "paperclip-tenant-sa";

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

/**
 * Budget for the pod-Ready wait: the configured pod-ready timeout, never longer
 * than the caller's own timeout. This is what turns "quota full / unschedulable"
 * into a ~90 s clear failure instead of a hang for the whole run timeout.
 */
function podReadyBudgetMs(config: KubernetesProviderConfig, callerTimeoutMs: number): number {
  return Math.min(callerTimeoutMs, config.podReadyTimeoutSec * 1000);
}

/**
 * The Ready wait timed out: say why. If the company's pod quota is full, report
 * over-capacity; otherwise report the pod-ready timeout with the controller's
 * last status message.
 */
async function describePodReadyTimeout(
  clients: ReturnType<typeof makeKubeClients>,
  namespace: string,
  sandboxName: string,
  err: SandboxCrTimeoutError,
  budgetMs: number,
  need?: PodQuotaNeed,
): Promise<string> {
  // A full quota only explains the timeout if this sandbox's pod was never
  // admitted. If the pod exists it is counted in `used`, and a slow start at
  // the limit is a pod-start timeout, not over capacity.
  const podExists = await sandboxCrOrchestrator
    .findPod(clients, namespace, sandboxName)
    .then((name) => Boolean(name))
    .catch(() => false);
  if (!podExists) {
    try {
      await assertPodCapacity(clients, namespace, need);
    } catch (capacityErr) {
      if (capacityErr instanceof OverCapacityError) return capacityErr.message;
    }
  }
  return (
    `Sandbox pod did not become Ready within ${Math.round(budgetMs / 1000)}s` +
    (err.lastMessage ? ` (${err.lastMessage})` : "")
  );
}

function generateBootstrapToken(): string {
  // TODO: tighten once the agent runtime shim (companion images PR) lands its
  // callback auth scheme; paperclip-server's callback auth is out of scope for
  // this plugin. For now this per-run random token is stored in the per-run
  // Secret and read by the runtime image entrypoint for initial registration.
  return randomBytes(32).toString("hex");
}

// One FastUploadInterceptor instance per active lease. Scoping per lease
// prevents `releaseLease` from wiping in-flight upload buffers belonging to
// other concurrent leases — a single shared singleton would do exactly that
// on `reset()`. The Map is keyed by `providerLeaseId`; entries are lazily
// created in `onEnvironmentExecute` and removed in `onEnvironmentReleaseLease`.
const uploadInterceptorsByLease = new Map<string, FastUploadInterceptor>();

function getOrCreateUploadInterceptor(leaseId: string): FastUploadInterceptor {
  let interceptor = uploadInterceptorsByLease.get(leaseId);
  if (!interceptor) {
    interceptor = new FastUploadInterceptor();
    uploadInterceptorsByLease.set(leaseId, interceptor);
  }
  return interceptor;
}

// In-memory cache of sandbox CR names we've already observed reaching the
// Ready condition during the current plugin-worker lifetime. The k8s
// sandbox-cr lifecycle means once a Sandbox pod is Running, subsequent
// execs into it don't need another readiness poll — saves one
// `getNamespacedCustomObject` round-trip per exec, which adds up across
// dozens of sequential exec calls in a typical adapter workflow.
// On worker restart this resets, which is fine: the first exec on each
// lease then re-confirms readiness from scratch.
const readySandboxesByLease = new Set<string>();

// How long onEnvironmentResumeLease waits for an existing Sandbox pod to
// report Ready before declaring the lease non-resumable. Deliberately short:
// this is a liveness check on an already-provisioned pod, not a fresh
// provision — if the pod isn't (almost) up, falling back to acquireLease is
// faster and more reliable than waiting.
const RESUME_READY_TIMEOUT_MS = 30_000;

// How often the plugin looks for reusable pods idle past their TTL.
const IDLE_REAP_INTERVAL_MS = 30_000;
const RESUME_READY_POLL_MS = 1_000;

// Every agent pod mounts an emptyDir at /workspace (sandbox-cr-builder /
// pod-spec-builder). It is the lease's working dir until a workspace is realized.
export const DEFAULT_WORKSPACE_REMOTE_DIR = "/workspace";

// The lease's remote working dir: an already-recorded absolute dir is kept;
// otherwise the pod's /workspace mount. Recorded at acquire/resume time so a run
// that never realizes a workspace (a plain task with no project) still has a
// concrete sync root, and the server's execution target uses the same dir (it
// falls back to /tmp when the lease carries none). The value is the native-sync
// confinement root, so only a normalized absolute path below / is accepted.
export function leaseRemoteCwd(existing: unknown): string {
  if (typeof existing !== "string") return DEFAULT_WORKSPACE_REMOTE_DIR;
  const trimmed = existing.trim();
  return isConfinableRemoteDir(trimmed) ? trimmed : DEFAULT_WORKSPACE_REMOTE_DIR;
}

// A usable confinement root: absolute, below / (never / itself), already
// normalized (no ., .., // or trailing /).
export function isConfinableRemoteDir(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value !== "/" &&
    !value.endsWith("/") &&
    path.posix.normalize(value) === value
  );
}

// The workspace remote dir is the confinement root for native file sync. It is
// recorded on the lease metadata (`remoteCwd`) at acquire/resume time; require it
// so a sync can never run without a concrete root to confine every sandbox path
// against.
export function resolveSyncRemoteDir(lease: PluginEnvironmentLease): string {
  const remoteCwd = lease.metadata?.remoteCwd;
  if (typeof remoteCwd === "string" && remoteCwd.trim().length > 0) {
    const trimmed = remoteCwd.trim();
    // Validated here too, not only where it is written: a root such as "/" would
    // make the whole container filesystem the confinement root.
    if (!isConfinableRemoteDir(trimmed)) {
      throw new Error("Kubernetes file sync requires a normalized absolute workspace remote dir below / on the lease metadata.");
    }
    return trimmed;
  }
  throw new Error("Kubernetes file sync requires a workspace remote dir on the lease metadata.");
}

function isNoopSync(operations: PluginSyncOperation[]): boolean {
  return operations.every(
    (op) => op.files.length === 0 && (op.postUploadCommands?.length ?? 0) === 0,
  );
}

function noopSyncResult(operations: PluginSyncOperation[]): PluginEnvironmentSyncResult {
  return {
    operations: operations.map((op) => ({
      operationId: op.operationId,
      filesTransferred: 0,
      bytesTransferred: 0,
    })),
  };
}

/**
 * Resolve the running Sandbox-CR pod for a native file-sync operation and return
 * a `PodStreamExec` bound to it, exactly like `onEnvironmentExecute` resolves its exec
 * target: parse config, derive the namespace, wait for the Sandbox pod to reach
 * Ready (cached per lease), and find the pod name. The `job` backend carries no
 * file path and is out of scope — file sync is only supported on `sandbox-cr`.
 */
async function resolveSyncPodExec(
  params:
    | PluginEnvironmentSyncInParams
    | PluginEnvironmentSyncOutParams,
): Promise<{ exec: PodStreamExec; timeoutMs: number }> {
  const { lease } = params;
  if (!lease.providerLeaseId) {
    throw new Error("Kubernetes file sync requires a provider lease ID.");
  }

  const config = kubernetesProviderConfigSchema.parse(params.config);
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, params.companyId);

  const leaseBackend =
    typeof lease.metadata?.backend === "string"
      ? (lease.metadata.backend as "sandbox-cr" | "job")
      : config.backend;
  if (leaseBackend !== "sandbox-cr") {
    throw new Error(
      `Kubernetes file sync is only supported on the sandbox-cr backend (lease backend: ${leaseBackend}).`,
    );
  }

  const kc = createKubeConfig({
    inCluster: config.inCluster,
    kubeconfig: config.kubeconfig,
    auth: config.auth,
  });
  const clients = makeKubeClients(kc);
  const timeoutMs = config.podActivityDeadlineSec * 1000;

  // Ensure the Sandbox pod is Ready (wait only the first time for this lease),
  // then resolve the pod name — mirrors the onEnvironmentExecute resolution.
  if (!readySandboxesByLease.has(lease.providerLeaseId)) {
    const readyBudgetMs = podReadyBudgetMs(config, timeoutMs);
    try {
      await sandboxCrOrchestrator.waitForCompletion(clients, namespace, lease.providerLeaseId, {
        timeoutMs: readyBudgetMs,
        pollMs: DEFAULT_READY_POLL_MS,
      });
    } catch (err) {
      if (err instanceof SandboxCrTimeoutError) {
        throw new Error(await describePodReadyTimeout(clients, namespace, lease.providerLeaseId, err, readyBudgetMs, podQuotaNeed(config.defaultResources)));
      }
      throw err;
    }
    readySandboxesByLease.add(lease.providerLeaseId);
  }

  const podName =
    typeof lease.metadata?.podName === "string" && lease.metadata.podName
      ? lease.metadata.podName
      : await sandboxCrOrchestrator.findPod(clients, namespace, lease.providerLeaseId);
  if (!podName) {
    throw new Error("Kubernetes file sync could not resolve the Sandbox pod name.");
  }

  // Bind the streaming exec: raw tar bytes move over stdin/stdout straight to and
  // from a host file, so neither side buffers the whole payload. The file-sync
  // module bounds the untrusted pod's stdout with its own streamed-bytes disk
  // guard and passes the stderr cap through `io`.
  const exec: PodStreamExec = (command, io) =>
    execInPodStreaming(kc, namespace, podName, "agent", command, {
      ...io,
      timeoutMs: io.timeoutMs ?? timeoutMs,
    });
  return { exec, timeoutMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the plugin manages this lease: the server kept it running for reuse
 * (`metadata.reusableSandboxLease`) and it is not a paperclip_runner sandbox,
 * which owns its own lifecycle. Every such pod gets the idle TTL (a retained pod
 * can never leak), the between-turn scrub, and quota eviction. One-shot leases
 * (plain task runs) are left alone.
 */
function isManagedReusableLease(metadata: Record<string, unknown> | null | undefined): boolean {
  const scope = metadata?.reusableSandboxLease;
  if (!isRecord(scope)) return false;
  return typeof scope.adapterType !== "string" || scope.adapterType !== "paperclip_runner";
}

/** Wait briefly for evicted pods to leave the quota (terminating pods still count). */
async function waitForPodCapacity(
  clients: ReturnType<typeof makeKubeClients>,
  namespace: string,
  need: PodQuotaNeed,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertPodCapacity(clients, namespace, need);
      return;
    } catch (err) {
      if (!(err instanceof OverCapacityError) || Date.now() >= deadline) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Begin idle tracking for an exec on a lease the server marked reusable
 * (`metadata.reusableSandboxLease`). Returns the function to call when the exec
 * finishes. A no-op for ordinary one-shot leases, so Pi/Claude are untouched.
 */
function trackLeaseExecStart(params: PluginEnvironmentExecuteParams): () => void {
  const { lease } = params;
  if (!lease.providerLeaseId) return () => {};
  const config = kubernetesProviderConfigSchema.safeParse(params.config);
  if (!config.success || !isManagedReusableLease(lease.metadata)) return () => {};
  const leaseBackend = typeof lease.metadata?.backend === "string" ? lease.metadata.backend : config.data.backend;
  if (leaseBackend !== "sandbox-cr") return () => {};
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config.data, params.companyId);
  trackReusableLease({
    namespace,
    name: lease.providerLeaseId,
    secretName:
      typeof lease.metadata?.secretName === "string"
        ? lease.metadata.secretName
        : `${lease.providerLeaseId}-env`,
    podName: typeof lease.metadata?.podName === "string" ? lease.metadata.podName : null,
    backend: "sandbox-cr",
    clients: makeKubeClients(
      createKubeConfig({ inCluster: config.data.inCluster, kubeconfig: config.data.kubeconfig, auth: config.data.auth }),
    ),
    idleTtlMs: config.data.runnerIdleTimeoutMs,
  });
  return beginLeaseExec(namespace, lease.providerLeaseId);
}

async function executeInLease(
  params: PluginEnvironmentExecuteParams,
): Promise<PluginEnvironmentExecuteResult> {
  const { lease, timeoutMs } = params;

  if (!lease.providerLeaseId) {
    return {
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "No provider lease ID available for execution.",
    };
  }

  const config = kubernetesProviderConfigSchema.parse(params.config);
  const scopedNetworkEgress = parseScopedNetworkEgressGrant({
    networkEgress: lease.metadata?.scopedNetworkEgress,
  });
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, params.companyId);

  // Determine which backend this lease was created with.
  const leaseBackend =
    typeof lease.metadata?.backend === "string"
      ? (lease.metadata.backend as "sandbox-cr" | "job")
      : config.backend;

  const kc = createKubeConfig({
    inCluster: config.inCluster,
    kubeconfig: config.kubeconfig,
    auth: config.auth,
  });
  const clients = makeKubeClients(kc);

  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : config.podActivityDeadlineSec * 1000;

  if (leaseBackend === "sandbox-cr") {
    // ── Sandbox-CR backend ──────────────────────────────────────────────────
    // 1. Ensure the Sandbox pod is Ready (wait only on first exec for this lease).
    // 2. Exec the command into the running pod.
    // 3. Return exec result directly (no log scraping needed).

    let podName =
      typeof lease.metadata?.podName === "string" && lease.metadata.podName
        ? lease.metadata.podName
        : null;

    // Skip the readiness poll if we've already observed this Sandbox CR
    // reaching Ready during this worker's lifetime. See readySandboxesByLease
    // declaration for rationale.
    const podAlreadyKnownReady = readySandboxesByLease.has(lease.providerLeaseId);

    // The caller's timeout is a budget for the WHOLE execute call: readiness
    // wait + exec must share it, or the first exec on a fresh lease could
    // block for up to twice the requested timeout.
    const executeStartedAt = Date.now();

    if (!podAlreadyKnownReady) {
      const readyBudgetMs = podReadyBudgetMs(config, effectiveTimeoutMs);
      try {
        await sandboxCrOrchestrator.waitForCompletion(
          clients,
          namespace,
          lease.providerLeaseId,
          { timeoutMs: readyBudgetMs, pollMs: DEFAULT_READY_POLL_MS },
        );
        readySandboxesByLease.add(lease.providerLeaseId);
      } catch (err) {
        if (err instanceof OverCapacityError) {
          return {
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: err.message,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              overCapacity: true,
            },
          };
        }
        if (err instanceof SandboxCrTimeoutError) {
          const message = await describePodReadyTimeout(clients, namespace, lease.providerLeaseId, err, readyBudgetMs, podQuotaNeed(config.defaultResources));
          if (message.startsWith("Over capacity")) {
            // The pod never started because the company quota is full: report
            // it the same way as the fail-fast path, not as a run timeout.
            return {
              exitCode: 1,
              timedOut: false,
              stdout: "",
              stderr: message,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
                overCapacity: true,
              },
            };
          }
          return {
            exitCode: null,
            timedOut: true,
            stdout: "",
            stderr: message,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
            },
          };
        }
        throw err;
      }
    }

    // Resolve pod name (may now be populated in Sandbox status).
    if (!podName) {
      podName = await sandboxCrOrchestrator.findPod(
        clients,
        namespace,
        lease.providerLeaseId,
      );
    }

    if (!podName) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "Sandbox pod is Ready but podName could not be resolved.",
        metadata: {
          provider: "kubernetes",
          backend: "sandbox-cr",
          namespace,
          sandboxName: lease.providerLeaseId,
        },
      };
    }

    // Build the command to exec. The adapter passes shell invocations as
    // `command: "sh", args: ["-c", "<script>"]` — must combine both, NOT
    // drop args. If only command is present (no args), wrap in a login shell.
    const command = typeof params.command === "string" ? params.command.trim() : "";
    const args = Array.isArray(params.args) ? params.args : [];

    // Fast-upload interceptor: short-circuit the chunked-shell file transfer
    // protocol (adapter-utils writeFile) so an N-chunk upload becomes 1 exec
    // instead of N+2. Falls back transparently when patterns don't match.
    // See upload-interceptor.ts.
    const shellScript =
      command === "sh" && args[0] === "-c" && typeof args[1] === "string"
        ? args[1]
        : null;
    if (shellScript) {
      const decision = getOrCreateUploadInterceptor(lease.providerLeaseId).decide(shellScript);
      if (decision.action === "ack") {
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
            podName,
            fastUpload: "ack",
          },
        };
      }
      if (decision.action === "flush") {
        // Single exec: `head -c <N> | base64 -d > '<TARGET>'` with stdin =
        // base64 ASCII. `head -c` reads EXACTLY N bytes and exits, so we
        // don't depend on WebSocket-driven EOF detection on stdin (which is
        // racy against the `base64 -d` exit timing in @kubernetes/client-node
        // v0.21.0 — see pod-exec.ts). All bytes are sent through the
        // WebSocket data channel; size is unbounded by ARG_MAX.
        const base64Body = decision.flush.payload.toString("base64");
        const dir = decision.flush.targetPath.substring(
          0,
          decision.flush.targetPath.lastIndexOf("/"),
        );
        const script =
          `mkdir -p '${dir}' && ` +
          `head -c ${base64Body.length} | base64 -d > '${decision.flush.targetPath}'`;
        // The flush shares the caller's single execute budget (same contract
        // as the normal exec path below) and surfaces watchdog/WebSocket
        // failures as a timed-out result instead of an uncaught throw.
        const flushTimeoutMs = Math.max(
          5_000,
          effectiveTimeoutMs - (Date.now() - executeStartedAt),
        );
        let flushResult: { exitCode: number; stdout: string; stderr: string };
        try {
          flushResult = await execInPod(
            kc,
            namespace,
            podName,
            "agent",
            ["/bin/sh", "-c", script],
            base64Body,
            flushTimeoutMs,
          );
        } catch (err) {
          return {
            exitCode: null,
            timedOut: true,
            stdout: "",
            stderr: `fast-upload flush failed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "flush",
            },
          };
        }
        return {
          exitCode: flushResult.exitCode,
          timedOut: false,
          stdout: flushResult.stdout,
          stderr: flushResult.stderr,
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
            podName,
            fastUpload: "flush",
            uploadedBytes: decision.flush.payload.length,
          },
        };
      }
      // decision.action === "passthrough" — fall through to normal exec
    }

    const baseExecCommand =
      command.length > 0 && args.length > 0
        ? [command, ...args]
        : command.length > 0
          ? ["/bin/sh", "-lc", command]
          : ["/bin/sh", "-l"];

    // Apply the caller-provided run env (params.env) to the in-pod process. Without
    // this the adapter's runtime env (e.g. XDG_CONFIG_HOME pointing at the shipped
    // OpenCode config, plus helper settings like small_model/provider routing) never
    // reaches the harness, which falls back to its in-image HOME config -> wrong or
    // partial behaviour. Env values travel on stdin, never in the exec request URI
    // (see wrapCommandWithEnv).
    const wrapped = wrapCommandWithEnv(
      baseExecCommand,
      params.env,
      typeof params.stdin === "string" ? params.stdin : undefined,
    );

    // Remaining share of the caller's budget after the readiness wait (floor
    // of 5s so an exec attempt is still made when readiness consumed most of
    // it; the watchdog then bounds it tightly).
    const remainingTimeoutMs = Math.max(
      5_000,
      effectiveTimeoutMs - (Date.now() - executeStartedAt),
    );

    let execResult: { exitCode: number; stdout: string; stderr: string };
    try {
      execResult = await execInPod(
        kc,
        namespace,
        podName,
        "agent",
        wrapped.command,
        wrapped.stdin,
        remainingTimeoutMs,
      );
    } catch (err) {
      // Watchdog-fired or WebSocket-setup error. Surface as a timeout so
      // the caller can retry instead of hanging forever.
      return {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: appendNetworkEgressDenyHint(err instanceof Error ? err.message : String(err), scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "sandbox-cr",
          namespace,
          sandboxName: lease.providerLeaseId,
          podName,
        },
      };
    }

    return {
      exitCode: execResult.exitCode,
      timedOut: false,
      stdout: execResult.stdout,
      stderr: appendNetworkEgressDenyHint(execResult.stderr, scopedNetworkEgress),
      metadata: {
        provider: "kubernetes",
        backend: "sandbox-cr",
        namespace,
        sandboxName: lease.providerLeaseId,
        podName,
      },
    };
  } else {
    // ── Job backend (legacy / stable fallback) ──────────────────────────────
    // The container entrypoint is baked into the Job spec (Tini + paperclip-agent-shim).
    // We do NOT re-exec command/args — instead we wait for the Job to finish
    // and collect its logs.
    //
    // params.command / params.args / params.stdin are intentionally ignored.

    let status;
    let timedOut = false;
    try {
      status = await jobOrchestrator.waitForCompletion(
        clients,
        namespace,
        lease.providerLeaseId,
        { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
      );
    } catch (err) {
      if (err instanceof JobTimeoutError) {
        timedOut = true;
        status = null;
      } else {
        throw err;
      }
    }

    // Collect logs from the pod.
    const podName =
      typeof lease.metadata?.podName === "string"
        ? lease.metadata.podName
        : await jobOrchestrator.findPod(
            clients,
            namespace,
            lease.providerLeaseId,
          );

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (podName) {
      await jobOrchestrator.streamLogs(
        clients,
        namespace,
        podName,
        async (stream, text) => {
          if (stream === "stdout") stdoutChunks.push(text);
          else stderrChunks.push(text);
        },
      );
    }

    return {
      exitCode: timedOut ? null : status?.phase === "Succeeded" ? 0 : 1,
      timedOut,
      stdout: stdoutChunks.join(""),
      stderr: appendNetworkEgressDenyHint(stderrChunks.join(""), scopedNetworkEgress),
      metadata: {
        provider: "kubernetes",
        backend: "job",
        namespace,
        jobName: lease.providerLeaseId,
        podName: podName ?? null,
        phase: status?.phase ?? null,
      },
    };
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // Idle-TTL reaper for reusable (kept-running) conversation pods.
    startIdleReaper(IDLE_REAP_INTERVAL_MS, (err, entry) => {
      ctx.logger.warn(
        `[plugin-kubernetes] idle reap of ${entry.namespace}/${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    ctx.logger.info("Kubernetes sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Kubernetes sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => i.message),
      };
    }
    const warnings: string[] = [];
    const cfg = parsed.data;
    if (cfg.auth && !isEksIamClusterAllowed(cfg.auth)) {
      return { ok: false, errors: [eksIamNotAllowedMessage(cfg.auth)] };
    }
    const adapterDefaults = getAdapterDefaults(cfg.adapterType, cfg.adapters);
    const totalFqdns = [...adapterDefaults.allowFqdns, ...cfg.egressAllowFqdns];
    if (cfg.egressMode === "standard" && totalFqdns.length > 0) {
      if (cfg.egressAllowCidrs.length === 0) {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules (Kubernetes NetworkPolicy is CIDR-only). To keep the configured FQDNs reachable (${totalFqdns.join(", ")}) without operator intervention, the plugin will allow public IPv4 egress on TCP 80/443 with private/link-local/loopback/multicast ranges excluded. This is broader than exact FQDN allow-listing — switch egressMode to "cilium" (requires Cilium CNI) for precise enforcement, or set egressAllowCidrs explicitly to override the fallback.`,
        );
      } else {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via the operator-supplied egressAllowCidrs: ${totalFqdns.join(", ")}. Switch egressMode to "cilium" (requires Cilium CNI) for exact FQDN allow-listing.`,
        );
      }
    }
    // Do not persist a quota the operator never set: stored derived values would
    // freeze today's defaults and stop them following `pods` or future defaults.
    const normalized: Record<string, unknown> = { ...cfg };
    const rawQuota = (params.config as Record<string, unknown> | null | undefined)?.resourceQuota;
    // Persist only what the operator wrote (validated above), never the derived tuple.
    if (rawQuota === undefined || rawQuota === null) delete normalized.resourceQuota;
    else normalized.resourceQuota = rawQuota;
    return { ok: true, normalizedConfig: normalized, warnings: warnings.length > 0 ? warnings : undefined };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        summary: "Invalid Kubernetes provider configuration.",
        metadata: {
          errors: parsed.error.issues.map((i) => i.message),
        },
      };
    }
    const config = parsed.data;
    const namespace = deriveTenantNamespace(config, params.companyId);

    try {
      const kc = createKubeConfig({
        inCluster: config.inCluster,
        kubeconfig: config.kubeconfig,
        auth: config.auth,
      });
      const clients = makeKubeClients(kc);
      // Reachability check: list pods in the tenant namespace. If the namespace
      // doesn't exist yet this will throw a 404 which we treat as "reachable
      // but namespace not provisioned" — still a successful probe.
      try {
        await clients.core.listNamespacedPod({ namespace });
      } catch (err) {
        const code = (err as { code?: number; statusCode?: number }).code
          ?? (err as { code?: number; statusCode?: number }).statusCode;
        if (code !== 404) throw err;
        // 404 means namespace doesn't exist yet — cluster is reachable.
      }
      return {
        ok: true,
        summary: `Kubernetes cluster reachable. Tenant namespace: ${namespace}.`,
        metadata: { namespace, provider: "kubernetes" },
      };
    } catch (err) {
      return {
        ok: false,
        summary: "Kubernetes cluster probe failed.",
        metadata: {
          namespace,
          provider: "kubernetes",
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    // `adapterType` is an optional per-run hint the server may pass once the
    // SDK lease params grow that field (companion server-integration PR). The
    // plugin works without it: absent means "use the environment's configured
    // default adapter", so it stays compatible with the current SDK.
    params: PluginEnvironmentAcquireLeaseParams & {
      adapterType?: string;
      executionWorkspaceSettings?: Record<string, unknown> | null;
    },
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);

    // The adapter for THIS run is the agent's adapter (params.adapterType) when
    // supplied, so one environment can serve mixed harnesses; otherwise fall back
    // to the environment's configured default adapter. getAdapterDefaults validates
    // it is a registered adapter (throws otherwise), so a curated-out adapter fails
    // the lease as before.
    const effectiveAdapterType = resolveRunAdapterType(params.adapterType, config.adapterType);

    // Emit a runtime warning if FQDNs are configured but egressMode=standard
    // cannot enforce them. Mirrors the validateConfig warning so operators see
    // it in paperclip-server logs even if they missed the validation step.
    const adapterDefaultsForWarn = getAdapterDefaults(effectiveAdapterType, config.adapters);
    const totalFqdnsForWarn = [...adapterDefaultsForWarn.allowFqdns, ...config.egressAllowFqdns];
    if (config.egressMode === "standard" && totalFqdnsForWarn.length > 0) {
      if (config.egressAllowCidrs.length === 0) {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules; falling back to public-IPv4 (TCP 80/443) with private/link-local ranges excluded so the configured FQDNs (${totalFqdnsForWarn.join(", ")}) remain reachable. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      } else {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via operator-supplied egressAllowCidrs: ${totalFqdnsForWarn.join(", ")}. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      }
    }

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
      auth: config.auth,
    });
    const clients = makeKubeClients(kc);

    // Ensure the tenant namespace and all its RBAC / network policy resources
    // exist before we try to create the Job.
    const adapterDefaults = getAdapterDefaults(effectiveAdapterType, config.adapters);

    // What one more pod adds to the quota (CPU/memory limits and requests).
    const quotaNeed = podQuotaNeed(config.defaultResources);

    await ensureTenantCached(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
      serviceAccountAnnotations: config.serviceAccountAnnotations,
      egressMode: config.egressMode,
      egressAllowFqdns: [...adapterDefaults.allowFqdns, ...config.egressAllowFqdns],
      egressAllowCidrs: config.egressAllowCidrs,
      resourceQuota: config.resourceQuota,
    });

    // Fail fast (no queue) when the company's pod quota is already full, rather
    // than creating a Sandbox whose pod the quota will never admit.
    try {
      await assertPodCapacity(clients, namespace, quotaNeed);
    } catch (err) {
      // Idle reusable conversation pods hold company quota. Before refusing a
      // new run, evict the longest-idle one; its conversation just pays a cold
      // start on its next turn. If there is nothing to evict, fail fast.
      if (!(err instanceof OverCapacityError) || !(await evictLongestIdleLease(namespace))) throw err;
      // The evicted pod still counts against the quota while it terminates.
      await waitForPodCapacity(clients, namespace, quotaNeed);
    }

    const jobName = `pc-${newRunUlidDns()}`;
    const secretName = `${jobName}-env`;

    // TODO: use params.runId as stand-in for agentId in labels; future
    // versions will have a dedicated agentId on AcquireLeaseParams.
    const labels = paperclipLabels({
      runId: params.runId,
      agentId: params.runId,
      companyId: params.companyId,
      adapterType: effectiveAdapterType,
    });

    const image = resolveImage(
      { imageOverride: null },
      adapterDefaults,
      { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
    );

    // Pick the orchestrator and build the appropriate manifest based on backend.
    const isSandboxCrBackend = config.backend === "sandbox-cr";
    const orchestrator = isSandboxCrBackend ? sandboxCrOrchestrator : jobOrchestrator;

    const manifest = isSandboxCrBackend
      ? buildSandboxCrManifest({
          namespace,
          sandboxName: jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          resources: config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          imagePullSecrets: config.imagePullSecrets,
        })
      : buildJobManifest({
          namespace,
          jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          resources: config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          activeDeadlineSec: config.podActivityDeadlineSec,
          ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
          imagePullSecrets: config.imagePullSecrets,
        });

    let ownerUid: string;
    try {
      ({ uid: ownerUid } = await orchestrator.claim(clients, namespace, manifest));
    } catch (err) {
      // The cached tenant ensure may be stale (namespace removed out of band).
      invalidateTenantCache(namespace);
      throw err;
    }
    const scopedNetworkEgress = parseScopedNetworkEgressGrant(params.executionWorkspaceSettings);
    const scopedNetworkPolicyName = await createScopedNetworkEgressPolicyOrReleaseWorkload(
      {
        clients,
        namespace,
        mode: config.egressMode,
        runId: params.runId,
        workloadName: jobName,
        ownerReference: {
          apiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1alpha1" : "batch/v1",
          kind: isSandboxCrBackend ? "Sandbox" : "Job",
          name: jobName,
          uid: ownerUid,
          controller: false,
          blockOwnerDeletion: false,
        },
        grant: scopedNetworkEgress,
      },
      () => orchestrator.release(clients, namespace, jobName),
    );

    // defaultEnv (non-secret base, e.g. the inference base URL) is layered first;
    // the process-env secrets named by envKeys override it.
    const adapterEnv = buildAdapterEnv(adapterDefaults);
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_POLICY = "kubernetes-default-deny";
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_GRANT_PATH = NETWORK_EGRESS_GRANT_PATH;
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS = scopedNetworkEgress.allowFqdns.join(",");
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_CIDRS = scopedNetworkEgress.allowCidrs.join(",");
    const bootstrapToken = generateBootstrapToken();

    // Secret ownerRef: for job backend, the Job owns the Secret (cascade delete).
    // For sandbox-cr backend, the Sandbox CR owns the Secret.
    // NOTE: For sandbox-cr, if the Secret outlives the Sandbox due to a cluster
    // quirk, the release() call will still clean it up via namespace GC or
    // explicit delete in a future iteration.
    await createPerRunSecret(clients, {
      namespace,
      secretName,
      runId: params.runId,
      ownerKind: isSandboxCrBackend ? "Sandbox" : "Job",
      ownerApiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1alpha1" : "batch/v1",
      ownerName: jobName,
      ownerUid,
      bootstrapToken,
      adapterEnv,
    });

    const podName = await orchestrator.findPod(clients, namespace, jobName);

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName,
      podName,
      secretName,
      phase: "Pending",
      backend: config.backend,
      scopedNetworkPolicyName,
      scopedNetworkEgress,
      // Native file sync streams over a pod exec; only the sandbox-cr backend
      // exposes one. Flag the job backend so the server keeps the base64 fallback
      // rather than routing its sync to a hook that would reject immediately.
      nativeFileSyncUnsupported: config.backend !== "sandbox-cr",
      remoteCwd: DEFAULT_WORKSPACE_REMOTE_DIR,
    };

    return {
      providerLeaseId: jobName,
      metadata: leaseMetadata as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    // acquireLease names the per-run Secret `${jobName}-env` and uses jobName
    // as the providerLeaseId, so the suffix fallback reconstructs it exactly.
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
      auth: config.auth,
    });
    const clients = makeKubeClients(kc);

    const check = await checkLeaseResumable(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      readyTimeoutMs: RESUME_READY_TIMEOUT_MS,
      pollMs: RESUME_READY_POLL_MS,
    });

    if (!check.resumable) {
      // Kubernetes pods are NOT restartable the way Daytona sandboxes are: a
      // stopped Daytona sandbox can be started again by ID, but a k8s pod that
      // is gone or terminally failed can never be revived in place. Gone = not
      // resumable, by design. Returning providerLeaseId: null tells the server
      // the lease expired so it falls back to a fresh acquireLease.
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: check.reason },
      };
    }

    // A resumed lease starts with clean per-lease state: drop any stale upload
    // interceptor buffers a previous run on this lease may have left behind.
    uploadInterceptorsByLease.delete(params.providerLeaseId);

    // Reused pod: scrub the previous turn's processes and runtime files before
    // handing it to the next turn. A pod that cannot be scrubbed is not reused:
    // destroy it and report the lease expired so the server acquires a fresh one.
    if (leaseBackend === "sandbox-cr" && check.podName && isManagedReusableLease(params.leaseMetadata)) {
      const remoteCwd = leaseRemoteCwd(params.leaseMetadata?.remoteCwd);
      const idleTtlMs = kubernetesProviderConfigSchema.parse(params.config).runnerIdleTimeoutMs;
      // Track before scrubbing so a pod we then fail to delete stays visible to
      // the idle reaper and quota eviction, which retry the destroy.
      trackReusableLease({
        namespace,
        name: params.providerLeaseId,
        secretName,
        podName: check.podName,
        backend: "sandbox-cr",
        clients,
        idleTtlMs,
      });
      const scrub = await scrubPod(kc, namespace, check.podName, remoteCwd);
      if (!scrub.ok) {
        readySandboxesByLease.delete(params.providerLeaseId);
        try {
          await destroyLeaseResources(clients, {
            namespace,
            name: params.providerLeaseId,
            backend: leaseBackend,
            podName: check.podName,
            secretName,
          });
          forgetLease(namespace, params.providerLeaseId);
        } catch {
          // Still report the lease expired so the server acquires a fresh one.
          // The entry stays tracked, so the idle reaper retries the delete.
        }
        return {
          providerLeaseId: null,
          metadata: { expired: true, reason: `scrub failed: ${scrub.detail}` },
        };
      }
    }
    if (leaseBackend === "sandbox-cr") {
      // We just observed the Sandbox pod Ready, so the first exec on the
      // resumed lease can skip its readiness poll.
      readySandboxesByLease.add(params.providerLeaseId);
    }

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName: params.providerLeaseId,
      podName: check.podName,
      secretName,
      phase: check.phase,
      backend: leaseBackend,
      scopedNetworkPolicyName:
        typeof params.leaseMetadata?.scopedNetworkPolicyName === "string"
          ? params.leaseMetadata.scopedNetworkPolicyName
          : null,
      scopedNetworkEgress: parseScopedNetworkEgressGrant({
        networkEgress: params.leaseMetadata?.scopedNetworkEgress,
      }),
      // See acquireLease: only the sandbox-cr backend has a pod-exec channel for
      // native sync, so a resumed job lease must keep the base64 fallback.
      nativeFileSyncUnsupported: leaseBackend !== "sandbox-cr",
      // Keep an already-recorded remote dir across resume; default to the pod mount.
      remoteCwd: leaseRemoteCwd(params.leaseMetadata?.remoteCwd),
    };

    return {
      providerLeaseId: params.providerLeaseId,
      metadata: {
        ...leaseMetadata,
        resumedLease: true,
      } as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    // The agent pod already has /workspace mounted as an emptyDir at pod
    // scheduling time (see pod-spec-builder). Nothing to provision here —
    // we just hand back the cwd. Honor a caller-supplied remotePath if set.
    // The server keeps only its own workspace-realization record from this
    // result; the lease's remoteCwd (sync root) is the one set at acquire/resume.
    const cwd =
      params.workspace.remotePath && params.workspace.remotePath.trim().length > 0
        ? params.workspace.remotePath.trim()
        : DEFAULT_WORKSPACE_REMOTE_DIR;
    return {
      cwd,
      metadata: {
        provider: "kubernetes",
        remoteCwd: cwd,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
      auth: config.auth,
    });
    const clients = makeKubeClients(kc);

    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const releaseOrchestrator =
      leaseBackend === "sandbox-cr" ? sandboxCrOrchestrator : jobOrchestrator;

    // Drop the FastUploadInterceptor associated with THIS lease (only).
    // Each lease has its own interceptor instance via uploadInterceptorsByLease,
    // so unrelated concurrent leases keep their in-flight buffers intact.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);
    forgetLease(namespace, params.providerLeaseId);

    try {
      await releaseOrchestrator.release(clients, namespace, params.providerLeaseId);
    } catch (err) {
      // If the resource is already gone (404), that's fine.
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { code?: number; statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;
    const podName =
      typeof params.leaseMetadata?.podName === "string" &&
      params.leaseMetadata.podName.length > 0
        ? params.leaseMetadata.podName
        : null;

    // Clear per-lease in-memory state up front, regardless of what the
    // cluster says — the lease is dead either way.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);
    forgetLease(namespace, params.providerLeaseId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
      auth: config.auth,
    });
    const clients = makeKubeClients(kc);

    // Forcibly delete everything acquireLease created (Sandbox CR / Job, pod,
    // per-run Secret). 404s are success — destroy must be idempotent.
    await destroyLeaseResources(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName,
      secretName,
    });
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const endExec = trackLeaseExecStart(params);
    try {
      return await executeInLease(params);
    } finally {
      endExec();
    }
  },

  // Opt-in native inbound transfer. Defining this hook (with onEnvironmentSyncOut)
  // makes the worker advertise `environmentSyncIn`/`environmentSyncOut`, so the
  // host runner routes workspace/asset transfers through a single pod exec per
  // operation (host tar streamed over the exec stdin → in-pod `head -c <N> | tar
  // -x` → stage-then-atomic-`mv -f`) instead of the base64-over-exec chunk loop.
  // Only the sandbox-cr backend is supported; the job backend carries no file
  // path. Providers that do not define these keep the byte-identical fallback.
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    // Nothing to transfer (e.g. a chat turn with no workspace): skip the pod
    // resolution and readiness wait entirely.
    if (isNoopSync(params.operations)) return noopSyncResult(params.operations);
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncIn({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },

  // Opt-in native outbound transfer. See onEnvironmentSyncIn.
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    if (isNoopSync(params.operations)) return noopSyncResult(params.operations);
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncOut({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },
});

export default plugin;
