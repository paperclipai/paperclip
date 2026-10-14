/** Proposed UI fixtures only. These are deliberately separate from the production auth contract. */
export type Harness =
  | "codex"
  | "claude"
  | "opencode"
  | "pi"
  | "gemini"
  | "kimi"
  | "grok"
  | "hermes"
  | "cursor"
  | "copilot";
export type Provider =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "bedrock"
  | "google"
  | "xai"
  | "custom";
export type Protocol = "responses" | "messages" | "chat" | "gemini";
export const isAdvancedProvider = (provider: Provider) =>
  ["openrouter", "bedrock", "custom"].includes(provider);
export type Connection = {
  id: string;
  name: string;
  provider: Provider;
  endpoint: string;
  protocols: Protocol[];
  method: string;
  ownership: "personal" | "shared";
  models: string[];
  status: "connected" | "expired" | "denied";
};
export const harnesses: {
  value: Harness;
  label: string;
  native: boolean;
  formats: Protocol[];
}[] = [
  { value: "codex", label: "Codex", native: true, formats: ["responses"] },
  {
    value: "claude",
    label: "Claude Code",
    native: true,
    formats: ["messages"],
  },
  {
    value: "opencode",
    label: "OpenCode",
    native: true,
    formats: ["responses", "messages", "chat"],
  },
  {
    value: "grok",
    label: "Grok Build",
    native: true,
    formats: ["responses", "messages", "chat"],
  },
  {
    value: "pi",
    label: "Pi",
    native: false,
    formats: ["responses", "messages", "chat", "gemini"],
  },
  { value: "gemini", label: "Gemini CLI", native: false, formats: ["gemini"] },
  {
    value: "kimi",
    label: "Kimi CLI",
    native: false,
    formats: ["responses", "messages", "chat", "gemini"],
  },
  { value: "hermes", label: "Hermes local", native: false, formats: ["chat"] },
  { value: "cursor", label: "Cursor", native: false, formats: [] },
  {
    value: "copilot",
    label: "GitHub Copilot",
    native: false,
    formats: ["chat", "messages"],
  },
];
export const providers: {
  value: Provider;
  label: string;
  description: string;
}[] = [
  {
    value: "openai",
    label: "OpenAI",
    description: "ChatGPT subscription or API key",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude subscription or API key",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "One account, multiple model providers",
  },
  {
    value: "bedrock",
    label: "Amazon Bedrock",
    description: "Your AWS account and region",
  },
  { value: "google", label: "Google", description: "Gemini API or Vertex AI" },
  { value: "xai", label: "xAI", description: "Grok subscription or API key" },
  {
    value: "custom",
    label: "Custom provider or gateway",
    description: "A company endpoint or local model service",
  },
];
export const formatLabels: Record<Protocol, string> = {
  responses: "OpenAI Responses",
  messages: "Anthropic Messages",
  chat: "OpenAI Chat Completions",
  gemini: "Google Gemini",
};
export const connections: Connection[] = [
  {
    id: "chatgpt",
    name: "My ChatGPT subscription",
    provider: "openai",
    endpoint: "OpenAI",
    protocols: ["responses"],
    method: "Subscription",
    ownership: "personal",
    models: ["gpt-5.4"],
    status: "connected",
  },
  {
    id: "claude",
    name: "My Claude subscription",
    provider: "anthropic",
    endpoint: "Anthropic",
    protocols: ["messages"],
    method: "Subscription",
    ownership: "personal",
    models: ["claude-sonnet-4-6"],
    status: "connected",
  },
  {
    id: "router",
    name: "Company OpenRouter",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api",
    protocols: ["responses", "messages", "chat"],
    method: "API key",
    ownership: "shared",
    models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4.6"],
    status: "connected",
  },
  {
    id: "bedrock",
    name: "Company Bedrock",
    provider: "bedrock",
    endpoint: "us-east-1",
    protocols: ["responses", "messages"],
    method: "Environment identity",
    ownership: "shared",
    models: ["us.anthropic.claude-sonnet-4-6"],
    status: "connected",
  },
  {
    id: "gateway",
    name: "Engineering gateway",
    provider: "custom",
    endpoint: "https://models.example.com/v1",
    protocols: ["responses"],
    method: "API key",
    ownership: "shared",
    models: ["engineering-coder", "engineering-fast"],
    status: "connected",
  },
  {
    id: "chat",
    name: "Local model service",
    provider: "custom",
    endpoint: "http://localhost:11434/v1",
    protocols: ["chat"],
    method: "No authentication",
    ownership: "personal",
    models: ["qwen-coder"],
    status: "connected",
  },
  {
    id: "gemini",
    name: "Company Gemini",
    provider: "google",
    endpoint: "Google Gemini API",
    protocols: ["gemini"],
    method: "API key",
    ownership: "shared",
    models: ["gemini-2.5-pro"],
    status: "connected",
  },
  {
    id: "openai-api",
    name: "Company OpenAI",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    protocols: ["responses"],
    method: "API key",
    ownership: "shared",
    models: ["gpt-5.4"],
    status: "connected",
  },
];
export function compatibility(
  connection: Connection,
  harness: Harness,
): string | undefined {
  if (harness === "cursor")
    return "Custom provider configuration has not been verified for Cursor.";
  if (harness === "copilot")
    return "This runner profile is awaiting qualification.";
  if (
    connection.method === "Subscription" &&
    !(
      (connection.provider === "openai" && harness === "codex") ||
      (connection.provider === "anthropic" && harness === "claude")
    )
  )
    return "This subscription is available through its own harness.";
  if (
    connection.provider === "bedrock" &&
    !["codex", "claude", "opencode"].includes(harness)
  )
    return "Bedrock support has not been verified for this harness in Paperclip.";
  if (
    !harnesses
      .find((item) => item.value === harness)!
      .formats.some((format) => connection.protocols.includes(format))
  )
    return `${harnesses.find((item) => item.value === harness)!.label} needs a different API format.`;
}
export function modelsFor(connection: Connection, harness: Harness): string[] {
  if (connection.id === "router" && harness === "claude")
    return connection.models.filter((id) => id.startsWith("anthropic/"));
  if (connection.provider === "bedrock" && harness === "codex")
    return ["openai.gpt-5.4"];
  return connection.models;
}
export function defaultConnection(harness: Harness): Connection {
  return (
    connections.find((item) => !compatibility(item, harness)) ?? connections[2]
  );
}
