import type { CreateConfigValues } from "../../components/AgentConfigForm";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Build the adapterConfig record persisted on the agent. Only writes fields
 * the user actually filled in; the server-side adapter applies defaults for
 * everything else (default model, ollamaBaseUrl, etc.).
 */
export function buildOllamaLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (values.model) ac.model = values.model;
  if (values.promptTemplate) ac.promptTemplate = values.promptTemplate;
  // Only persist the base URL when it's not the default — keeps the stored
  // config minimal so re-rendering the form shows placeholder text instead
  // of the redundant default.
  const bindings = values.envBindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const url = (bindings as Record<string, unknown>).OLLAMA_API_BASE;
    if (typeof url === "string" && url.trim().length > 0 && url.trim() !== DEFAULT_OLLAMA_BASE_URL) {
      ac.ollamaBaseUrl = url.trim();
    }
  }
  return ac;
}
