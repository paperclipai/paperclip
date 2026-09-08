// Configuration schema for Antigravity local adapter fields in Paperclip

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, models } from "../index.js";

// Returns the configuration field schema for the Antigravity local adapter
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "command",
        label: "Command",
        type: "text",
        default: "agy",
        hint: "Path or name of the Antigravity CLI binary. Defaults to 'agy'.",
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        default: DEFAULT_ANTIGRAVITY_LOCAL_MODEL,
        options: models.map((m) => ({ value: m.id, label: m.label })),
        hint: "Model for the CLI session.",
      },
      {
        key: "agent",
        label: "Agent",
        type: "text",
        hint: "Optional agent name for the CLI session.",
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: "Default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        hint: "Reasoning effort for the current CLI session (low|medium|high).",
      },
      {
        key: "sandbox",
        label: "Sandbox",
        type: "toggle",
        default: false,
        hint: "Run in a sandbox with terminal restrictions enabled.",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Dangerously skip permissions",
        type: "toggle",
        default: false,
        hint: "Auto-approve tool permission requests without prompting. Recommended only for trusted, sandboxed environments.",
      },
      {
        key: "printTimeout",
        label: "Print timeout",
        type: "text",
        hint: "Timeout duration for print mode wait (e.g. 5m0s).",
      },
    ],
  };
}
