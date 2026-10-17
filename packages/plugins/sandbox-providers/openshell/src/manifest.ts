import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.openshell-sandbox-provider";
export const PLUGIN_VERSION = "0.1.0-alpha.1";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  displayName: "NVIDIA OpenShell Sandbox Provider",
  version: PLUGIN_VERSION,
  author: "Paperclip Contributors",
  categories: ["workspace"],
  description:
    "Runs Paperclip agent heartbeats inside NVIDIA OpenShell sandboxed containers " +
    "with policy-enforced filesystem, network, process, and inference controls. " +
    "Requires a pre-deployed OpenShell gateway reachable from the Paperclip server.",
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "openshell",
      kind: "sandbox_provider",
      displayName: "NVIDIA OpenShell",
      description:
        "Dispatches agent runs into NVIDIA OpenShell sandboxed containers via direct gRPC. " +
        "Each run creates an isolated sandbox pod with supervisor-enforced security policies.",
      configSchema: {
        type: "object",
        required: ["gatewayEndpoint"],
        properties: {
          gatewayEndpoint: {
            type: "string",
            description:
              "OpenShell gateway gRPC endpoint (host:port). " +
              "Example: openshell.openshell.svc:8080",
          },
          useTls: {
            type: "boolean",
            description:
              "Enable TLS for gRPC connections to the gateway. " +
              "Defaults to true. Disabling requires allowInsecure=true.",
            default: true,
          },
          allowInsecure: {
            type: "boolean",
            description:
              "Acknowledge insecure plaintext gRPC when useTls is false. " +
              "Must be explicitly set to true alongside useTls=false. " +
              "Intended only for trusted in-cluster networks.",
            default: false,
          },
          caCert: {
            type: "string",
            format: "secret-ref",
            description:
              "CA certificate PEM for verifying the gateway TLS certificate. " +
              "Only used when useTls is true.",
          },
          sandboxImage: {
            type: "string",
            description: "Default OCI image for sandbox containers.",
            default: "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
          },
          workspacePath: {
            type: "string",
            description: "Remote working directory inside sandboxes.",
            default: "/workspace",
          },
          defaultPolicy: {
            type: "object",
            description:
              "SandboxPolicy applied to every sandbox. Overrides the built-in " +
              "permissive default. See OpenShell docs for schema.",
          },
          gpu: {
            type: "boolean",
            description: "Request GPU resources for sandboxes.",
            default: false,
          },
          gpuCount: {
            type: "integer",
            minimum: 1,
            description: "Number of GPUs when gpu is true.",
            default: 1,
          },
          timeoutSeconds: {
            type: "integer",
            minimum: 1,
            description: "Maximum sandbox lifetime in seconds.",
            default: 3600,
          },
          labels: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra labels applied to every sandbox.",
            default: {},
          },
        },
      },
    },
  ],
};

export default manifest;
