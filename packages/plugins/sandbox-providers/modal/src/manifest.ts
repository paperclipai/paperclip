import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.modal-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Modal Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions Modal sandboxes as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "modal",
      kind: "sandbox_provider",
      displayName: "Modal Sandbox",
      description:
        "Provisions Modal sandboxes with configurable image, app, auth, timeouts, and network controls.",
      configSchema: {
        type: "object",
        required: ["appName", "image"],
        properties: {
          appName: {
            type: "string",
            description:
              "Modal App name used as the parent for sandboxes. The plugin calls `modal.apps.fromName(appName, { createIfMissing: true })`, so the App is created on first acquire if it does not already exist.",
          },
          image: {
            type: "string",
            description:
              "Container image reference passed to `modal.images.fromRegistry()`, e.g. `python:3.13` or `node:20`.",
          },
          tokenId: {
            type: "string",
            format: "secret-ref",
            description:
              "Modal token ID. Paste a token or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Required.",
          },
          tokenSecret: {
            type: "string",
            format: "secret-ref",
            description: "Modal token secret paired with tokenId. Required.",
          },
          environment: {
            type: "string",
            description:
              "Optional Modal environment name. Falls back to the SDK profile default.",
          },
          workdir: {
            type: "string",
            description: "Remote working directory inside the sandbox.",
            default: "/workspace/paperclip",
          },
          sandboxTimeoutMs: {
            type: "number",
            description:
              "Maximum sandbox lifetime in milliseconds. Must be a positive multiple of 1000 between 1000 and 86400000 (24 hours).",
            default: 3_600_000,
          },
          idleTimeoutMs: {
            type: "number",
            description:
              "Optional idle timeout in milliseconds. When set, Modal terminates the sandbox if no exec is active for this duration. Must be a positive multiple of 1000.",
          },
          execTimeoutMs: {
            type: "number",
            description:
              "Default per-exec timeout in milliseconds when the caller does not provide one. Must be a positive multiple of 1000.",
            default: 300_000,
          },
          blockNetwork: {
            type: "boolean",
            description: "Whether to block all egress network access from the sandbox.",
            default: false,
          },
          cidrAllowlist: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of CIDRs the sandbox is allowed to reach. Cannot be combined with blockNetwork.",
          },
          reuseLease: {
            type: "boolean",
            description:
              "When true, the sandbox is detached (not terminated) on release and resumed by id later. Reuse relies on Modal's sandbox lifetime and idle timeout because Modal has no separate pause primitive.",
            default: false,
          },
        },
      },
    },
  ],
};

export default manifest;
