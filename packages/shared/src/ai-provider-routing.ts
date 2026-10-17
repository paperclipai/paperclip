import { z } from "zod";

/**
 * Whether a URL host is an address a local endpoint may use.
 *
 * "Local" means the agent's own environment can reach the address but the open
 * internet cannot: loopback (localhost, 127/8, ::1) and the private network
 * ranges — 10/8, 172.16/12 and 192.168/16 for IPv4, fc00::/7 (unique-local) and
 * fe80::/10 (link-local) for IPv6. That is where self-hosted model servers
 * (LiteLLM, vLLM behind a proxy, Ollama) actually live: on a neighbouring
 * machine on the same LAN rather than on the agent's own loopback interface.
 *
 * Public addresses and hostnames never qualify, so a `local` route can never
 * be pointed at the open internet over plain HTTP — that combination is
 * reserved for the `gateway` kind, which requires HTTPS.
 */
export function isLocalEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((part) => Number(part));
    if (octets.some((part) => part > 255)) return false;
    if (octets[0] === 127) return true; // loopback, 127/8
    if (octets[0] === 10) return true; // 10/8
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true; // 172.16/12
    if (octets[0] === 192 && octets[1] === 168) return true; // 192.168/16
    return false;
  }
  if (host.includes(":")) {
    // A leading "::" is zero hextets, so the first hextet is 0: the address is
    // neither ULA nor link-local. `::1` is handled above; everything else that
    // starts with `::` is out of range by construction.
    if (host.startsWith("::")) return false;
    const first = host.split(":")[0] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
    const value = Number.parseInt(first, 16);
    if (value >= 0xfc00 && value <= 0xfdff) return true; // ULA, fc00::/7
    if (value >= 0xfe80 && value <= 0xfebf) return true; // link-local, fe80::/10
    return false;
  }
  // Hostnames resolve somewhere the validator cannot see; only address literals
  // can be vouched for here.
  return false;
}

/** Value-free routing stored on the connection, never supplied by an agent binding. */
export const aiProviderRoutingSchema = z
  .object({
    kind: z.enum(["openrouter", "bedrock", "gateway", "local"]),
    protocol: z.enum(["responses", "messages", "chat", "bedrock"]),
    baseUrl: z.string().trim().max(2048).optional(),
    auth: z
      .enum(["bearer", "api_key", "none"])
      .default("bearer"),
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
      .optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(256),
            label: z.string().trim().max(160).optional(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((route, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (route.kind === "bedrock") {
      if (
        route.protocol !== "bedrock" ||
        !route.region ||
        route.auth !== "bearer" ||
        route.baseUrl
      )
        invalid(
          "Bedrock requires a region and a Bedrock API key.",
        );
    } else if (
      route.protocol === "bedrock" ||
      route.region
    )
      invalid("AWS settings require Bedrock.");
    if (
      route.kind === "openrouter" &&
      (route.baseUrl || route.auth !== "bearer")
    )
      invalid("OpenRouter uses its official endpoint and an API key.");
    if (route.auth === "api_key" && route.protocol !== "messages")
      invalid("API-key header authentication requires Anthropic Messages.");
    if (route.kind === "gateway" || route.kind === "local") {
      try {
        const url = new URL(route.baseUrl ?? "");
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
          url.hostname,
        );
        // Plain HTTP is allowed to loopback for either kind. For `local`,
        // private network addresses (10/8, 172.16/12, 192.168/16, ULA and
        // link-local IPv6) count as local too — that is where self-hosted
        // model servers live. `gateway` keeps the narrower loopback rule,
        // because a public-facing endpoint that accepts only HTTPS is the
        // gateway contract.
        const httpAllowed = route.kind === "local"
          ? isLocalEndpointHost(url.hostname)
          : loopback;
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== "https:" && !(url.protocol === "http:" && httpAllowed))
        )
          throw new Error();
        if (route.kind === "local" && !httpAllowed)
          invalid(
            "A local endpoint must use localhost or a private network address (10.x, 172.16-31.x, or 192.168.x). Other addresses require an HTTPS gateway.",
          );
      } catch {
        invalid(
          "Enter a base URL without credentials, query parameters, or a fragment. HTTPS is required unless the endpoint is local (loopback or private network).",
        );
      }
    }
  });
export type AiProviderRouting = z.infer<typeof aiProviderRoutingSchema>;
export function aiRoutingHarness(
  adapter: string,
  provider?: unknown,
  acpxAgent?: unknown,
): string {
  if (adapter !== "paperclip_runner") return adapter;
  const runner =
    provider === "acpx" && (acpxAgent === "claude" || acpxAgent === "grok")
      ? acpxAgent
      : provider;
  return (
    (
      {
        claude: "claude_local",
        codex: "codex_local",
        opencode: "opencode_local",
        grok: "grok_local",
      } as Record<string, string>
    )[String(runner)] ?? "unsupported"
  );
}
export function isAiRoutingCompatible(
  route: AiProviderRouting,
  harness: string,
): boolean {
  if (route.kind === "bedrock") return harness === "claude_local";
  if (route.kind === "openrouter")
    return [
      "claude_local",
      "codex_local",
      "opencode_local",
      "hermes_local",
    ].includes(harness);
  if (route.protocol === "responses") return harness === "codex_local";
  if (route.protocol === "messages") return harness === "claude_local";
  return ["opencode_local", "hermes_local"].includes(harness);
}
export function aiRoutingBaseUrl(
  route: AiProviderRouting,
  harness: string,
): string {
  return route.kind === "openrouter"
    ? `https://openrouter.ai/api${harness === "claude_local" ? "" : "/v1"}`
    : (route.baseUrl ?? "").replace(/\/+$/, "");
}

/** OpenCode names models with a provider prefix; other harnesses use the raw ID. */
export function aiRoutingModel(
  route: AiProviderRouting,
  harness: string,
  model: string,
): string {
  if (!model || harness !== "opencode_local") return model;
  const prefix = route.kind === "openrouter" ? "openrouter" : "paperclip";
  return model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`;
}

/** Catalog identity is derived from routing, including accounts saved before these rows existed. */
export function aiConnectionCatalogSlug(provider: string, routing?: Pick<AiProviderRouting, "kind" | "protocol">): string {
  if (routing?.kind === "gateway") {
    return routing.protocol === "messages" ? "messages-api"
      : routing.protocol === "chat" ? "chat-completions-api" : "responses-api";
  }
  return routing?.kind ?? provider;
}

/** Direct catalog setup presets; legacy gateway links still open their existing setup. */
export function aiProviderSetupPreset(source: string | null): {
  provider: "openrouter" | "bedrock" | "gateway" | "local" | "google";
  protocol?: AiProviderRouting["protocol"];
  label?: string;
} | undefined {
  switch (source) {
    case "responses-api": return { provider: "gateway", protocol: "responses", label: "Responses API" };
    case "messages-api": return { provider: "gateway", protocol: "messages", label: "Messages API" };
    case "chat-completions-api": return { provider: "gateway", protocol: "chat", label: "Chat Completions API" };
    case "google-ai": return { provider: "google" };
    case "google": case "openrouter": case "bedrock": case "gateway": case "local": return { provider: source };
    default: return undefined;
  }
}
