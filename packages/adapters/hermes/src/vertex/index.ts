import type { ServerAdapterModule } from "@paperclipai/adapter-utils";

import { resolveHermesCommand } from "../server/execute.js";
import { listHermesSkills, syncHermesSkills } from "../server/skills.js";
import { sessionCodec } from "../server/index.js";
import {
  executeGoogleVertex,
  getGoogleVertexConfigSchema,
  testGoogleVertexEnvironment,
} from "./server/index.js";
import {
  GOOGLE_VERTEX_ADAPTER_LABEL,
  GOOGLE_VERTEX_ADAPTER_TYPE,
  GOOGLE_VERTEX_MODELS,
} from "./shared/constants.js";

export const type = GOOGLE_VERTEX_ADAPTER_TYPE;
export const label = GOOGLE_VERTEX_ADAPTER_LABEL;
export const models = [...GOOGLE_VERTEX_MODELS];

export const agentConfigurationDoc = `# Google Vertex AI Configuration

This adapter runs Hermes Agent with the Google Vertex AI provider fixed for every heartbeat.
It uses Gemini models through Vertex's OpenAI-compatible endpoint.

## Authentication

Vertex uses OAuth2, not a static API key. Configure one of:

- \`credentialsPath\`: absolute path to a service-account JSON file on the execution host.
- Application Default Credentials (ADC): leave \`credentialsPath\` blank and configure ADC on the host.

Set \`projectId\` when it cannot be inferred from the credential. The default region is \`global\`, which is required by Gemini 3 preview models. Hermes mints and refreshes short-lived OAuth2 tokens at runtime.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute: executeGoogleVertex,
    testEnvironment: testGoogleVertexEnvironment,
    sessionCodec,
    sessionManagement: {
      supportsSessionResume: true,
      nativeContextManagement: "confirmed",
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      },
    },
    listSkills: listHermesSkills,
    syncSkills: syncHermesSkills,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec: (config) => {
      const command = resolveHermesCommand(config);
      return { command, detectCommand: command, installCommand: null };
    },
    agentConfigurationDoc,
    getConfigSchema: getGoogleVertexConfigSchema,
  };
}
