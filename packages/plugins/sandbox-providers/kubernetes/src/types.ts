import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

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
}
