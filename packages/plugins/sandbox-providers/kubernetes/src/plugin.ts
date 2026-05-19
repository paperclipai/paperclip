import { randomBytes } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { getAdapterDefaults } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { buildSandboxCrManifest } from "./sandbox-cr-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import { jobOrchestrator, JobTimeoutError } from "./job-orchestrator.js";
import {
  sandboxCrOrchestrator,
  SandboxCrReadinessError,
  SandboxCrTimeoutError,
} from "./sandbox-cr-orchestrator.js";
import { execInPod } from "./pod-exec.js";
import { shellQuoteArg } from "./shell-utils.js";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  newRunUlidDns,
  paperclipLabels,
} from "./utils.js";

// Name of the ServiceAccount created inside each tenant namespace by ensureTenant.
const TENANT_SERVICE_ACCOUNT = "paperclip-tenant-sa";

// Resource quota defaults applied to every tenant namespace (M4b; tunable via
// config in a future milestone).
const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
};

const UPLOAD_INTERCEPTOR_TTL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_INTERCEPTORS = 1000;

interface UploadInterceptorEntry {
  interceptor: FastUploadInterceptor;
  lastTouchedAt: number;
}

const uploadInterceptorsByLease = new Map<string, UploadInterceptorEntry>();

function getOrCreateUploadInterceptor(leaseId: string): FastUploadInterceptor {
  const now = Date.now();
  sweepUploadInterceptors(now);

  let entry = uploadInterceptorsByLease.get(leaseId);
  if (!entry) {
    entry = { interceptor: new FastUploadInterceptor(), lastTouchedAt: now };
    uploadInterceptorsByLease.set(leaseId, entry);
  } else {
    entry.lastTouchedAt = now;
  }

  evictOldestUploadInterceptors();
  return entry.interceptor;
}

function sweepUploadInterceptors(now = Date.now()): void {
  for (const [leaseId, entry] of uploadInterceptorsByLease.entries()) {
    if (now - entry.lastTouchedAt > UPLOAD_INTERCEPTOR_TTL_MS) {
      uploadInterceptorsByLease.delete(leaseId);
    }
  }
}

function evictOldestUploadInterceptors(): void {
  while (uploadInterceptorsByLease.size > MAX_UPLOAD_INTERCEPTORS) {
    let oldestLeaseId: string | null = null;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [leaseId, entry] of uploadInterceptorsByLease.entries()) {
      if (entry.lastTouchedAt < oldestTouchedAt) {
        oldestLeaseId = leaseId;
        oldestTouchedAt = entry.lastTouchedAt;
      }
    }
    if (!oldestLeaseId) return;
    uploadInterceptorsByLease.delete(oldestLeaseId);
  }
}

function extractShellScript(
  params: Pick<PluginEnvironmentExecuteParams, "args" | "command">,
): string | null {
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const args = Array.isArray(params.args) ? params.args : [];
  const isShell = command === "sh" || command === "bash" || command.endsWith("/sh") || command.endsWith("/bash");
  if (isShell && args[0] === "-c" && typeof args[1] === "string") {
    return args[1];
  }
  return null;
}

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

/**
 * Reads adapter env keys (e.g. ANTHROPIC_API_KEY) from the current process
 * environment. The plugin worker runs inside paperclip-server's pod, which has
 * these vars injected at deploy time.
 *
 * M4b approach: env vars sourced from process.env at acquire time.
 * TODO: future milestones may thread per-run secrets differently (e.g. via
 * a secret store reference on the environment config).
 */
export function extractAdapterEnvFromProcess(
  envKeys: string[],
  warn: (message: string) => void = console.warn,
): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of envKeys) {
    const v = process.env[k];
    if (v !== undefined) {
      out[k] = v;
    } else {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    warn(
      `[plugin-kubernetes] adapter environment variable(s) missing from plugin worker process: ${missing.join(", ")}. Agent pods may fail provider authentication unless these keys are optional for the selected adapter.`,
    );
  }
  return out;
}

export function buildSandboxExecCommand(
  params: Pick<PluginEnvironmentExecuteParams, "args" | "command">,
): string[] {
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const args = Array.isArray(params.args) ? params.args : [];

  if (command.length > 0 && args.length > 0) {
    return [command, ...args];
  }
  if (command.length > 0) {
    return ["/bin/sh", "-lc", command];
  }
  if (args.length > 0) {
    return ["/bin/sh", "-lc", args.map(shellQuoteArg).join(" ")];
  }
  return ["/bin/sh", "-l"];
}

export function deriveUploadTargetDir(targetPath: string): string {
  const slashIndex = targetPath.lastIndexOf("/");
  return slashIndex >= 0 ? targetPath.slice(0, slashIndex) || "/" : ".";
}

export function buildSandboxExecShellCommand(
  params: Pick<PluginEnvironmentExecuteParams, "args" | "command">,
): string {
  if (typeof params.command === "string" && params.command.trim().length > 0) {
    return params.command;
  }

  return params.args?.map(shellQuoteArg).join(" ") ?? "";
}

