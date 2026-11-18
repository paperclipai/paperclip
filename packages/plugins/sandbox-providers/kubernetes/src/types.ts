import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";
import { defaultQuotaForPods, type QuotaValues } from "./quota-math.js";

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
export const DEFAULT_QUOTA_PODS = 20;
export const DEFAULT_RESOURCE_QUOTA = defaultQuotaForPods(DEFAULT_QUOTA_PODS);

/** Default budget for a sandbox pod to become Ready before failing the run. */
export const DEFAULT_POD_READY_TIMEOUT_SEC = 90;

// Unset CPU/memory fields are derived from `pods` (and the per-pod defaults), so
// raising or lowering only `pods` keeps every pod the cap allows admissible.
export const resourceQuotaSchema = z
  .object({
    pods: z.string().regex(/^[1-9]\d*$/, "pods must be a positive integer").default(DEFAULT_RESOURCE_QUOTA.pods),
    requestsCpu: quantity.optional(),
    requestsMemory: quantity.optional(),
    limitsCpu: quantity.optional(),
    limitsMemory: quantity.optional(),
  })
  .transform((q): QuotaValues => {
    const derived = defaultQuotaForPods(Number(q.pods));
    // Saved configs written by the first plugin version carry its old default
    // CPU/memory values explicitly (20 CPU / 40Gi of limits, which admits 10
    // pods). Nobody chose those values, so treat that exact set as unset.
    // Matched on the four CPU/memory values only: an operator who raised just
    // `pods` under the old version also stored them untouched.
    if (
      q.requestsCpu === "10" &&
      q.requestsMemory === "20Gi" &&
      q.limitsCpu === "20" &&
      q.limitsMemory === "40Gi"
    ) {
      return derived;
    }
    return {
      pods: q.pods,
      requestsCpu: q.requestsCpu ?? derived.requestsCpu,
      requestsMemory: q.requestsMemory ?? derived.requestsMemory,
      limitsCpu: q.limitsCpu ?? derived.limitsCpu,
      limitsMemory: q.limitsMemory ?? derived.limitsMemory,
    };
  });

/**
 * EKS IAM auth (TECH-8817): the plugin worker signs a short-lived EKS token
 * with the server's own AWS identity (the ECS task role). Nothing secret is
 * stored; the endpoint and CA are public cluster facts.
 */
export const eksIamAuthSchema = z
  .object({
    type: z.literal("eks-iam"),
    clusterName: z.string().regex(/^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/, "Invalid EKS cluster name"),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "Invalid AWS region"),
    // The token is a bearer credential for the server's IAM identity; only an
    // EKS API endpoint may receive it.
    endpoint: z
      .string()
      .regex(/^https:\/\/[A-Za-z0-9.-]+\.eks\.amazonaws\.com(\.cn)?$/, "endpoint must be an https EKS API endpoint"),
    caData: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "caData must be the base64 cluster CA"),
  })
  .strict();

export type EksIamAuthConfig = z.infer<typeof eksIamAuthSchema>;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),
    auth: eksIamAuthSchema.optional(),

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
     * Escape hatch. Conversation pod reuse (one pod per conversation, idle TTL,
     * scrub between turns) is ON by default on every Kubernetes sandbox
     * environment; `false` gives conversation turns a fresh pod per run.
     * Deliberately unset by default (no zod default) so unset means ON.
     */
    conversationPodReuse: z.boolean().optional(),

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
    (cfg) => cfg.inCluster || cfg.kubeconfig || cfg.auth,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  )
  .refine(
    (cfg) => !cfg.auth || (!cfg.inCluster && !cfg.kubeconfig?.trim()),
    { message: "`auth` (eks-iam) cannot be combined with `inCluster` or `kubeconfig`" },
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
