import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

/** Default idle TTL for a reusable (kept-running) pod: 5 minutes. */
export const DEFAULT_REUSABLE_IDLE_TTL_MS = 300_000;

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

// Kubernetes resource.Quantity subset: plain/decimal numbers with an optional
// milli (`m`) or binary/decimal SI suffix, e.g. `10`, `500m`, `20Gi`, `1.5G`.
const quantityRegex = /^\d+(\.\d+)?(m|k|[KMGTPE]i?)?$/;
const quantity = z.string().regex(quantityRegex, "Invalid Kubernetes quantity");

/**
 * Per-company (tenant namespace) ResourceQuota. `pods` is the cap on concurrent
 * sandbox pods per company; the others bound aggregate CPU/memory.
 */
export const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
} as const;

/** Default budget for a sandbox pod to become Ready before failing the run. */
export const DEFAULT_POD_READY_TIMEOUT_SEC = 90;

export const resourceQuotaSchema = z.object({
  pods: z.string().regex(/^[1-9]\d*$/, "pods must be a positive integer").default(DEFAULT_RESOURCE_QUOTA.pods),
  requestsCpu: quantity.default(DEFAULT_RESOURCE_QUOTA.requestsCpu),
  requestsMemory: quantity.default(DEFAULT_RESOURCE_QUOTA.requestsMemory),
  limitsCpu: quantity.default(DEFAULT_RESOURCE_QUOTA.limitsCpu),
  limitsMemory: quantity.default(DEFAULT_RESOURCE_QUOTA.limitsMemory),
});

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),

    /**
     * Longest a run waits for its sandbox pod to become Ready. Independent of
     * (and normally far shorter than) the run timeout so a pod that can never
     * start (quota exhausted, unschedulable) fails the run in about a minute
     * instead of hanging for the whole adapter timeout.
     */
    podReadyTimeoutSec: z.number().int().positive().default(DEFAULT_POD_READY_TIMEOUT_SEC),

    /**
     * Host-owned retention flags. They must be part of this schema so they
     * survive config normalization on save: `onEnvironmentValidateConfig`
     * returns the parsed config, and a non-strict Zod object drops unknown keys.
     * The plugin never decides reuse itself; the server does.
     */
    reuseLease: z.boolean().default(false),
    reuseLeaseScope: z.enum(["all", "conversations"]).optional(),

    /**
     * How long a reusable (kept-running) pod may sit idle before the plugin
     * destroys it. Matches the host's `runnerIdleTimeoutMs` (default 5 minutes).
     */
    runnerIdleTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(DEFAULT_REUSABLE_IDLE_TTL_MS),

    /**
     * Per-company ResourceQuota applied to each tenant namespace. Changes are
     * reconciled onto existing namespaces on the next lease acquire.
     */
    resourceQuota: resourceQuotaSchema.default({}),

    /**
     * The adapter type that Jobs in this environment will run.
     * Each Kubernetes environment is bound to one adapter; create multiple
     * environments for different adapters.
     * Defaults to `"claude_local"`.
     */
    adapterType: z
      .string()
      .default("claude_local")
      .refine((v) => KNOWN_ADAPTER_TYPES.has(v), {
        message: "adapterType must be one of the known adapter types",
      }),

    /**
     * Optional declarative adapter registry. When present it is authoritative
     * for runtime image / envKeys / allowFqdns / probe / defaultEnv resolution
     * (replace semantics). Absent = built-in defaults.
     */
    adapters: adapterRegistrySchema.optional(),

    /**
     * The sandbox backend to use.
     *
     * - `"sandbox-cr"` (default, alpha) — uses the kubernetes-sigs/agent-sandbox
     *   Sandbox CRD (agents.x-k8s.io/v1alpha1). Creates a long-lived pod that
     *   paperclip-server can exec into for multi-command adapter-install workflows.
     *   Requires the agent-sandbox controller to be installed in the cluster.
     *
     * - `"job"` — uses batch/v1 Job (stable fallback). One-shot entrypoint; does
     *   NOT support multi-command exec. Use this for clusters without agent-sandbox
     *   installed, or when you need stable (non-alpha) k8s APIs.
     */
    backend: z.enum(["sandbox-cr", "job"]).default("sandbox-cr"),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  /** Name of the workload resource (Job name for job backend, Sandbox CR name for sandbox-cr backend). */
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  /** Which backend provisioned this lease. */
  backend: "sandbox-cr" | "job";
  scopedNetworkPolicyName: string | null;
  scopedNetworkEgress: {
    allowFqdns: string[];
    allowCidrs: string[];
  };
  /**
   * True when this lease's backend has NO data channel for the native file-sync
   * transport. Native sync streams over a pod exec, which only the `sandbox-cr`
   * backend exposes; the `job` backend carries no exec path, so its sync hook
   * rejects immediately. The server's per-lease sync-capability gate honors this
   * opt-out so a job lease keeps the byte-identical base64 fallback instead of
   * being routed to a native hook that would only error. Absent/false ⇒ native
   * sync may be used when the worker advertises the verbs.
   */
  nativeFileSyncUnsupported?: boolean;
  /**
   * The lease's remote working dir and native file-sync confinement root. Set at
   * acquire to the pod's /workspace mount; resume keeps an already-recorded
   * absolute dir and otherwise uses /workspace.
   */
  remoteCwd?: string;
}
