import { z } from "zod";
import { aiProviderRoutingSchema, aiRoutingHarness, isAiRoutingCompatible, type AiProviderRouting } from "./ai-provider-routing.js";

/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion(
  "connectionPurpose",
  [
    z.object({
      connectionPurpose: z.literal("tool"),
      transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
      connectionPurpose: z.literal("channel"),
      transport: z.enum(["chat_sdk", "rest_api", "voice"]),
      config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine(
      (connection) => connection.transport === "voice" ? connection.config?.provider === "speko" : connection.transport === "chat_sdk" ? connection.config?.provider !== "speko" : connection.config?.provider === "agentmail",
      { message: "Channel transport must match its provider: voice for Speko, REST for AgentMail, Chat SDK otherwise", path: ["config", "provider"] },
    ),
    z.object({
      connectionPurpose: z.literal("ai"),
      transport: z.literal("runtime_auth"),
    }),
  ],
);
export type ConnectionPurposeTransport = z.infer<
  typeof connectionPurposeTransportSchema
>;

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "xai",
  "google",
] as const;
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key"]);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiAuthMethod = z.infer<typeof aiAuthMethodSchema>;
const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: aiProviderSchema,
    // Retained on the wire for older servers during rolling upgrades. The
    // responsible user's provider default determines the actual run method.
    method: aiAuthMethodSchema,
    mode: z.literal("responsible_user"),
  }).strict(),
  z
    .object({
      ...requirement,
      mode: z.literal("shared"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requirement,
      // Explicit personal selection. Human access still applies on every run.
      mode: z.literal("delegated"),
      connectionId: z.string().uuid(),
      grantId: z.string().uuid(),
    })
    .strict(),
]);
export type AiConnectionBinding = z.infer<typeof aiConnectionBindingSchema>;
/**
 * Anthropic's two credential variables authenticate with different headers, so a
 * connection has to remember which one its key came from to inject it correctly.
 */
