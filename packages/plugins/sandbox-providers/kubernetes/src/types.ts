import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/** Volumes and mount paths every agent pod already has (see pod-spec-builder.ts). */
export const BUILT_IN_VOLUME_NAMES: ReadonlySet<string> = new Set(["workspace", "home", "cache", "tmp"]);
export const BUILT_IN_MOUNT_PATHS: ReadonlySet<string> = new Set([
  "/workspace",
  "/home/paperclip",
  "/home/paperclip/.cache",
  "/tmp",
]);

/**
 * Volume sources an extra volume may use: exactly the types the Pod Security
 * "restricted" profile allows, which the tenant namespace enforces. Anything
 * else (hostPath, nfs, ...) would be refused at admission, so refuse it here.
 */
export const EXTRA_VOLUME_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "configMap",
  "csi",
  "downwardAPI",
  "emptyDir",
  "ephemeral",
  "persistentVolumeClaim",
  "projected",
  "secret",
]);

const dnsLabel = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "must be a DNS label");

/** A Kubernetes `Volume`: a name plus exactly one allowed source, passed through as given. */
const extraVolumeSchema = z
  .object({ name: dnsLabel })
  .catchall(z.record(z.string(), z.unknown()))
  .superRefine((volume, ctx) => {
    const sources = Object.keys(volume).filter((key) => key !== "name");
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: `extraVolumes "${volume.name}" must have exactly one volume source`,
      });
      return;
    }
    if (!EXTRA_VOLUME_SOURCE_TYPES.has(sources[0]!)) {
      ctx.addIssue({
        code: "custom",
        message: `extraVolumes "${volume.name}" uses "${sources[0]}"; allowed sources are ${[...EXTRA_VOLUME_SOURCE_TYPES].join(", ")}`,
      });
    }
  });

const extraVolumeMountSchema = z
  .object({
    name: dnsLabel,
    mountPath: z.string().regex(/^\/[^\0]*$/, "mountPath must be absolute"),
    subPath: z.string().optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();

const extraEnvSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env name must be a valid variable name"),
    value: z.string(),
  })
  .strict();

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

    /**
     * Extra pod volumes, container volumeMounts and container env added to
     * every agent pod, e.g. a shared package cache or a read-only git mirror on
     * a PersistentVolumeClaim in the tenant namespace. Off (empty) by default.
     * Each mount must name an extra volume; built-in volume names and mount
     * paths are reserved. `extraEnv` takes precedence over the run's secret
     * env (Kubernetes `env` beats `envFrom`); `HOME` is reserved.
     */
    extraVolumes: z.array(extraVolumeSchema).default([]),
    extraVolumeMounts: z.array(extraVolumeMountSchema).default([]),
    extraEnv: z.array(extraEnvSchema).default([]),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string(), z.string()).default({}),

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
  .superRefine((cfg, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const volumeNames = new Set<string>();
    for (const volume of cfg.extraVolumes) {
      if (BUILT_IN_VOLUME_NAMES.has(volume.name)) fail(`extraVolumes "${volume.name}" is a built-in volume name`);
      else if (volumeNames.has(volume.name)) fail(`extraVolumes "${volume.name}" is declared twice`);
      volumeNames.add(volume.name);
    }
    const mountPaths = new Set<string>();
    for (const mount of cfg.extraVolumeMounts) {
      const path = mount.mountPath.replace(/\/+$/, "") || "/";
      if (!volumeNames.has(mount.name)) fail(`extraVolumeMounts "${mount.name}" does not name an extra volume`);
      if (path === "/" || BUILT_IN_MOUNT_PATHS.has(path)) fail(`extraVolumeMounts path "${mount.mountPath}" is reserved`);
      else if (mountPaths.has(path)) fail(`extraVolumeMounts path "${mount.mountPath}" is mounted twice`);
      mountPaths.add(path);
    }
    const envNames = new Set<string>();
    for (const env of cfg.extraEnv) {
      if (env.name === "HOME") fail(`extraEnv "HOME" is reserved`);
      else if (envNames.has(env.name)) fail(`extraEnv "${env.name}" is set twice`);
      envNames.add(env.name);
    }
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
}
