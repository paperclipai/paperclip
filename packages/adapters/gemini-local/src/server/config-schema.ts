import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "dangerouslyBypassSandbox",
        label: "Dangerously bypass sandbox",
        type: "toggle",
        default: false,
        hint: "Run Gemini without internal sandbox restrictions. Required for container environments without Docker-in-Docker support.",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_GEMINI_LOCAL_MODEL,
        hint: "The Gemini model to use (e.g. gemini-2.5-flash).",
      },
      {
        key: "command",
        label: "Command",
        type: "text",
        default: "gemini",
        hint: "The command to run the Gemini CLI.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback directory. Paperclip execution workspaces can override this at runtime.",
      },
      {
        key: "extraArgs",
        label: "Extra arguments",
        type: "text",
        hint: "Comma-separated list of additional CLI arguments.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file path",
        type: "text",
        hint: "Path to a custom instructions file for the agent.",
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object of environment values or secret bindings.",
      },
    ],
  };
}
