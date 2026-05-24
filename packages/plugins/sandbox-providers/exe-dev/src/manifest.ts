import type { ValadrienOsPluginManifestV1 } from "@valadrien-os/plugin-sdk";

const PLUGIN_ID = "valadrien-os.exe-dev-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: ValadrienOsPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "exe.dev Sandbox Provider",
  description:
    "Sandbox provider plugin that provisions exe.dev VMs as ValadrienOs execution environments.",
  author: "ValadrienOs",
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
        "Provisions exe.dev VMs through the HTTPS API, then runs commands over direct SSH for long-lived ValadrienOs workloads.",
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            format: "secret-ref",
            description:
              "Environment-specific exe.dev API token. Needs `/exec` permission for at least `new`, `ls`, and `rm`. Paste a token or an existing ValadrienOs secret reference; saved environments store pasted values as company secrets. Falls back to EXE_API_KEY if omitted.",
          },
          apiUrl: {
            type: "string",
            description:
              "Optional exe.dev HTTPS API base URL or /exec endpoint. Defaults to https://exe.dev/exec.",
          },
          namePrefix: {
            type: "string",
            description: "Optional prefix used when generating VM names.",
            default: "valadrien-os",
          },
          image: {
            type: "string",
            description: "Optional container image to use when creating the VM.",
          },
          command: {
            type: "string",
            description: "Optional container command passed to `exe.dev new --command`.",
          },
          cpu: {
            type: "number",
            description: "Optional CPU count passed to `exe.dev new --cpu`.",
          },
          memory: {
            type: "string",
            description: "Optional memory size such as `4GB`.",
          },
          disk: {
            type: "string",
            description: "Optional disk size such as `20GB`.",
          },
          comment: {
            type: "string",
            description: "Optional short note attached to created VMs.",
          },
          env: {
            type: "object",
            description: "Optional environment variables applied at VM creation time.",
            additionalProperties: { type: "string" },
          },
          integrations: {
            type: "array",
            description: "Optional exe.dev integrations to attach during VM creation.",
            items: { type: "string" },
          },
          tags: {
            type: "array",
            description: "Optional tags to apply during VM creation.",
            items: { type: "string" },
          },
          setupScript: {
            type: "string",
            description: "Optional first-boot setup script passed to `exe.dev new --setup-script`.",
          },
          prompt: {
            type: "string",
            description: "Optional Shelley prompt passed to `exe.dev new --prompt`.",
          },
          timeoutMs: {
            type: "number",
            description: "Timeout for VM lifecycle and SSH operations in milliseconds.",
            default: 300000,
          },
          reuseLease: {
            type: "boolean",
            description:
              "Whether to keep the VM alive between runs instead of deleting it on release.",
            default: false,
          },
          sshUser: {
            type: "string",
            description: "Optional SSH username for direct VM access.",
          },
          sshPrivateKey: {
            type: "string",
            format: "secret-ref",
            maxLength: 4096,
            description:
              "Optional exe.dev-registered SSH private key. Paste the private key or an existing ValadrienOs secret reference; saved environments store pasted values as company secrets. If omitted, ValadrienOs falls back to sshIdentityFile, then the host's default SSH agent/keychain.",
          },
          sshIdentityFile: {
            type: "string",
            description:
              "Optional absolute path to the SSH private key the ValadrienOs host should use for VM access when sshPrivateKey is omitted. Leave both blank to rely on the host's default SSH agent/keychain.",
          },
          sshPort: {
            type: "number",
            description: "SSH port for direct VM access.",
            default: 22,
          },
          strictHostKeyChecking: {
            type: "string",
            description:
              "Host key policy passed to ssh via StrictHostKeyChecking. Typical values are `accept-new`, `yes`, or `no`.",
            default: "accept-new",
          },
        },
      },
    },
  ],
};

export default manifest;
