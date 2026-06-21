// Ollama is a local model adapter and doesn't support skills in the same way as cloud adapters
// These functions are provided for API compatibility but return empty results

export async function listOllamaSkills(): Promise<string[]> {
  return [];
}

export async function syncOllamaSkills(): Promise<void> {
  // No-op for local Ollama models
}
