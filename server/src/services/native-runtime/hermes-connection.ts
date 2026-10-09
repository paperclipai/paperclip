import { aiRoutingBaseUrl, type AiConnectionMetadata } from "@paperclipai/shared";

/** Runtime-only projection of an already authorized Connections selection. */
export function projectHermesConnection(connection: AiConnectionMetadata, model: string, credential: string) {
  if (!model.trim() || model !== model.trim()) throw new Error("Hermes requires an explicit model ID");
  const env: Record<string, string> = {};
  const route = connection.routing;
  const provider = route?.kind === "bedrock" ? "bedrock"
    : route && (route.kind !== "openrouter" || route.protocol !== "chat") ? "custom:paperclip"
    : connection.method === "subscription" && connection.provider === "openai" ? "openai-codex"
    : connection.method === "subscription" && connection.provider === "xai" ? "xai-oauth"
    : connection.provider === "google" ? "gemini" : connection.provider;
  const nativeModel = model;
  const config: Record<string, unknown> = { model: { provider, default: nativeModel } };
  let auth: Record<string, unknown> | undefined;
  if (route?.kind === "bedrock") {
    env.AWS_BEARER_TOKEN_BEDROCK = credential;
    env.AWS_REGION = route.region!;
    env.AWS_DEFAULT_REGION = route.region!;
    env.AWS_EC2_METADATA_DISABLED = "true";
    config.bedrock = { region: route.region };
  } else if (route && provider === "custom:paperclip") {
    const apiMode = { chat: "chat_completions", responses: "codex_responses", messages: "anthropic_messages", bedrock: "bedrock_converse" }[route.protocol];
    const key = route.protocol === "messages"
      ? route.auth === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN" : "OPENAI_API_KEY";
    if (route.auth !== "none") env[key] = credential;
    config.providers = { paperclip: {
      base_url: aiRoutingBaseUrl(route, route.protocol === "messages" ? "claude_local" : "hermes_runner"), transport: apiMode,
      default_model: nativeModel,
      ...(route.auth === "none" ? { api_key: "no-key-required" } : { key_env: key }),
    } };
    // Native Hermes guesses Messages header style from the URL. The pinned
    // bridge uses this value-free declaration to preserve the connection.
    config.paperclip_auth = { protocol: route.protocol, style: route.auth };
  } else if (connection.method === "subscription" && connection.provider !== "anthropic") {
    const original = parseRecord(credential);
    if (connection.provider === "openai") {
      const tokens = record(original.tokens);
      requireTokens(tokens);
      auth = { version: 1, providers: { "openai-codex": { tokens, last_refresh: original.last_refresh } } };
    } else if (connection.provider === "xai") {
      const entries = Object.entries(original);
      if (entries.length !== 1) throw new Error("The selected Grok connection has an invalid account identity");
      const entry = record(entries[0]![1]);
      const tokens = { access_token: entry.key, refresh_token: entry.refresh_token, token_type: "Bearer" };
      requireTokens(tokens);
      auth = { version: 1, providers: { "xai-oauth": { tokens, auth_mode: "oauth_pkce" } } };
    } else throw new Error("This subscription does not support Hermes");
  } else {
    const key = connection.method === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN"
      : { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY", xai: "XAI_API_KEY", google: "GEMINI_API_KEY" }[connection.provider];
    env[key] = credential;
  }
  return { config, env, auth, provider, nativeModel };
}

/** Convert native refresh output back before the existing provider merge/CAS. */
export function restoreHermesCredential(provider: "openai" | "xai", originalValue: string, nativeValue: string): string {
  const original = parseRecord(originalValue);
  const state = record(record(parseRecord(nativeValue).providers)[provider === "openai" ? "openai-codex" : "xai-oauth"]);
  const tokens = record(state.tokens);
  requireTokens(tokens);
  if (provider === "openai") {
    const old = record(original.tokens);
    if (tokens.access_token === old.access_token && tokens.refresh_token === old.refresh_token) return originalValue;
    if (old.account_id && tokens.account_id && old.account_id !== tokens.account_id) throw new Error("Hermes credential refresh changed accounts");
    return JSON.stringify({ ...original, tokens: { ...old, ...tokens }, last_refresh: state.last_refresh });
  }
  const entries = Object.entries(original);
  if (entries.length !== 1) throw new Error("Invalid managed Grok credential");
  const [identity, raw] = entries[0]!;
  const old = record(raw);
  if (tokens.access_token === old.key && tokens.refresh_token === old.refresh_token) return originalValue;
  // The existing Grok merge rejects missing/unverifiable freshness.
  const claims = jwtClaims(String(tokens.access_token));
  const oldClaims = jwtClaims(String(old.key));
  if (!oldClaims.iss || !oldClaims.sub || claims.iss !== oldClaims.iss || claims.sub !== oldClaims.sub) {
    throw new Error("Hermes credential refresh changed or lost the Grok account identity");
  }
  const expiry = typeof claims.exp === "number" ? claims.exp : undefined;
  return JSON.stringify({ [identity]: { ...old, key: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiry } });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid managed Hermes credential representation");
  return value as Record<string, unknown>;
}
function parseRecord(value: string) { return record(JSON.parse(value)); }
function requireTokens(value: Record<string, unknown>) {
  if (![value.access_token, value.refresh_token].every(token => typeof token === "string" && token.trim())) throw new Error("The selected subscription is missing usable credentials");
}
function jwtClaims(value: string): Record<string, unknown> {
  try { return parseRecord(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")); }
  catch { return {}; }
}
