import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.docker-sandbox-provider",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Docker Sandbox Provider",
  description: "Runs each Paperclip lease in an isolated, least-privilege Docker container.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "docker",
    kind: "sandbox_provider",
    displayName: "Docker Sandbox Provider",
    description: "Creates fresh, labeled Docker containers with loopback-only runtime service publication.",
    supportsReusableLeases: false,
    configSchema: {
      type: "object",
      properties: {
        image: { type: "string", default: "paperclip-noble-qa:24.04" },
        timeoutMs: { type: "number", default: 300000 },
        memoryMb: { type: "number", default: 2048 },
        cpus: { type: "number", default: 2 },
        pidsLimit: { type: "number", default: 512 }
      },
      required: ["image"]
    }
  }]
};

export default manifest;
