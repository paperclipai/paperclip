import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_OPENROUTER_LOCAL_BASE_URL,
  DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS,
  DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC,
} from "../index.js";

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: DEFAULT_OPENROUTER_LOCAL_BASE_URL,
        hint: "OpenAI-compatible API base URL.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute path for local tool execution.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Optional path to markdown instructions.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Custom user prompt template.",
      },
      {
        key: "maxIterations",
        label: "Max iterations",
        type: "number",
        default: DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS,
        hint: "Maximum tool-call rounds per run.",
      },
      {
        key: "maxRunCommandTimeoutSec",
        label: "Command timeout",
        type: "number",
        default: DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC,
        hint: "Max seconds for run_command tool calls.",
      },
      {
        key: "timeoutSec",
        label: "Wall-clock timeout",
        type: "number",
        default: 0,
        hint: "Total run timeout in seconds. 0 for no limit.",
      },
      {
        key: "reasoning",
        label: "Reasoning config",
        type: "textarea",
        hint: "Optional JSON for reasoning parameters (e.g. { \"effort\": \"high\" }).",
      },
      {
        key: "extraHeaders",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of additional HTTP headers.",
      },
      {
        key: "autoApprove",
        label: "Auto-approve",
        type: "toggle",
        default: false,
        hint: "Skip approval for governed operations.",
      },
    ],
  };
}
