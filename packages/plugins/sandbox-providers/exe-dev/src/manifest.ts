import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.exe-dev-sandbox-provider";
const PLUGIN_VERSION = "0.1.1";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "exe.dev Sandbox Provider",
  description:
    "Sandbox provider plugin that provisions exe.dev VMs as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "exe-dev",
      kind: "sandbox_provider",
      displayName: "exe.dev VM",
      description:
        "Provisions exe.dev VMs through the HTTPS API, then runs commands over direct SSH for long-lived Paperclip workloads.",
      configSchema: {
        type: "object",
        properties: {
          // ---- Essentials (always visible, in this order) ----
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Paste your exe.dev API token, or pick a saved Paperclip secret. Create one at exe.dev → Settings → API tokens with `/exec` scope (`new`, `ls`, `rm`).",
          },
          sshPrivateKey: {
            type: "string",
            format: "secret-ref",
            maxLength: 8192,
            description:
              "Paste the SSH private key you registered with exe.dev, or pick a saved secret. Leave blank to fall back to an on-host key (see Advanced → SSH access).",
          },
          // ---- Advanced: SSH access ----
          sshUser: {
            type: "string",
            description:
              "Login user on the VM. Leave blank to use the image default, usually `root`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          sshIdentityFile: {
            type: "string",
            description:
              "Absolute path to a private key on the Paperclip host. Used only when SSH Private Key is empty.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          sshPort: {
            type: "number",
            description: "SSH port for direct VM access.",
            default: 22,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          strictHostKeyChecking: {
            type: "string",
            description:
              "Host key policy passed to ssh via StrictHostKeyChecking. Typical values are `accept-new`, `yes`, or `no`.",
            default: "accept-new",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "SSH access",
          },
          // ---- Advanced: VM resources ----
          image: {
            type: "string",
            description: "Optional container image to use when creating the VM.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM resources",
          },
          cpu: {
            type: "number",
            description: "Optional CPU count passed to `exe.dev new --cpu`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM resources",
          },
          memory: {
            type: "string",
            description: "Optional memory size such as `4GB`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM resources",
          },
          disk: {
            type: "string",
            description: "Optional disk size such as `20GB`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM resources",
          },
          // ---- Advanced: VM creation ----
          command: {
            type: "string",
            description: "Optional container command passed to `exe.dev new --command`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          env: {
            type: "object",
            description: "Optional environment variables applied at VM creation time.",
            additionalProperties: { type: "string" },
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          integrations: {
            type: "array",
            description: "Optional exe.dev integrations to attach during VM creation.",
            items: { type: "string" },
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          tags: {
            type: "array",
            description: "Optional tags to apply during VM creation.",
            items: { type: "string" },
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          setupScript: {
            type: "string",
            description: "Optional first-boot setup script passed to `exe.dev new --setup-script`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          prompt: {
            type: "string",
            description: "Optional Shelley prompt passed to `exe.dev new --prompt`.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          comment: {
            type: "string",
            description: "Optional short note attached to created VMs.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          namePrefix: {
            type: "string",
            description: "Optional prefix used when generating VM names.",
            default: "paperclip",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "VM creation",
          },
          // ---- Advanced: API + runtime ----
          apiUrl: {
            type: "string",
            description:
              "Optional exe.dev HTTPS API base URL or /exec endpoint. Defaults to https://exe.dev/exec.",
            "x-paperclip-advanced": true,
            "x-paperclip-group": "API + runtime",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout for VM lifecycle and SSH operations in milliseconds.",
            default: 300000,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "API + runtime",
          },
          reuseLease: {
            type: "boolean",
            description:
              "Whether to keep the VM alive between runs instead of deleting it on release.",
            default: false,
            "x-paperclip-advanced": true,
            "x-paperclip-group": "API + runtime",
          },
        },
      },
    },
  ],
};

export default manifest;
