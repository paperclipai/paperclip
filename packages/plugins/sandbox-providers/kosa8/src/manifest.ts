import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.kosa8-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "kosa8 Sandbox Provider",
  description:
    "Sandbox provider plugin that runs Paperclip environments on kosa8 microVM sandboxes, with sleep and wake for reused leases.",
  author: "kosa8",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "kosa8",
      kind: "sandbox_provider",
      displayName: "kosa8 Sandbox",
      description:
        "Creates a kosa8 microVM sandbox for each run. With reuse on, the sandbox sleeps after a run and wakes with its disk, memory and processes for the next run.",
      sandboxCapabilities: { reusableLeases: true },
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Paste a kosa8 Cloud API key (`k8c_live_...`) or pick a saved Paperclip secret. Create one at https://app.kosa8.com. The key decides which organization the sandboxes belong to.",
          },
          reuseLease: {
            type: "boolean",
            description:
              "Put the sandbox to sleep after a run and wake it for the next run on the same issue, instead of deleting it. Disk, memory and running processes are kept.",
            default: false,
          },
          size: {
            type: "string",
            enum: ["2x4", "4x8", "8x16", "16x32"],
            description:
              "Sandbox size as vCPU x GiB of memory. Leave blank for 2x4. A template or a snapshot keeps its own size.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          image: {
            type: "string",
            description:
              "Optional OCI image to run. Leave blank for the kosa8 universal image (Ubuntu 24.04 with Node, Python, git, tar and the common agent CLIs).",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          template: {
            type: "string",
            description: "Optional kosa8 template key or kosa8 Store item. Do not set it together with size, image or snapshot.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          snapshot: {
            type: "string",
            description:
              "Optional snapshot ID (`snap_...`) to start each run from, for example a sandbox with your tools and repository in place. Do not set it together with size, image or template.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          region: {
            type: "string",
            description: "Optional region ID, for example `us-ash1` or `eu-hel1`. Leave blank for the organization default.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          egressAllow: {
            type: "string",
            description:
              "Optional comma-separated list of hosts or CIDRs the sandbox can reach, for example `api.anthropic.com,*.github.com,registry.npmjs.org`. kosa8 refuses all other outbound traffic on the host. Leave blank for the organization default policy.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Network",
          },
          apiUrl: {
            type: "string",
            description: "kosa8 Cloud API URL. Leave blank for https://api.kosa8.com or KOSA8_API_URL.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          namePrefix: {
            type: "string",
            description: "Prefix for sandbox names.",
            default: "paperclip",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Sandbox",
          },
          timeoutMs: {
            type: "number",
            description: "Default command timeout in milliseconds. Paperclip also uses it as the default run timeout for this environment.",
            default: 3600000,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "Runtime",
          },
        },
      },
    },
  ],
};

export default manifest;
