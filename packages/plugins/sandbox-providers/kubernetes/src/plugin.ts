import { randomBytes } from "node:crypto";
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
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { getAdapterDefaults, buildAdapterEnv, resolveRunAdapterType } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { buildSandboxCrManifest } from "./sandbox-cr-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import { jobOrchestrator, JobTimeoutError } from "./job-orchestrator.js";
import {
  sandboxCrOrchestrator,
  SandboxCrTimeoutError,
} from "./sandbox-cr-orchestrator.js";
import { execInPod, wrapCommandWithEnv } from "./pod-exec.js";
import { checkLeaseResumable, destroyLeaseResources } from "./lease-lifecycle.js";
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

// Resource quota defaults applied to every tenant namespace (tunable via
// config in a future iteration).
const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
};

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
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
const RESUME_READY_POLL_MS = 1_000;

const plugin = definePlugin({
  async setup(ctx) {
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
    return { ok: true, normalizedConfig: cfg as Record<string, unknown>, warnings: warnings.length > 0 ? warnings : undefined };
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
    params: PluginEnvironmentAcquireLeaseParams & { adapterType?: string },
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
    });
    const clients = makeKubeClients(kc);

    // Ensure the tenant namespace and all its RBAC / network policy resources
    // exist before we try to create the Job.
    const adapterDefaults = getAdapterDefaults(effectiveAdapterType, config.adapters);

    await ensureTenant(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
      serviceAccountAnnotations: config.serviceAccountAnnotations,
      egressMode: config.egressMode,
      egressAllowFqdns: [...adapterDefaults.allowFqdns, ...config.egressAllowFqdns],
      egressAllowCidrs: config.egressAllowCidrs,
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
    });

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

    const { uid: ownerUid } = await orchestrator.claim(clients, namespace, manifest);

    // defaultEnv (non-secret base, e.g. the inference base URL) is layered first;
    // the process-env secrets named by envKeys override it.
    const adapterEnv = buildAdapterEnv(adapterDefaults);
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
    const cwd =
      params.workspace.remotePath && params.workspace.remotePath.trim().length > 0
        ? params.workspace.remotePath.trim()
        : "/workspace";
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

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
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

      if (!podAlreadyKnownReady) {
        try {
          await sandboxCrOrchestrator.waitForCompletion(
            clients,
            namespace,
            lease.providerLeaseId,
            { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
          );
          readySandboxesByLease.add(lease.providerLeaseId);
        } catch (err) {
          if (err instanceof SandboxCrTimeoutError) {
            return {
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: `Sandbox pod did not become Ready within ${effectiveTimeoutMs}ms`,
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
          const flushResult = await execInPod(
            kc,
            namespace,
            podName,
            "agent",
            ["/bin/sh", "-c", script],
            base64Body,
            effectiveTimeoutMs,
          );
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
      // partial behaviour.
      const execCommand = wrapCommandWithEnv(baseExecCommand, params.env);

      let execResult: { exitCode: number; stdout: string; stderr: string };
      try {
        execResult = await execInPod(
          kc,
          namespace,
          podName,
          "agent",
          execCommand,
          typeof params.stdin === "string" ? params.stdin : undefined,
          effectiveTimeoutMs,
        );
      } catch (err) {
        // Watchdog-fired or WebSocket-setup error. Surface as a timeout so
        // the caller can retry instead of hanging forever.
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
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
        stderr: execResult.stderr,
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
        stderr: stderrChunks.join(""),
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
  },
});

export default plugin;
