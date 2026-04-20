import { type, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { fetchModels } from "./models.js";

interface ConfigSchemaField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}

interface AdapterConfigSchema {
  version: number;
  fields: ConfigSchemaField[];
}

interface ServerAdapterModule {
  type: string;
  execute: typeof execute;
  testEnvironment: typeof testEnvironment;
  agentConfigurationDoc?: string;
  supportsLocalAgentJwt?: boolean;
  listModels?: () => Promise<Array<{ id: string; label: string }>>;
  getConfigSchema?: () => Promise<AdapterConfigSchema>;
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    async listModels() {
      const models = await fetchModels("http://localhost:1234");
      return models.map((id) => ({ id, label: id }));
    },
    async getConfigSchema() {
      const models = await fetchModels("http://localhost:1234");
      const modelOptions = models.map((id) => ({ value: id, label: id }));
      return {
        version: 1,
        fields: [
          {
            key: "url",
            label: "LM Studio URL",
            type: "text" as const,
            required: true,
            default: "http://localhost:1234",
            hint: "URL des LM Studio Servers",
          },
          {
            key: "defaultModel",
            label: "Modell",
            type: "select" as const,
            required: true,
            hint: "LLM-Modell aus LM Studio",
            options:
              modelOptions.length > 0
                ? modelOptions
                : [{ value: "", label: "(LM Studio nicht erreichbar)" }],
          },
          {
            key: "timeoutMs",
            label: "Timeout (ms)",
            type: "number" as const,
            default: 120000,
            hint: "Timeout für Inferenz in Millisekunden",
          },
          {
            key: "streamingEnabled",
            label: "Token-Streaming",
            type: "boolean" as const,
            default: true,
            hint: "Antwort Token für Token in der UI anzeigen",
          },
          {
            key: "maxIterations",
            label: "Max Tool-Iterationen",
            type: "number" as const,
            default: 25,
            hint: "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)",
          },
          {
            key: "instructionsFilePath",
            label: "Instructions File (AGENTS.md)",
            type: "text" as const,
            hint: "Optionaler absoluter Pfad zu einer Markdown-Datei, die als Agent-Persona an den System-Prompt angehängt wird",
          },
        ],
      };
    },
  };
}
