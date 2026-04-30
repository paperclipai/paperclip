import type { CreateConfigValues } from "../../components/AgentConfigForm";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Build the adapterConfig record persisted on the agent from the form values.
 * Only writes fields the user actually filled in; the server-side adapter
 * applies defaults for everything else (default model, ollamaBaseUrl, etc.).
 */
export function buildAiderLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (values.cwd) ac.cwd = values.cwd;
  if (values.instructionsFilePath) ac.instructionsFilePath = values.instructionsFilePath;
  if (values.model) ac.model = values.model;
  if (values.command) ac.command = values.command;
  if (values.promptTemplate) ac.promptTemplate = values.promptTemplate;
  // Surface ollamaBaseUrl out of the env-bindings input if the user provided one;
  // otherwise the server defaults it. We don't add a dedicated field for the
  // common case where Ollama is on localhost:11434.
  const bindings = values.envBindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const url = (bindings as Record<string, unknown>).OLLAMA_API_BASE;
    if (typeof url === "string" && url.trim().length > 0 && url.trim() !== DEFAULT_OLLAMA_BASE_URL) {
      ac.ollamaBaseUrl = url.trim();
    }
  }
  return ac;
}
