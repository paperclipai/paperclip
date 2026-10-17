import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.smolmachines-sandbox-provider",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Smol Machines Sandbox Provider",
  description: "Run Paperclip agents in isolated SmolVMs on your computer or Smol Cloud.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "smolmachines",
    kind: "sandbox_provider",
    displayName: "Smol Machines VM",
    description: "Isolated agent VMs with local and Cloud targets and per-run leases.",
    configSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["local", "cloud"], default: "local", description: "Run on this host or in Smol Cloud." },
        apiKey: { type: "string", format: "secret-ref", description: "Smol Cloud API key. Store it as a Paperclip company secret. When omitted, use SMOL_CLOUD_TOKEN or a CLI session." },
        image: { type: "string", description: "Optional OCI image override. By default, choose Paperclip's agent runtime image for this run's adapter." },
        cpus: { type: "number", default: 2, description: "VM CPU count." },
        memoryMb: { type: "number", default: 2048, description: "VM memory in MB." },
        ttlSeconds: { type: "number", default: 3600, description: "Cloud VM lifetime in seconds. Set this longer for long runs." },
        reuseLease: { type: "boolean", default: false, description: "Stop and reuse the same VM on later runs. By default, delete it after each run." }
      }
    }
  }]
};

export default manifest;
