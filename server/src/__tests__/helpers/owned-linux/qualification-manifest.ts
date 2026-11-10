// PRIVATE fixture package, never a deployed provider claim.
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
export default {
  id: "paperclip.dot-linux-qualification",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Owned Linux qualification",
  description: "Controlled local Linux process boundary for Dot acceptance, not a public sandbox service.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.mjs" },
  environmentDrivers: [{
    driverKey: "dot-linux-qualification",
    kind: "sandbox_provider",
    displayName: "Owned Linux qualification",
    description: "Runs the actual source-matched Linux Runner in a strictly owned local container.",
    supportsReusableLeases: false,
    creationOperationVersion: 1,
    sandboxCapabilities: {
      runnerWebSocketIngress: true,
      incrementalSessionOutput: false,
      concurrentSyncOperations: false,
      duplexCommandStream: false,
    },
    configSchema: {
      type: "object", additionalProperties: false,
      properties: { qualificationId: { type: "string", enum: ["dot-owned-linux"] } },
      required: ["qualificationId"],
    },
  }],
} satisfies PaperclipPluginManifestV1;
