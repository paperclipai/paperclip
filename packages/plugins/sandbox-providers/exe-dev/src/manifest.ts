import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.exe-dev-sandbox-provider", apiVersion: 1, version: "0.2.0",
  displayName: "exe.dev (experimental)",
  description: "Durable, private exe.dev VMs shared by a trusted group of agents.",
  author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "exe-dev", kind: "sandbox_provider", displayName: "exe.dev VM (experimental)",
    description: "One persistent VM per environment; independent agent homes and workspaces. Disconnecting keeps the VM.",
    supportsReusableLeases: true,
    sandboxCapabilities: {
      reusableLeases: true, persistentProcessSessions: true, independentControlCommands: true,
      incrementalSessionOutput: true, duplexCommandStream: true,
      nativeSyncIn: false, nativeSyncOut: false, concurrentSyncOperations: false, runnerWebSocketIngress: false,
    },
    configSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["attach", "create"], default: "attach", description: "Attach a compatible VM or create one from a pinned Paperclip image." },
        vmName: { type: "string", description: "Durable VM name. Required for attach; create derives a stable name when omitted." },
        sshPrivateKey: { type: "string", format: "secret-ref", maxLength: 8192, description: "Private SSH key registered with exe.dev. Stored as a Paperclip secret." },
        image: { type: "string", description: "Published Paperclip exe.dev image with @sha256 digest. Required to create; never installed or upgraded at boot." },
        registryAuth: { type: "string", format: "secret-ref", description: "Optional private registry credential in username:token format, used by exe.dev only while pulling the VM image." },
        knownHosts: { type: "string", description: "Optional verified OpenSSH known_hosts entries for exe.dev and the VM. Pins host keys with strict checking." },
        sshIdentityFile: { type: "string", description: "Optional absolute key path on the Paperclip host.", "x-paperclip-advanced": true },
        strictHostKeyChecking: { type: "string", enum: ["yes", "accept-new"], default: "accept-new", description: "First-use keys are persisted on the controller; changed keys are always rejected.", "x-paperclip-advanced": true },
        cpu: { type: "integer", minimum: 1, default: 2, "x-paperclip-advanced": true },
        memory: { type: "string", default: "4GB", "x-paperclip-advanced": true },
        disk: { type: "string", default: "20GB", "x-paperclip-advanced": true },
        timeoutMs: { type: "integer", minimum: 1000, default: 300000, "x-paperclip-advanced": true },
        reuseLease: { type: "boolean", default: true, description: "Reuse each agent workspace between runs. The VM is always retained." },
        runnerLifecycleMode: { type: "string", enum: ["inherit", "per_turn", "warm"], default: "inherit" },
        runnerIdleTimeoutMs: { type: "integer", minimum: 1000, maximum: 86400000, default: 300000 },
      },
    },
  }],
};
export default manifest;
