/** Value-free projection from the authorized Connections resolver. */
export function parseHermesConfig(raw: string | undefined, model: string): Record<string, unknown> {
  if (!raw || Buffer.byteLength(raw) > 32 * 1024) throw new Error("Hermes requires a managed connection and explicit model");
  const config = object(JSON.parse(raw), ["model", "providers", "bedrock", "paperclip_auth"]);
  const selected = object(config.model, ["default", "provider"]);
  if (selected.default !== model || !model || !["openai", "anthropic", "openrouter", "xai", "gemini", "openai-codex", "xai-oauth", "bedrock", "custom:paperclip"].includes(String(selected.provider))) invalid();
  if (selected.provider === "custom:paperclip") {
    const providers = object(config.providers, ["paperclip"]);
    const provider = object(providers.paperclip, ["base_url", "transport", "default_model", "key_env", "api_key"]);
    const auth = object(config.paperclip_auth, ["protocol", "style"]);
    if (config.bedrock !== undefined || provider.default_model !== model || !["none", "api_key", "bearer"].includes(String(auth.style))) invalid();
    const transports: Record<string, string> = { chat: "chat_completions", responses: "codex_responses", messages: "anthropic_messages" };
    if (!transports[String(auth.protocol)] || transports[String(auth.protocol)] !== provider.transport) invalid();
    const url = new URL(String(provider.base_url));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) invalid();
    if (auth.style === "none") {
      if (provider.api_key !== "no-key-required" || provider.key_env !== undefined) invalid();
    } else {
      const key = auth.protocol === "messages" ? auth.style === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN" : "OPENAI_API_KEY";
      if (provider.key_env !== key || provider.api_key !== undefined) invalid();
    }
  } else {
    if (config.providers !== undefined || config.paperclip_auth !== undefined) invalid();
    if (selected.provider === "bedrock") {
      const bedrock = object(config.bedrock, ["region"]);
      if (typeof bedrock.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(bedrock.region)) invalid();
    } else if (config.bedrock !== undefined) invalid();
  }
  return config;
}
function invalid(): never { throw new Error("Hermes connection projection is invalid"); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
