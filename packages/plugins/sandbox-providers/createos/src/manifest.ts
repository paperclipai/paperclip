import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.createos-sandbox-provider",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "CreateOS Sandbox Provider",
  description: "Runs Paperclip agents in CreateOS sandboxes.",
  author: "CreateOS",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "createos",
    kind: "sandbox_provider",
    displayName: "CreateOS Sandbox",
    description: "CreateOS sandboxes with live command output and optional pause/resume reuse.",
    supportsReusableLeases: true,
    sandboxCapabilities: { incrementalSessionOutput: true },
    configSchema: {
      type: "object",
      required: ["apiUrl", "shape"],
      properties: {
        apiUrl: { type: "string", title: "API URL", default: "https://api.sb.createos.sh", description: "https://api.sb.createos.sh" },
        apiKey: { type: "string", format: "secret-ref", description: "CreateOS API key or Paperclip secret reference. Saved keys become company secrets. Falls back to CREATEOS_API_KEY." },
        shape: {
          type: "string",
          title: "Shape",
          description: "Choose the sandbox CPU and memory size.",
          // Published catalog from https://api.sb.createos.sh/v1/shapes.
          enum: [
            "s-1vcpu-256mb", "s-0.25vcpu-512mb", "s-0.5vcpu-1gb",
            "s-1vcpu-1gb", "s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb",
            "s-4vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-8gb", "s-8vcpu-16gb",
          ],
        },
        rootfs: { type: "string", description: "Root filesystem or ready template ID/name. Omit to use the provider default. The image must supply Bash and the selected agent runtime dependencies." },
        region: { type: "string", description: "Optional region; must match the API endpoint's region." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 86400000, default: 300000, description: "Operation and default command timeout in milliseconds. This is not a sandbox lifetime." },
        reuseLease: { type: "boolean", default: false, description: "Pause the sandbox after a run and resume it for subsequent runs instead of deleting it." },
      },
    },
  }],
};

export default manifest;
