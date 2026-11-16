import { models as anthropic } from "@paperclipai/adapter-claude-local";
import { models as openai } from "@paperclipai/adapter-codex-local";
import { models as google } from "@paperclipai/adapter-gemini-local";
import { models as xai } from "@paperclipai/adapter-grok-local";
import type { AiConnectionMetadata } from "@paperclipai/shared";

/** Catalogs follow the saved API connection, never the host CLI's credentials or environment. */
export function fastResponseCatalogModels(connection: Pick<AiConnectionMetadata, "provider" | "routing">) {
  if (connection.routing) return connection.routing.models ?? [];
  // Kimi and DeepSeek expose no fast-response catalog. They stay undefined rather
  // than an empty list, so the picker cannot configure a fast response that
  // fastResponseProvider would fall back to sending through its xAI client.
  return { anthropic, openai, google, xai, openrouter: [], github: [], kimi: undefined, deepseek: undefined }[connection.provider];
}
