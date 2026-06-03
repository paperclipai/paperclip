import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "gemini_api";
export const label = "Gemini API";

export const DEFAULT_GEMINI_API_MODEL = "gemini-2.5-flash";

export const models = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description:
      "Use Gemini Flash Lite as the budget lane while preserving the primary model.",
    adapterConfig: {
      model: "gemini-2.5-flash-lite",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# gemini_api agent configuration

Adapter: gemini_api

Use when:
- You want Paperclip to call the Gemini REST API directly (no local CLI required)
- You have a GEMINI_API_KEY provisioned as a Paperclip-managed secret
- You want per-model health checks, quota quarantine, and cost controls

Don't use when:
- You want the Gemini CLI with sessions and --resume support (use gemini_local)
- GEMINI_API_KEY is not available

Core fields:
- model (string, optional): Gemini model id. Defaults to gemini-2.5-flash.
- riskTier (string, optional): "low" | "medium" | "high". Controls fallback model selection. Defaults to "medium".
- cwd (string, optional): default absolute working directory
- promptTemplate (string, optional): run prompt template
- env (object, optional): KEY=VALUE environment variables

Cost-control fields (all optional):
- maxRequestsPerAgentPerHour (number): max requests per agent per hour. Default 20.
- maxTokensPerRun (number): max input+output tokens per run. Default 100000.
- maxDailyBudgetUsd (number): max daily spend in USD across all runs. Default 5.00.

Quarantine fields (all optional):
- quarantineReleaseAfterMinutes (number): minutes before a quarantined model is retried. Default 60.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
`;
