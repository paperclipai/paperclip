import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Manifest for the Agent Routines Plugin.
 *
 * Declares a single dispatcher job on a 1-minute cron that evaluates
 * configured routines and invokes matching agents. Routines are defined
 * in the instance config — no code changes needed to add/remove routines.
 *
 * @see PLUGIN_SPEC.md §6 — Manifest
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.agent-routines",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Agent Routines",
  description:
    "Run agents on cron schedules with specific prompts. Define routines in the plugin config to automatically invoke agents at the right time.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "agents.invoke",
    "agents.read",
    "activity.log.write",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      routines: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-readable label for the routine" },
            cronExpression: { type: "string", description: "5-field cron (e.g. '0 9 * * 1-5')" },
            agentId: { type: "string", description: "Target agent UUID" },
            companyId: { type: "string", description: "Company the agent belongs to" },
            prompt: { type: "string", description: "What the agent should do on each run" },
            enabled: { type: "boolean", default: true },
          },
          required: ["name", "cronExpression", "agentId", "companyId", "prompt"],
        },
      },
    },
  },
  jobs: [
    {
      jobKey: "routine-dispatcher",
      displayName: "Routine Dispatcher",
      description: "Checks enabled routines every minute and invokes matching agents.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
