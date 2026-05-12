import { randomBytes } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
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
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { jobOrchestrator } from "./job-orchestrator.js";
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

// Resource quota defaults applied to every tenant namespace (M4b; tunable via
// config in a future milestone).
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

/**
 * Reads adapter env keys (e.g. ANTHROPIC_API_KEY) from the current process
 * environment. The plugin worker runs inside paperclip-server's pod, which has
 * these vars injected at deploy time.
 *
 * M4b approach: env vars sourced from process.env at acquire time.
 * TODO: future milestones may thread per-run secrets differently (e.g. via
 * a secret store reference on the environment config).
 */
function extractAdapterEnvFromProcess(envKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of envKeys) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
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
    return {
      ok: true,
      normalizedConfig: parsed.data as Record<string, unknown>,
    };
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
      adapterType: config.adapterType,
    });

    const image = resolveImage(
      { imageOverride: null },
      adapterDefaults,
      { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
    );

    const manifest = buildJobManifest({
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

    const { uid: ownerUid } = await jobOrchestrator.claim(clients, namespace, manifest);

    // M4b: adapter env vars are sourced from the plugin worker's own process
    // environment (paperclip-server pod has them injected at deploy time).
    const adapterEnv = extractAdapterEnvFromProcess(adapterDefaults.envKeys);
    const bootstrapToken = generateBootstrapToken();

    await createPerRunSecret(clients, {
      namespace,
      secretName,
      runId: params.runId,
      ownerKind: "Job",
      ownerApiVersion: "batch/v1",
      ownerName: jobName,
      ownerUid,
      bootstrapToken,
      adapterEnv,
    });

    const podName = await jobOrchestrator.findPod(clients, namespace, jobName);

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName,
      podName,
      secretName,
      phase: "Pending",
    };

    return {
      providerLeaseId: jobName,
      metadata: leaseMetadata as unknown as Record<string, unknown>,
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

    try {
      await jobOrchestrator.release(clients, namespace, params.providerLeaseId);
    } catch (err) {
      // If the Job is already gone (404), that's fine.
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { code?: number; statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    // For the Kubernetes Job-backed plugin, the container entrypoint is baked
    // into the Job spec (Tini + paperclip-agent-shim). We do NOT re-exec
    // command/args here — instead we wait for the already-running Job to
    // complete and collect its logs.
    //
    // params.command / params.args / params.stdin are intentionally ignored.
    // params.env is also not used here since secrets were injected via the
    // per-run Secret at acquireLease time.

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

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : config.podActivityDeadlineSec * 1000;

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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("did not complete within")) {
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
        : await jobOrchestrator.findPod(clients, namespace, lease.providerLeaseId);

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
      exitCode: timedOut ? null : (status?.phase === "Succeeded" ? 0 : 1),
      timedOut,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      metadata: {
        provider: "kubernetes",
        namespace,
        jobName: lease.providerLeaseId,
        podName: podName ?? null,
        phase: status?.phase ?? null,
      },
    };
  },
});

export default plugin;
