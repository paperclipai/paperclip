import {
  buildSandboxNpmInstallCommand,
  type AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";

export const type = "ollama_local";
export const label = "Ollama (local)";

export const SANDBOX_INSTALL_COMMAND = buildSandboxNpmInstallCommand("ollama");

export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

export const models = [
  { id: DEFAULT_OLLAMA_MODEL, label: "Llama 3.2" },
  { id: "llama3.1", label: "Llama 3.1" },
  { id: "llama3", label: "Llama 3" },
  { id: "llama2", label: "Llama 2" },
  { id: "mistral", label: "Mistral" },
  { id: "codellama", label: "Code Llama" },
  { id: "deepseek-coder", label: "DeepSeek Coder" },
  { id: "phi3", label: "Phi-3" },
  { id: "gemma2", label: "Gemma 2" },
  { id: "qwen2", label: "Qwen 2" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a smaller, faster model for budget-conscious operations while preserving the primary model.",
    adapterConfig: {
      model: "phi3",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run Ollama models locally on the host machine
- You want local LLM inference without external API calls
- You want to use custom or fine-tuned models hosted in Ollama
- You need offline capabilities for AI operations

Don't use when:
- You need cloud-based model access (use cloud adapters)
- You only need a one-shot script without an AI coding agent loop (use process)
- Ollama is not installed or running on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Ollama model id. Defaults to llama3.2.
- host (string, optional): Ollama server host. Defaults to http://localhost:11434.
- numCtx (number, optional): context window size for the model
- temperature (number, optional): sampling temperature (0.0 - 1.0)
- topP (number, optional): top-p sampling parameter
- command (string, optional): defaults to "ollama"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Ollama must be installed and running locally before using this adapter
- Models can be pulled using 'ollama pull <model_name>' or managed through the adapter
- The adapter connects to the Ollama API for model inference
- Local models provide privacy and offline capabilities
- Model availability depends on what's installed in your local Ollama instance
- The adapter sets a headless-safe environment for unattended runs
- Authentication is handled locally by Ollama (no API keys needed)
`;
