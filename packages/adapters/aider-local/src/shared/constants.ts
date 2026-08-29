// Browser-safe constants. The UI bundle imports this module, so it must never
// pull in node builtins or server code (the package root re-exports
// createServerAdapter for the external plugin loader and is server-only).

export const ADAPTER_TYPE = "aider_local";
export const ADAPTER_LABEL = "Aider";

/**
 * Sentinel meaning "let Aider pick the model from its own config/env".
 * execute.ts only passes `--model` when the configured value differs from it.
 */
export const DEFAULT_AIDER_LOCAL_MODEL = "aider-default";

/** Aider's own default chat transcript file, written into the run cwd. */
export const DEFAULT_AIDER_CHAT_HISTORY_FILE = ".aider.chat.history.md";

export const models = [
  { id: DEFAULT_AIDER_LOCAL_MODEL, label: "Aider default (from aider config)" },
  { id: "sonnet", label: "sonnet" },
  { id: "opus", label: "opus" },
  { id: "gpt-5", label: "gpt-5" },
  { id: "gemini", label: "gemini" },
];