function generateBootstrapToken(): string {
  // TODO: paperclip-server's actual callback auth scheme is separate and is
  // out of M4b scope. This per-run random token is stored in the per-run
  // Secret and consumed by paperclip-agent-shim for initial registration.
  return randomBytes(32).toString("hex");
}

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
    const adapterDefaults = getAdapterDefaults(cfg.adapterType);
    const totalFqdns = [...adapterDefaults.allowFqdns, ...cfg.egressAllowFqdns];
    if (cfg.egressMode === "standard" && totalFqdns.length > 0) {
      warnings.push(
        `egressMode=standard cannot enforce FQDN-based egress rules for ${totalFqdns.join(", ")}. Agent pods will get public IPv4 HTTPS egress with private/link-local ranges excluded. Switch egressMode to "cilium" for exact FQDN enforcement.`,
      );
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
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);

    // Emit a runtime warning if FQDNs are configured but egressMode=standard
    // cannot enforce them. Mirrors the validateConfig warning so operators see
    // it in paperclip-server logs even if they missed the validation step.
    const adapterDefaultsForWarn = getAdapterDefaults(config.adapterType);
    const totalFqdnsForWarn = [...adapterDefaultsForWarn.allowFqdns, ...config.egressAllowFqdns];
    if (config.egressMode === "standard" && totalFqdnsForWarn.length > 0) {
      // The SDK does not currently thread ctx.logger into environment hooks.
      // Keep this explicit so operators still see the standard-mode egress
      // trade-off in raw worker logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules for ${totalFqdnsForWarn.join(", ")}. Agent pods will get public IPv4 HTTPS egress with private/link-local ranges excluded. Switch egressMode to "cilium" for exact FQDN enforcement.`,
      );
    }

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    // Ensure the tenant namespace and all its RBAC / network policy resources
    // exist before we try to create the Job.
    const adapterDefaults = getAdapterDefaults(config.adapterType);

    await ensureTenant(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: config.paperclipServerNamespace,
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
      adapterType: config.adapterType,
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
          adapterType: config.adapterType,
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
          adapterType: config.adapterType,
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

    // M4b: adapter env vars are sourced from the plugin worker's own process
    // environment (paperclip-server pod has them injected at deploy time).
    const adapterEnv = extractAdapterEnvFromProcess(adapterDefaults.envKeys);
    const bootstrapToken = generateBootstrapToken();

    // Secret ownerRef: for job backend, the Job owns the Secret (cascade delete).
    // For sandbox-cr backend, the Sandbox CR owns the Secret.
    // NOTE: For sandbox-cr, if the Secret outlives the Sandbox due to a cluster
    // quirk, the release() call will still clean it up via namespace GC or
    // explicit delete in a future milestone.
    try {
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
    } catch (err) {
      try {
        await orchestrator.release(clients, namespace, jobName);
      } catch (cleanupErr) {
        throw new Error(
          `Kubernetes lease setup failed and cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          { cause: err },
        );
      }
      throw err;
    }
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

    uploadInterceptorsByLease.delete(params.providerLeaseId);

    try {
      await releaseOrchestrator.release(clients, namespace, params.providerLeaseId);
    } catch (err) {
      // If the resource is already gone (404), that's fine.
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { code?: number; statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
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
      // 1. Ensure the Sandbox pod is Ready (wait if needed).
      // 2. Exec the command into the running pod.
      // 3. Return exec result directly (no log scraping needed).
      const executeStartedAt = Date.now();

      let podName =
        typeof lease.metadata?.podName === "string" && lease.metadata.podName
          ? lease.metadata.podName
          : null;

      // Wait for pod Ready if we don't have a pod name yet (or as a health check).
      try {
        await sandboxCrOrchestrator.waitForCompletion(
          clients,
          namespace,
          lease.providerLeaseId,
          { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
        );
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
        if (err instanceof SandboxCrReadinessError) {
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
              sandboxPhase: err.phase,
              ...(err.reason ? { sandboxReason: err.reason } : {}),
            },
          };
        }
        throw err;
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

      const remainingTimeoutMs = Math.max(1, effectiveTimeoutMs - (Date.now() - executeStartedAt));

      const shellScript = extractShellScript(params);
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
          const base64Body = decision.flush.payload.toString("base64");
          const dir = deriveUploadTargetDir(decision.flush.targetPath);
          const script =
            `mkdir -p ${shellQuoteArg(dir)} && ` +
            `base64 -d > ${shellQuoteArg(decision.flush.targetPath)}`;
          const flushResult = await execInPod(
            kc,
            namespace,
            podName,
            "agent",
            ["/bin/sh", "-c", script],
            base64Body,
            remainingTimeoutMs,
          );
          return {
            exitCode: flushResult.exitCode,
            timedOut: flushResult.timedOut,
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
        if (decision.action === "error") {
          return {
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: decision.message,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "error",
            },
          };
        }
      }

      const execCommand = buildSandboxExecCommand(params);
      const execResult = await execInPod(
        kc,
        namespace,
        podName,
        "agent",
        execCommand,
        typeof params.stdin === "string" ? params.stdin : undefined,
        remainingTimeoutMs,
      );

      return {
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
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
