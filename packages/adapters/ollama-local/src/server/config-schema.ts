import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_HOST, models } from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: DEFAULT_OLLAMA_MODEL,
        required: true,
        options: models.map((model) => ({ value: model.id, label: model.label })),
        hint: "Ollama model to use for inference",
      },
      {
        key: "host",
        label: "Ollama host",
        type: "text",
        default: DEFAULT_OLLAMA_HOST,
        hint: "Ollama API server host URL",
      },
      {
        key: "numCtx",
        label: "Context window",
        type: "number",
        hint: "Context window size for the model",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "Sampling temperature (0.0 - 1.0)",
      },
      {
        key: "topP",
        label: "Top P",
        type: "number",
        hint: "Top-p sampling parameter",
      },
      {
        key: "command",
        label: "Ollama command",
        type: "text",
        default: "ollama",
        hint: "Ollama CLI command (default: ollama)",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback directory. Paperclip execution workspaces can override this at runtime.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: 300,
        hint: "Execution timeout in seconds",
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: 10,
        hint: "SIGTERM grace period in seconds",
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object of environment variables",
      },
    ],
  };
}
