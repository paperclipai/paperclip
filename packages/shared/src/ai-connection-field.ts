import { z } from "zod";
import {
  aiConnectionBindingSchema,
  aiProviderSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiConnectionMetadata,
  type AiManagedConnectionSummary,
} from "./ai-connections.js";

export const AI_CONNECTION_FIELD_PROTOCOLS = ["responses", "messages", "chat", "bedrock"] as const;

export const aiConnectionFieldMetaSchema = z.object({
  harness: z.string().trim().min(1),
  providers: z.array(aiProviderSchema).optional(),
  protocols: z.array(z.enum(AI_CONNECTION_FIELD_PROTOCOLS)).optional(),
});
export type AiConnectionFieldMeta = z.infer<typeof aiConnectionFieldMetaSchema>;

export type AiConnectionFieldBinding = Exclude<AiConnectionBinding, { mode: "responsible_user" }>;

export function readAiConnectionFieldMeta(meta: Record<string, unknown> | undefined): AiConnectionFieldMeta | null {
  if (!meta || meta.aiConnection === undefined) return null;
  const parsed = aiConnectionFieldMetaSchema.safeParse(meta.aiConnection);
  return parsed.success ? parsed.data : null;
}

export function parseAiConnectionFieldBinding(value: unknown): AiConnectionFieldBinding | null {
  const parsed = aiConnectionBindingSchema.safeParse(value);
  if (!parsed.success || parsed.data.mode === "responsible_user") return null;
  return parsed.data;
}

export function aiConnectionFieldProtocol(
  connection: Pick<AiConnectionMetadata, "provider" | "routing">,
): string | null {
  if (connection.routing) return connection.routing.protocol;
  if (connection.provider === "anthropic") return "messages";
  if (connection.provider === "openai") return "responses";
  return null;
}

export function aiConnectionMatchesField(
  meta: AiConnectionFieldMeta,
  connection: Pick<AiConnectionMetadata, "provider" | "method" | "routing">,
): boolean {
  if (meta.providers && !meta.providers.includes(connection.provider)) return false;
  if (meta.protocols) {
    const protocol = aiConnectionFieldProtocol(connection);
    if (!protocol || !meta.protocols.includes(protocol as (typeof AI_CONNECTION_FIELD_PROTOCOLS)[number])) return false;
  }
  return isAiConnectionCompatible(connection, meta.harness);
}

export function aiConnectionFieldBindingFor(
  connection: Pick<AiManagedConnectionSummary, "id" | "grantId" | "provider" | "method" | "ownership">,
): AiConnectionFieldBinding {
  return {
    mode: connection.ownership === "shared" ? "shared" : "delegated",
    provider: connection.provider,
    method: connection.method,
    connectionId: connection.id,
    grantId: connection.grantId,
  };
}
