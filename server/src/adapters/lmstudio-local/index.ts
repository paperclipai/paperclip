import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listLmStudioModels } from "./models.js";

export const lmstudioLocalAdapter: ServerAdapterModule = {
  type: "lmstudio_local",
  execute,
  testEnvironment,
  models: [],
  listModels: listLmStudioModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: `# LM Studio local agent configuration

Adapter: lmstudio_local

LM Studio provides an OpenAI-compatible API for running local LLMs.

Core fields:
- apiBaseUrl (string, optional): LM Studio API endpoint. Default: http://localhost:1234/v1
- apiKey (string, optional): API key placeholder. Default: "lm-studio"
- model (string, optional): Model identifier loaded in LM Studio
- instructionsFilePath (string, optional): Path to agent instructions markdown file

Requirements:
- LM Studio must be installed and running with the local server enabled
- At least one model must be loaded in LM Studio
`,
};
