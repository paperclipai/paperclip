export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";
export { createChatCompletion, isContextLengthError, OpenAiCompatibleRequestError } from "./client.js";

import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS,
  DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS,
  DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC,
  DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC,
} from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "apiUrl",
        label: "API URL",
        type: "text",
        required: true,
        hint: "OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. Paperclip calls {API URL}/chat/completions.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "Optional sampling temperature. Leave empty for the provider default.",
      },
      {
        key: "maxTokens",
        label: "Max output tokens",
        type: "number",
        hint: "Optional max tokens per model response.",
      },
      {
        key: "maxTurns",
        label: "Max model calls per run",
        type: "number",
        default: DEFAULT_OPENAI_COMPATIBLE_MAX_TURNS,
        hint: "Stops the tool loop after this many model calls in one heartbeat.",
      },
      {
        key: "requestTimeoutSec",
        label: "Request timeout (seconds)",
        type: "number",
        default: DEFAULT_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SEC,
        hint: "Timeout for each provider request.",
      },
      {
        key: "maxHistoryChars",
        label: "Session history budget (characters)",
        type: "number",
        default: DEFAULT_OPENAI_COMPATIBLE_MAX_HISTORY_CHARS,
        hint: "Oldest messages are trimmed from the saved conversation beyond this size.",
      },
      {
        key: "enableWorkspaceTools",
        label: "Workspace tools (shell and files)",
        type: "toggle",
        default: false,
        hint: "Let the model run shell commands and edit files in the workspace on the Paperclip host. Only enable for trusted providers.",
      },
      {
        key: "shellTimeoutSec",
        label: "Shell command timeout (seconds)",
        type: "number",
        default: DEFAULT_OPENAI_COMPATIBLE_SHELL_TIMEOUT_SEC,
        hint: "Timeout for each run_shell command when workspace tools are enabled.",
      },
    ],
  };
}
