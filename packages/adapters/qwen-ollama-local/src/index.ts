export const type = "qwen_ollama_local";
export const label = "Qwen via Ollama (Local)";

export const models = [
  { id: "qwen3.5", label: "Qwen 3.5" },
  { id: "qwen2.5", label: "Qwen 2.5" },
];

export const agentConfigurationDoc = `# qwen_ollama_local agent configuration

Adapter: qwen_ollama_local

Use when:
- The agent needs to run Qwen model via Ollama locally on the host machine
- You want to use open-source LLM without API costs or external dependencies
- The task requires local-only processing (no internet calls)
- You have Ollama installed and a Qwen model downloaded locally

Don't use when:
- Ollama is not installed on the host machine
- You need proprietary models (Claude, GPT, Gemini)
- The task requires internet connectivity or external tool access
- You need multi-turn conversation state management

Configuration:
- ollama_url: URL where Ollama is running (default: http://localhost:11434)
- model: The Ollama model name (default: qwen3.5)

Setup:
1. Install Ollama: https://ollama.ai
2. Pull a model: \`ollama pull qwen3.5\`
3. Keep ollama running: \`ollama serve\`
`;
