import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.kubernetes-sandbox-provider";
// Keep in step with the package.json "version" field: paperclip-server registers
// the plugin under THIS value, so the two disagreeing makes the installed
// package and the registered plugin report different versions.
const PLUGIN_VERSION = "0.2.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kubernetes Sandbox",
  description:
    "Self-hostable Kubernetes sandbox provider. The default backend (sandbox-cr) runs agent pods through the kubernetes-sigs/agent-sandbox controller, addressing whichever API version the cluster serves (v1beta1 preferred, v1alpha1 for older controllers). The job backend uses batch/v1 Job for dispatch-only clusters without that controller. First-party Paperclip sandbox-provider plugin for Kubernetes.",
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
        "Dispatches agent runs in per-tenant Kubernetes namespaces, each with its own ServiceAccount, RBAC, quotas and deny-all network baseline. The default backend (sandbox-cr) uses kubernetes-sigs/agent-sandbox for multi-command exec; the job backend uses batch/v1 Job for clusters without that controller.",
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
          adapterType: {
            type: "string",
            description:
              "The adapter type that Jobs in this environment will run (e.g. `claude_local`, `codex_local`). Defaults to `claude_local`. Each environment is bound to one adapter; create multiple environments for different adapters.",
          },
          backend: {
            type: "string",
            enum: ["sandbox-cr", "job"],
            description:
              "sandbox-cr (default — requires the kubernetes-sigs/agent-sandbox controller; the plugin addresses whichever version the cluster serves, v1beta1 preferred with v1alpha1 fallback) | job (batch/v1 Job, dispatch-only: the entrypoint runs once and exits, so no multi-command exec and no native file sync)",
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
