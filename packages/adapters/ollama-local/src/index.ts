import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_LOCAL_MODEL = "llama3.1";

export const models = [
  { id: "llama3.1", label: "Llama 3.1" },
  { id: "llama3", label: "Llama 3" },
  { id: "llama2", label: "Llama 2" },
  { id: "mistral", label: "Mistral" },
  { id: "codellama", label: "Code Llama" },
  { id: "phi3", label: "Phi 3" },
  { id: "gemma2", label: "Gemma 2" },
  { id: "qwen2", label: "Qwen 2" },
  { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a smaller Ollama model as the budget lane while preserving the primary model.",
    adapterConfig: {
      model: "phi3",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run Ollama locally as the agent runtime
- You want to use self-hosted open-source models via Ollama
- You want local model execution with full privacy and no external API calls

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need one-shot shell commands (use process)
- Ollama is not installed or running on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Ollama model name/tag. Defaults to llama3.1.
- baseUrl (string, optional): Ollama API base URL. Defaults to http://localhost:11434
- format (string, optional): response format (json or empty for text)
- keepAlive (string, optional): how long to keep model loaded (e.g., "5m", "-1" for forever)
- numCtx (number, optional): context window size
- temperature (number, optional): sampling temperature
- topP (number, optional): nucleus sampling parameter
- command (string, optional): defaults to "ollama"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: ollama run --format json ...
- Prompts are piped to Ollama via stdin.
- Ollama must be running locally (or accessible via baseUrl) before using this adapter.
- Use \`ollama list\` to see available models and \`ollama pull <model>\` to download new ones.
- The adapter uses Ollama's REST API internally for structured output parsing.
`;
