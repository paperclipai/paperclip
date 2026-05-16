import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.daytona-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Daytona Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions Daytona sandboxes as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "daytona",
      kind: "sandbox_provider",
      displayName: "Daytona Sandbox",
      description:
        "Provisions Daytona sandboxes with configurable image or snapshot selection, startup timeouts, and lease reuse.",
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Environment-specific Daytona API key. Paste a key or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to DAYTONA_API_KEY if omitted.",
          },
          apiUrl: {
            type: "string",
            description:
              "Optional Daytona API base URL. If omitted, the Daytona SDK uses its configured default endpoint.",
          },
          target: {
            type: "string",
            description: "Optional Daytona target/region identifier.",
          },
          snapshot: {
            type: "string",
            description: "Optional Daytona snapshot name to start from.",
          },
          image: {
            type: "string",
            description:
              "Optional base image or Daytona Image reference. If set, the sandbox is created from this image instead of a snapshot.",
          },
          language: {
            type: "string",
            description:
              "Optional Daytona language hint for direct code execution. If omitted, Daytona uses its default runtime.",
          },
          cpu: {
            type: "number",
            description: "Optional CPU allocation in cores.",
          },
          memory: {
            type: "number",
            description: "Optional memory allocation in GiB.",
          },
          disk: {
            type: "number",
            description: "Optional disk allocation in GiB.",
          },
          gpu: {
            type: "number",
            description: "Optional GPU allocation in units.",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout for Daytona create/start/stop/execute operations in milliseconds.",
            default: 300000,
          },
          autoStopInterval: {
            type: "number",
            description: "Optional Daytona auto-stop interval in minutes. `0` disables auto-stop.",
          },
          autoArchiveInterval: {
            type: "number",
            description: "Optional Daytona auto-archive interval in minutes. `0` uses Daytona's max interval.",
          },
          autoDeleteInterval: {
            type: "number",
            description:
              "Optional Daytona auto-delete interval in minutes. `-1` disables auto-delete and `0` deletes immediately after stop.",
          },
          reuseLease: {
            type: "boolean",
            description:
              "Whether to stop and later resume the sandbox across runs instead of deleting it on release.",
            default: false,
          },
        },
      },
    },
  ],
};

export default manifest;
