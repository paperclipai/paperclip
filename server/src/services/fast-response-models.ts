import { models as anthropic } from "@paperclipai/adapter-claude-local";
import { models as openai } from "@paperclipai/adapter-codex-local";
import { models as google } from "@paperclipai/adapter-gemini-local";
import { models as xai } from "@paperclipai/adapter-grok-local";
import type { AiConnectionMetadata } from "@paperclipai/shared";

/** Catalogs follow the saved API connection, never the host CLI's credentials or environment. */
export function fastResponseCatalogModels(connection: Pick<AiConnectionMetadata, "provider" | "routing">) {
  if (connection.routing) return connection.routing.models ?? [];
  // `deepseek` (and any future provider) has no static adapter catalog here;
  // DeepSeek models are resolved dynamically through the ai-connections service.
  return { anthropic, openai, google, xai, openrouter: [], deepseek: [] }[connection.provider] ?? [];
}
