import type { AiConnectionBinding, AiConnectionSummary } from "@/components/ai-connections/model";

export type Harness = "codex" | "claude" | "gemini";
export const harnesses = {
  codex: { label: "Codex", adapter: "codex_local", provider: "openai", brand: "codex", models: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"] },
  claude: { label: "Claude Code", adapter: "claude_local", provider: "anthropic", brand: "claude", models: ["claude-opus-5-5", "claude-sonnet-4-6"] },
  gemini: { label: "Gemini CLI", adapter: "gemini_local", provider: "google", brand: "gemini", models: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"] },
} as const;

function connection(id: string, name: string, provider: AiConnectionSummary["provider"], status: AiConnectionSummary["status"] = "connected"): AiConnectionSummary {
  return { id, name, provider, status, companyId: "company-storybook", grantId: `grant-${id}`, method: "api_key", ownership: "shared" };
}

// Synthetic accounts and model availability; no provider requests or credentials.
export const connections = [
  connection("codex-team", "OpenAI · Engineering", "openai"),
  connection("codex-new", "OpenAI · Production", "openai"),
  connection("codex-limited", "OpenAI · Restricted models", "openai"),
  connection("codex-expired", "OpenAI · Old account", "openai", "expired"),
  connection("claude-team", "Anthropic · Team", "anthropic"),
  connection("claude-new", "Anthropic · Production", "anthropic"),
  connection("gemini-team", "Google · Team", "google"),
];

export function bindingFor(id: string): AiConnectionBinding {
  const item = connections.find(connection => connection.id === id)!;
  return { provider: item.provider, method: item.method, mode: "shared", connectionId: item.id, grantId: item.grantId };
}

export function connectionName(id: string) {
  return id === "responsible_user" ? "Responsible user’s default" : connections.find(connection => connection.id === id)?.name ?? id;
}

export function modelsFor(harness: Harness, connectionId: string): readonly string[] {
  return connectionId === "codex-limited" ? ["gpt-5.5", "gpt-5.4"] : harnesses[harness].models;
}

export interface RosterAgent {
  id: string;
  name: string;
  title: string;
  harness: Harness | "external";
  connectionId: string;
  model: string;
  paused?: boolean;
}

export const roster: RosterAgent[] = [
  { id: "atlas", name: "Atlas", title: "Engineering lead", harness: "codex", connectionId: "codex-team", model: "gpt-5.4" },
  { id: "nova", name: "Nova", title: "Product engineer", harness: "codex", connectionId: "codex-team", model: "gpt-5.4" },
  { id: "pixel", name: "Pixel", title: "Frontend engineer", harness: "codex", connectionId: "codex-team", model: "gpt-5.5" },
  { id: "scout", name: "Scout", title: "QA engineer", harness: "codex", connectionId: "codex-team", model: "gpt-5.3-codex", paused: true },
  { id: "sage", name: "Sage", title: "Research lead", harness: "claude", connectionId: "claude-team", model: "claude-opus-5-5" },
  { id: "mira", name: "Mira", title: "Product strategist", harness: "claude", connectionId: "claude-team", model: "claude-sonnet-4-6" },
  { id: "orbit", name: "Orbit", title: "Market analyst", harness: "gemini", connectionId: "gemini-team", model: "gemini-3.1-pro-preview" },
  { id: "relay", name: "Relay", title: "External agent", harness: "external", connectionId: "", model: "" },
];
