import type { ServerAdapterModule } from "../types.js";
import { executeOllamaLocal } from "./execute.js";
import { getOllamaLocalConfigSchema } from "./config.js";
import { listOllamaLocalModels, refreshOllamaLocalModels } from "./models.js";
import { listOllamaLocalSkills, syncOllamaLocalSkills } from "./skills.js";
import { ollamaLocalSessionCodec } from "./session.js";
import { testOllamaLocalEnvironment } from "./test.js";

export const ollamaLocalAdapter: ServerAdapterModule = {
  type: "ollama_local",
  execute: executeOllamaLocal,
  testEnvironment: testOllamaLocalEnvironment,
  listSkills: listOllamaLocalSkills,
  syncSkills: syncOllamaLocalSkills,
  listModels: listOllamaLocalModels,
  refreshModels: refreshOllamaLocalModels,
  sessionCodec: ollamaLocalSessionCodec,
  getConfigSchema: getOllamaLocalConfigSchema,
  agentConfigurationDoc: [
    "Use Ollama (Local) when Paperclip should call a local or remote Ollama server directly.",
    "This adapter supports model discovery, Paperclip-managed skill injection, optional command execution via a run_command tool, and Paperclip-managed session persistence.",
    "Set OLLAMA_BASE_URL on the Paperclip host if you want the default model discovery and adapter defaults to point somewhere other than http://127.0.0.1:11434.",
  ].join(" "),
};
