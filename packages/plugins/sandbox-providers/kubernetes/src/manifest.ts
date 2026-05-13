import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.kubernetes-sandbox-provider";
const PLUGIN_VERSION = "0.1.0-alpha.1";

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
            pattern: "\\S",
            description:
              "Inline kubeconfig YAML. Paste a kubeconfig or an existing Paperclip secret reference; pasted values are stored as company secrets.",
          },
          namespacePrefix: {
            type: "string",
            maxLength: 20,
            description: "Prefix for the per-company tenant namespace (default: paperclip-).",
          },
          paperclipServerNamespace: {
            type: "string",
            maxLength: 63,
            pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
            description:
              "Namespace where paperclip-server pods run. Used by generated egress policies so agent pods can call back to the server (default: paperclip).",
          },
          companySlug: {
            type: "string",
            maxLength: 43,
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
            description: "Additional CIDRs to allow HTTPS egress to from agent pods. CIDR egress is restricted to TCP port 443.",
          },
          egressMode: {
            type: "string",
            enum: ["standard", "cilium"],
            description:
              "Network policy mode. `standard` uses NetworkPolicy and allows public HTTPS when adapter FQDNs are configured; `cilium` enables exact FQDN egress filtering via CiliumNetworkPolicy.",
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
          {
            properties: { inCluster: { const: true } },
            required: ["inCluster"],
          },
          { required: ["kubeconfig"] },
        ],
      },
    },
  ],
};

export default manifest;
