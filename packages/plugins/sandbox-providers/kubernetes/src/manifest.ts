import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.kubernetes-sandbox-provider";
const PLUGIN_VERSION = "0.1.0-alpha.4";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kubernetes Sandbox (alpha)",
  description:
    "Built on kubernetes-sigs/agent-sandbox (v1alpha1). ALPHA — expect breaking changes as the upstream CRD evolves. Falls back to stable batch/v1 Job mode for clusters without agent-sandbox installed. First-party Paperclip sandbox-provider plugin for Kubernetes.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "kubernetes",
      kind: "sandbox_provider",
      displayName: "Kubernetes",
      // The host may keep one pod alive per conversation between turns (idle TTL,
      // scrub on resume). Opt-in per environment through `reuseLease`; absent
      // `reuseLease` keeps every run on a fresh pod.
      sandboxCapabilities: { reusableLeases: true },
      description:
        "Dispatches agent runs in per-tenant Kubernetes namespaces. Default backend (sandbox-cr, alpha) uses kubernetes-sigs/agent-sandbox for multi-command exec; fallback backend (job) uses stable batch/v1 Job for clusters without agent-sandbox installed.",
      configSchema: {
        type: "object",
        properties: {
          inCluster: {
            type: "boolean",
            description:
              "When true, the plugin uses the in-pod ServiceAccount credentials. Requires paperclip-server to be running inside the target cluster.",
          },
          kubeconfig: {
            type: "string",
            format: "secret-ref",
            description:
              "Inline kubeconfig YAML. Paste a kubeconfig or an existing Paperclip secret reference; pasted values are stored as company secrets.",
          },
          namespacePrefix: {
            type: "string",
            description: "Prefix for the per-company tenant namespace (default: paperclip-).",
          },
          companySlug: {
            type: "string",
            description: "Override the auto-derived company slug used in the tenant namespace name.",
          },
          imageRegistry: {
            type: "string",
            description: "Override the default registry for agent runtime images (default: ghcr.io/paperclipai).",
          },
          imageAllowList: {
            type: "array",
            items: { type: "string" },
            description:
              "Glob patterns of allowed `target.imageOverride` values. Empty list = no override permitted.",
          },
          imagePullSecrets: {
            type: "array",
            items: { type: "string" },
            description: "Names of pre-created Docker image pull secrets in the tenant namespace.",
          },
          egressAllowFqdns: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional FQDNs to allow egress to from agent pods. Adapter-default FQDNs (e.g. api.anthropic.com) are added automatically.",
          },
          egressAllowCidrs: {
            type: "array",
            items: { type: "string" },
            description: "Additional CIDRs to allow egress to from agent pods.",
          },
          egressMode: {
            type: "string",
            enum: ["standard", "cilium"],
            description: "Network policy mode. `cilium` enables FQDN-based egress filtering via CiliumNetworkPolicy.",
          },
          runtimeClassName: {
            type: "string",
            description:
              "Optional RuntimeClass for pod isolation (e.g. `kata-fc` for Firecracker-backed microVMs). Cluster must have the RuntimeClass installed.",
          },
          serviceAccountAnnotations: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Annotations applied to the per-tenant ServiceAccount (e.g. `eks.amazonaws.com/role-arn` for IRSA).",
          },
          jobTtlSecondsAfterFinished: {
            type: "integer",
            minimum: 0,
            description: "Seconds after a Job completes before it is garbage-collected (default: 900).",
          },
          podActivityDeadlineSec: {
            type: "integer",
            minimum: 1,
            description: "Hard ceiling on a single run's wall-clock time (default: 3600).",
          },
          podReadyTimeoutSec: {
            type: "integer",
            minimum: 1,
            description:
              "Longest a run waits for its sandbox pod to become Ready before failing with a clear error (default: 90). Separate from the run timeout.",
          },
          reuseLease: {
            type: "boolean",
            description:
              "Keep a pod running between turns so later turns can reuse it (set by the host environment; default: false).",
          },
          conversationPodReuse: {
            type: "boolean",
            description:
              "Escape hatch. Reuse of one pod per agent conversation (5 minute idle TTL, scrubbed between turns) is ON by default; set false to give conversation turns a fresh pod per run.",
          },
          reuseLeaseScope: {
            type: "string",
            enum: ["all", "conversations"],
            description:
              "With reuseLease, `conversations` limits pod reuse to turns of an ongoing agent conversation (one pod per conversation).",
          },
          runnerIdleTimeoutMs: {
            type: "integer",
            minimum: 1000,
            description:
              "How long a kept-running conversation pod may sit idle before the plugin deletes it (default: 300000, 5 minutes).",
          },
          resourceQuota: {
            type: "object",
            description:
              "Per-company ResourceQuota for the tenant namespace. `pods` caps concurrent sandbox pods per company; a run that would exceed it fails fast with an over-capacity error (no queue). Changes are applied to existing namespaces on the next lease acquire.",
            properties: {
              pods: { type: "string", description: "Max concurrent pods per company (default: \"20\")." },
              requestsCpu: { type: "string", description: "Aggregate CPU requests (default: 250m x pods)." },
              requestsMemory: { type: "string", description: "Aggregate memory requests (default: 512Mi x pods)." },
              limitsCpu: { type: "string", description: "Aggregate CPU limits (default: 2 x pods; each pod defaults to a 2 CPU limit)." },
              limitsMemory: { type: "string", description: "Aggregate memory limits (default: 4Gi x pods; each pod defaults to a 4Gi limit)." },
            },
          },
          adapterType: {
            type: "string",
            description:
              "The adapter type that Jobs in this environment will run (e.g. `claude_local`, `codex_local`). Defaults to `claude_local`. Each environment is bound to one adapter; create multiple environments for different adapters.",
          },
          backend: {
            type: "string",
            enum: ["sandbox-cr", "job"],
            description:
              "sandbox-cr (default, alpha — requires kubernetes-sigs/agent-sandbox installed) | job (stable fallback — batch/v1 Job, one-shot entrypoint, no multi-command exec)",
          },
        },
        anyOf: [
          { required: ["inCluster"] },
          { required: ["kubeconfig"] },
        ],
      },
    },
  ],
};

export default manifest;