const aiKeyVariableSchema = z.enum(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
/**
 * The model ladder an import resolved: the tier it folded down to the default,
 * and the rest of the ladder the operator may still pick from. Only an import
 * carries one, because only an import reads a tier ladder at all.
 */
export const aiConnectionModelTiersSchema = z
  .object({
    default: z.string().min(1),
    alternatives: z.array(z.string()).default([]),
  })
  .strict();
export type AiConnectionModelTiers = z.infer<typeof aiConnectionModelTiersSchema>;
export const aiConnectionMetadataSchema = z
  .object({
    ...requirement,
    routing: aiProviderRoutingSchema.optional(),
    baseUrl: z.string().url().optional(),
    keyVariable: aiKeyVariableSchema.optional(),
    models: aiConnectionModelTiersSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { baseUrl, keyVariable } = value;
    // Endpoint fields are only meaningful for direct API-key access: a subscription
    // login always drives the official endpoint, and no other provider reads them.
    if (
      (baseUrl || keyVariable) &&
      (value.provider !== "anthropic" || value.method !== "api_key")
    ) {
      ctx.addIssue({
        code: "custom",
        path: [baseUrl ? "baseUrl" : "keyVariable"],
        message: "A custom endpoint requires an Anthropic API-key connection",
      });
    }
    // Runtime injection and probing both need the endpoint together with the
    // variable its key belongs to, so neither may travel alone.
    if (Boolean(baseUrl) !== Boolean(keyVariable)) {
      ctx.addIssue({
        code: "custom",
        path: [baseUrl ? "keyVariable" : "baseUrl"],
        message:
          "A custom endpoint requires both a base URL and the key variable it authenticates with",
      });
    }
    // The ladder decides which model an agent with none of its own runs on that
    // gateway, so it cannot outlive the endpoint it was read from: a connection
    // that re-imports onto another gateway overwrites it wholesale rather than
    // keeping tiers that belong to the previous one.
    if (value.models && !(baseUrl && keyVariable)) {
      ctx.addIssue({
        code: "custom",
        path: ["models"],
        message:
          "Model tiers require the custom endpoint they were imported with",
      });
    }
  });
export type AiConnectionMetadata = z.infer<typeof aiConnectionMetadataSchema>;

/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES: Record<
  AiProvider,
  {
    name: string;
    methods: Partial<
      Record<AiAuthMethod, { adapters: readonly string[]; envKey: string }>
    >;
  }
> = {
  google: { name: "Google", methods: { api_key: { adapters: ["gemini_local"], envKey: "GEMINI_API_KEY" } } },
  anthropic: {
    name: "Claude",
    methods: {
      subscription: {
        adapters: ["claude_local"],
        envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      api_key: { adapters: ["claude_local"], envKey: "ANTHROPIC_API_KEY" },
    },
  },
  openai: {
    name: "OpenAI",
    methods: {
      subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
      api_key: { adapters: ["codex_local"], envKey: "OPENAI_API_KEY" },
    },
  },
  openrouter: {
    name: "OpenRouter",
    methods: {
      api_key: { adapters: ["opencode_local"], envKey: "OPENROUTER_API_KEY" },
    },
  },
  xai: {
    name: "Grok",
    methods: {
      subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
      api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
    },
  },
};
export function isAiConnectionCompatible(
  requirement: AiConnectionMetadata | AiConnectionBinding,
  adapterType: string,
  model?: unknown,
  runnerProvider?: unknown,
  acpxAgent?: unknown,
): boolean {
  adapterType = aiRoutingHarness(adapterType, runnerProvider, acpxAgent);
  if ("routing" in requirement && requirement.routing) return requirement.method === "api_key" && isAiRoutingCompatible(requirement.routing, adapterType);
  // A fixed binding contains identity only. The service checks authoritative
  // connection metadata before resolving credentials or running the harness.
  if ("mode" in requirement && requirement.mode !== "responsible_user" && requirement.method === "api_key")
    return ["claude_local", "codex_local", "opencode_local", "hermes_local", "gemini_local", "grok_local"].includes(adapterType);
  const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
  const candidates = "mode" in requirement && requirement.mode === "responsible_user"
    ? Object.values(methods)
    : requirement.method ? [methods[requirement.method]] : [];
  return (
    candidates.some((method) => method?.adapters.includes(adapterType)) &&
    (requirement.provider !== "openrouter" ||
      (typeof model === "string" && model.startsWith("openrouter/")))
  );
}
export type AiConnectionUnavailableReason =
  | "responsible_user_missing"
  | "membership_missing"
  | "default_missing"
  | "connection_missing"
  | "connection_unavailable"
  | "incompatible"
  | "access_denied"
  | "credential_missing";
export interface AiConnectionAttribution {
  /** Billing account at execution time; never resolved again from mutable settings. */
  subscriptionId?: string;
  connectionId: string;
  grantId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  mode: AiConnectionBinding["mode"];
  responsibleUserId: string | null;
  /** Custom gateway endpoint, present on imported Anthropic API-key connections. */
  baseUrl?: string;
  /** Which credential variable the connection's key was imported from. */
  keyVariable?: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  /** Model ladder the import resolved, for an agent that names no model. */
  models?: AiConnectionModelTiers;
}
export type AiConnectionResolution =
  | { ok: true; attribution: AiConnectionAttribution }
  | { ok: false; reason: AiConnectionUnavailableReason; message: string };

export interface AiManagedConnectionSummary {
  id: string;
  grantId: string;
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
  name: string;
  routing?: AiProviderRouting;
  accountLabel?: string;
  ownership: "personal" | "shared";
  ownerUserId?: string;
  ownerName?: string;
  isDefault: boolean;
  status: "connected" | "needs_attention" | "expired" | "revoked";
  unavailableReason?: string;
  usageProbeSupported?: boolean;
  baseUrl?: string;
  keyVariable?: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  /** Model ladder the import resolved, shown beside the endpoint it came from. */
  models?: AiConnectionModelTiers;
}
export interface AiConnectionList {
  currentUserId: string;
  pools?: import("./ai-connection-router.js").AiConnectionPool[];
  canManageConnections: boolean;
  connections: AiManagedConnectionSummary[];
}
export const createAiConnectionSchema = z
  .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    routing: aiProviderRoutingSchema.optional(),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    loginSessionId: z.string().max(128).optional(),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
      ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    if (v.routing && (v.method !== "api_key" || (v.routing.kind === "openrouter" && v.provider !== "openrouter") || (v.routing.kind === "bedrock" && v.provider !== "anthropic")))
      ctx.addIssue({ code: "custom", message: "Routing requires the matching provider and API authentication." });
    if (v.routing && ["gateway", "local"].includes(v.routing.kind) && v.provider !== (v.routing.protocol === "messages" ? "anthropic" : "openai"))
      ctx.addIssue({ code: "custom", message: "The provider must match the endpoint’s API format." });
    if (v.routing?.auth === "none") {
      if (v.apiKey || v.loginSessionId) ctx.addIssue({ code: "custom", message: "Provide only the selected authentication method." });
      return;
    }
    if (
      v.method === "api_key"
        ? !v.apiKey || Boolean(v.loginSessionId)
        : !v.loginSessionId || Boolean(v.apiKey)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide exactly the credential for the selected sign-in method",
      });
    }
  });
