import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "oxford.typesafe-task-routing",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "TypeSafe Task Routing Pilot",
  description: "Records observation-only routing recommendations for eligible new issues.",
  author: "Oxford Cigar Company",
  categories: ["automation"],
  capabilities: ["events.subscribe", "issues.read", "projects.read", "goals.read", "agents.read"],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", title: "Enable routing evaluation", default: false },
      timeoutMs: { type: "number", title: "Timeout per request (ms)", default: 5000, minimum: 1000, maximum: 15000 },
      maxRetries: { type: "number", title: "Retry count", default: 1, minimum: 0, maximum: 2 }
    },
    additionalProperties: false
  }
};

export default manifest;
