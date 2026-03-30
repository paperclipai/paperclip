import type { HttpRuntimeProfile } from "./types/agent.js";

export interface RuntimeProfileDefinition {
  id: HttpRuntimeProfile | string;
  label: string;
  framework: string;
  defaultHeaderValue?: string;
  description?: string;
}

export const DEFAULT_RUNTIME_PROFILES: RuntimeProfileDefinition[] = [
  {
    id: "custom-http",
    label: "Custom HTTP",
    framework: "CustomHTTP",
    description: "Generic webhook runtime profile.",
  },
  {
    id: "http+crewai",
    label: "HTTP + CrewAI",
    framework: "CrewAI",
    defaultHeaderValue: "CrewAI",
    description: "CrewAI webhook runtime profile.",
  },
  {
    id: "http+langgraph",
    label: "HTTP + LangGraph",
    framework: "LangGraph",
    defaultHeaderValue: "LangGraph",
    description: "LangGraph webhook runtime profile.",
  },
];