export type CreateAiConnection = z.infer<typeof createAiConnectionSchema>;

export const aiConnectionLoginIntentSchema = z
  .object({
    provider: z.enum(["anthropic", "openai", "xai"]),
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
  })
  .strict();
export type AiConnectionLoginIntent = z.infer<
  typeof aiConnectionLoginIntentSchema
>;

export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
  localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
export interface LocalAiLoginStatus {
  status: "ready" | "sign_in_required" | "expired";
  authorizationUrl?: string;
  code?: string;
  error?: string;
}
export interface LocalAiLoginAttempt {
  sessionId: string;
  /** Grok still uses terminal sign-in until it has an in-app login runner. */
  command?: string;
  expiresAt: string;
}

/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config: Record<string, unknown> | undefined): boolean {
  const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
  return metadata.success && metadata.data.method === "subscription" &&
    (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
    config?.aiIsolatedSubscription !== true;
}

/**
 * Import input for the dedicated local-Claude-config route. `CreateAiConnection`
 * deliberately stays free of endpoint fields: a client-submitted endpoint is never
 * trusted, so this route re-reads the file server-side and the `confirm` block only
 * carries the non-confidential summary the user saw, for a field-by-field diff. The
 * credential itself is never part of this payload.
 */
export const localClaudeConfigImportInputSchema = z
  .object({
    provider: z.literal("anthropic"),
    method: z.literal("api_key"),
    name: z.string().trim().min(1).max(160),
    /**
     * The model the operator confirmed on the card: the tier the read folded,
     * or their own edit of it (PRODUCT #19). The alternatives beside it are not
     * taken from here — the route assembles the ladder from the file it just
     * read, so a caller cannot name models the connection never saw.
     */
    model: z.string().trim().min(1),
    ownership: z.enum(["personal", "shared"]),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
    connectionId: z.string().uuid().optional(),
    /**
     * The execution environment the importing surface selected, when it has
     * one. A surface with no agent yet — onboarding, the new-agent wizard —
     * judges reachability against the environment the run will actually use,
     * not against the instance default, which can point somewhere the operator
     * never chose for this agent.
     */
    environmentId: z.string().uuid().nullish(),
    baseUrl: z.string().url(),
    keyVariable: aiKeyVariableSchema,
    confirm: z
      .object({
        keyVariable: aiKeyVariableSchema,
        maskedKey: z.string().min(1),
        defaultModel: z.string().min(1),
        alternativeModels: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type LocalClaudeConfigImportInput = z.infer<
  typeof localClaudeConfigImportInputSchema
>;

/** What the server reads from the operator's own Claude settings file. */
export const localClaudeConfigReadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      baseUrl: z.string(),
      keyVariable: aiKeyVariableSchema,
      maskedKey: z.string(),
      models: z.object({ default: z.string(), alternatives: z.array(z.string()) }),
      suggestedName: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum([
        "settings_unreadable",
        "env_block_missing",
        "base_url_missing",
        "key_missing",
        "models_missing",
      ]),
      message: z.string(),
    })
    .strict(),
]);
export type LocalClaudeConfigReadResult = z.infer<
  typeof localClaudeConfigReadResultSchema
>;
