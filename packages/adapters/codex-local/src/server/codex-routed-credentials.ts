export interface CodexManagedRouting {
  auth: string;
  providerKey: string | null | undefined;
}

const PROJECTED_KEY_ROUTING_KINDS = new Set(["local", "gateway", "openrouter"]);

export function readManagedCodexRouting(config: Record<string, unknown>): CodexManagedRouting | null {
  if (!config.managedAiConnection) return null;
  const routing = config.managedAiRouting;
  if (typeof routing !== "object" || routing === null) return null;
  const { kind, auth } = routing as Record<string, unknown>;
  if (typeof kind !== "string" || !PROJECTED_KEY_ROUTING_KINDS.has(kind)) return null;
  if (typeof auth !== "string") return null;
  const env = config.env;
  const providerKey =
    typeof env === "object" && env !== null ? (env as Record<string, unknown>).PAPERCLIP_AI_PROVIDER_KEY : undefined;
  return { auth, providerKey: typeof providerKey === "string" ? providerKey : null };
}

export function isManagedRoutingReady(routing: CodexManagedRouting): boolean {
  return routing.auth === "none" || (routing.providerKey ?? "").trim().length > 0;
}
