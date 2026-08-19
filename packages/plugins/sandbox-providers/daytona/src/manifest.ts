import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.daytona-sandbox-provider";
// 0.1.3 renames the login transport flag from `supportsSetupTokenLogin` to the
// neutral `supportsLoginPty`. The boot reconcile reads the persisted manifest
// raw and does not re-run the validator, so it never canonicalizes the old
// name. The version bump makes the reconcile refresh the persisted manifest for
// an existing install, so the renamed capability propagates.
const PLUGIN_VERSION = "0.1.3";

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
      supportsReusableLeases: true,
      // Daytona keeps a persistent session and tails its callback log form, so it
      // emits incremental session output while the command runs. Declare the
      // opt-in capability so the host selects the session-output streaming path.
      // A generic one-shot provider that omits this key keeps the poll path.
      sandboxCapabilities: {
        incrementalSessionOutput: true,
      },
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      templateRefKind: "snapshot",
      templateConfigBinding: {
        field: "snapshot",
        unsetFields: ["image"],
      },
      templateIdentityPaths: ["apiUrl"],
      supportsTemplateDelete: true,
      // Daytona hosts an interactive login on a real pseudo-terminal. It is the
      // only bundled provider that implements the login pseudo-terminal methods,
      // so it advertises the capability.
      supportsLoginPty: true,
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
            default: "daytonaio/sandbox:0.8.0",
          },
          language: {
            type: "string",
            description:
              "Optional Daytona language hint for direct code execution. If omitted, Daytona uses its default runtime.",
          },
          cpu: {
            type: "integer",
            description: "Optional CPU allocation in cores.",
            minimum: 1,
            default: 4,
          },
          memory: {
            type: "integer",
            description:
              "Optional memory allocation in GiB. Supported sandbox sizes are 1, 2, 4, and 8 GiB.",
            enum: [1, 2, 4, 8],
            default: 4,
          },
          disk: {
            type: "integer",
            description: "Optional disk allocation in GiB.",
            minimum: 1,
            default: 10,
          },
          gpu: {
            type: "integer",
            description: "Optional GPU allocation in units.",
            minimum: 1,
          },
          timeoutMs: {
            type: "number",
            description: "Timeout for Daytona create/start/stop/execute operations in milliseconds.",
            default: 300000,
          },
          livenessTimeoutMs: {
            type: "number",
            description:
              "Per-call timeout in milliseconds for the sandbox liveness read (refreshData). A silently unresponsive sandbox connection surfaces as a fast error instead of stalling until the outer RPC ceiling. The start and recovery calls derive their own deadline from timeoutMs, not this bound. `0` or less disables the bound. Defaults to 30000 when unset.",
            default: 30000,
          },
          autoStopInterval: {
            type: "number",
            description:
              "Daytona auto-stop interval in minutes. `0` disables auto-stop. Defaults to 15 when unset.",
            default: 15,
          },
          autoArchiveInterval: {
            type: "number",
            description:
              "Daytona auto-archive interval in minutes. Stopped sandboxes still count against the storage quota until archived, so this defaults to 60 when unset. `0` uses Daytona's max interval.",
            default: 60,
          },
          autoDeleteInterval: {
            type: "number",
            description:
              "Daytona auto-delete interval in minutes. Backstop reaper for sandboxes nobody resumes; defaults to 10080 (7 days) when unset. `-1` disables auto-delete and `0` deletes immediately after stop.",
            default: 10080,
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
