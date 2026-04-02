import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOpenrouterSkills, syncOpenrouterSkills } from "./skills.js";

export const openrouterAdapter: ServerAdapterModule = {
  type: "openrouter_local",
  execute,
  testEnvironment,
  listSkills: listOpenrouterSkills,
  syncSkills: syncOpenrouterSkills,
  models: [
    { id: "deepseek/deepseek-v3.2-speciale", label: "DeepSeek V3.2 Speciale" },
    { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
    { id: "minimax/minimax-m2.7", label: "MiniMax M2.7" },
    { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
    { id: "qwen/qwen3.5-plus", label: "Qwen 3.5 Plus" },
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# openrouter_local agent configuration

Adapter: openrouter_local

Uses OpenRouter Chat Completions API with any supported model.
Requires OPENROUTER_API_KEY or OPENAI_API_KEY environment variable.

Core fields:
- model (string, required): OpenRouter model ID (e.g. "deepseek/deepseek-v3.2-speciale")
- instructionsFilePath (string, optional): absolute path to agent instructions markdown file (e.g. AGENTS.md)
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): bootstrap prompt prepended to each run
- cwd (string, optional): working directory
- env (object, optional): environment variables

Operational fields:
- timeoutSec (number, optional): timeout in seconds (default: 600)
- maxTurns (number, optional): max conversation turns (default: 30)
- desiredSkills (string[], optional): skills to load into prompt (e.g. ["xlsx", "pdf"]). The "paperclip" skill is always included.
`,
};
