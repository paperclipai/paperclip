import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Manifest for the Circuit Breaker Plugin.
 *
 * Subscribes to agent run events to detect failure loops, no-progress runs,
 * and token velocity spikes. Auto-pauses runaway agents when configurable
 * thresholds are exceeded. Supports manual and half-open recovery patterns.
 *
 * @see PLUGIN_SPEC.md §6 — Manifest
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.circuit-breaker",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Circuit Breaker",
  description:
    "Detects runaway agents via consecutive failures, no-progress runs, and token velocity spikes. Auto-pauses agents when configurable thresholds are tripped.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "agents.read",
    "agents.pause",
    "agents.resume",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "Master switch for the circuit breaker.",
        default: true,
      },
      maxConsecutiveFailures: {
        type: "integer",
        description: "Number of consecutive failed runs before tripping.",
        default: 3,
        minimum: 1,
      },
      maxConsecutiveNoProgress: {
        type: "integer",
        description: "Number of consecutive no-progress runs before tripping.",
        default: 5,
        minimum: 1,
      },
      tokenVelocityMultiplier: {
        type: "number",
        description:
          "Trip when a run's token usage exceeds this multiple of the rolling average.",
        default: 3.0,
        minimum: 1.1,
      },
      tokenVelocityWindowSize: {
        type: "integer",
        description: "Number of recent runs to include in the rolling average.",
        default: 20,
        minimum: 4,
      },
      recovery: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["manual", "half-open"],
            default: "manual",
            description:
              '"manual" requires operator un-pause; "half-open" auto-resumes after cooldown for a trial run.',
          },
          cooldownMinutes: {
            type: "integer",
            description:
              "Minutes before a half-open trial run is attempted (only applies in half-open mode).",
            default: 30,
            minimum: 5,
          },
        },
      },
    },
  },
  jobs: [
    {
      jobKey: "half-open-recovery",
      displayName: "Half-Open Recovery Check",
      description:
        "Polls open circuits for cooldown expiry and resumes agents for trial runs.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "state-cleanup",
      displayName: "Orphaned State Cleanup",
      description:
        "Removes circuit breaker state for agents that no longer exist.",
      schedule: "0 3 * * 0",
    },
  ],
};

export default manifest;
