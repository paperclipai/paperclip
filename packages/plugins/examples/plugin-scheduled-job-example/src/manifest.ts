import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Manifest for the Scheduled Job Example Plugin.
 *
 * Demonstrates declaring recurring jobs in the manifest and handling them
 * in the worker via ctx.jobs.register(). Requires the jobs.schedule capability.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.scheduled-job-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Scheduled Job (Example)",
  description:
    "Reference plugin that runs scheduled (recurring) tasks: a heartbeat every 5 minutes and a daily summary at 2:00.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["jobs.schedule", "plugin.state.read", "plugin.state.write", "metrics.write"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  jobs: [
    {
      jobKey: "heartbeat",
      displayName: "Heartbeat",
      description: "Runs every 5 minutes; updates instance state and writes a metric.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "daily-summary",
      displayName: "Daily Summary",
      description: "Runs once per day at 2:00 AM (server time).",
      schedule: "0 2 * * *",
    },
  ],
};

export default manifest;
