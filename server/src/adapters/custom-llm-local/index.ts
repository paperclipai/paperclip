import type { ServerAdapterModule } from "../types.js";
import { executeCustomLlmLocal } from "./execute.js";
import { getCustomLlmLocalConfigSchema } from "./config.js";
import { testCustomLlmLocalEnvironment } from "./test.js";

export const customLlmLocalAdapter: ServerAdapterModule = {
  type: "custom_llm_local",
  execute: executeCustomLlmLocal,
  testEnvironment: testCustomLlmLocalEnvironment,
  models: [],
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  getConfigSchema: getCustomLlmLocalConfigSchema,
  agentConfigurationDoc: [
    "Use Custom LLM (Local) when you have an OpenAI Chat Completions or Anthropic Messages compatible endpoint that Paperclip can call directly.",
    "Authentication is environment-variable only: set apiKeyEnv to the Paperclip server variable that holds the secret. Raw apiKey values are intentionally rejected.",
    "Extra headers can be supplied as a JSON object. Sensitive header names are redacted in Paperclip run metadata.",
  ].join(" "),
};
