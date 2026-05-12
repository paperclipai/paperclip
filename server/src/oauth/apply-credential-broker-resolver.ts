import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";

import type { Db } from "@paperclipai/db";
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import {
  envBindingSchema,
  type CredentialDelivery,
} from "@paperclipai/shared";
import type {
  CredentialBroker,
  CredentialBrokerSession,
} from "@paperclipai/plugin-sdk";

import type { ProviderRegistry } from "./registry.js";
import {
  resolveCredentialDelivery,
  type OAuthBindingSummary,
  type ResolveCredentialDeliveryResult,
} from "./resolve-credential-delivery.js";
import { logCredentialBrokerFallbackToEnv } from "./credential-broker-log.js";
import { resolveCredentialBroker } from "../plugins/credential-broker-registry.js";
import {
  credentialBrokerFeatureEnabled,
  credentialBrokerRequired,
} from "../config/credential-broker-flags.js";

/**
 * Glue layer between the env-binding loop in `resolveAdapterConfigForRuntime`
 * and the pure smart resolver.
 *
 * In M1 this is observational: the function runs the resolver, logs every
 * fallback to env, and (if `PAPERCLIP_REQUIRE_BROKER=1`) throws
 * `CredentialBrokerRequiredError` instead of falling back. It does NOT
 * modify the resolved env — the legacy oauth_token resolution path in
 * `secrets.ts` runs afterward and produces plaintext bearers (since no
 * broker is registered yet — M2 lands the built-in broker).
 *
 * When the feature flag is off, this function is a no-op (the resolver
 * never runs). With the flag on but no broker registered, the resolver
 * always decides `env / no_broker_registered` for Paperclip-spawned
 * runtimes, which is the same observable outcome as the legacy path.
 */

/**
 * Pull unique hostnames out of a provider's endpoints URLs. These are
 * the upstream hosts the broker's proxy will allowlist for the
 * provider's OAuth bindings.
 */
function extractHostsFromProviderConfig(config: {
  endpoints: { authorize: string; token: string; accountInfo: string; revoke?: string };
}): string[] {
  const urls = [
    config.endpoints.authorize,
    config.endpoints.token,
    config.endpoints.accountInfo,
    config.endpoints.revoke ?? "",
  ];
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.add(new URL(u).hostname);
    } catch {
      // ignore malformed
    }
  }
  return Array.from(hosts);
}

export class CredentialBrokerRequiredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly companyId: string,
  ) {
    super(
      `credential broker required (PAPERCLIP_REQUIRE_BROKER=1) but unavailable: ${reason}`,
    );
    this.name = "CredentialBrokerRequiredError";
  }
}

export interface ApplyResolverDeps {
  db: Db;
  registry: ProviderRegistry;
  logger: Logger;
}

export interface ApplyResolverInput {
  companyId: string;
  /** The raw `adapterConfig.env` record before resolution. */
  envRecord: Record<string, unknown>;
  /** Explicit per-agent override from AdapterConfig.credentialDelivery, if any. */
  explicit?: CredentialDelivery;
  /** Run identifier for log correlation; falls back to "unknown" if not threaded. */
  runId?: string | null;
  /** Agent identifier for log correlation; falls back to "unknown" if not threaded. */
  agentId?: string | null;
  /**
   * Execution-target summary; defaults to `{ kind: "local" }` in M1. M2
   * threads the real target through `SecretConsumerContext`.
   */
  executionTargetKind?: string;
  /** Optional sandbox-provider hint for logging. */
  sandboxProvider?: string;
}

export interface ApplyResolverResult {
  ran: boolean;
  decision?: ResolveCredentialDeliveryResult;
  /**
   * Populated when the resolver decided `paperclip-broker` AND a broker
   * is registered. The caller (resolveAdapterConfigForRuntime) MUST then:
   *   1. for each oauth binding, push the just-resolved bearer to the
   *      broker via `broker.pushCredential`,
   *   2. replace the bearer value in the resolved env with the matching
   *      placeholder from `brokerSession.placeholders`,
   *   3. surface `brokerSession.proxyUrl` and `brokerSession.caCertPem`
   *      to the sandbox runtime so the agent's HTTPS_PROXY and CA-trust
   *      env can be set.
   */
  brokerSession?: CredentialBrokerSession;
  /** Reference to the registered broker so the caller can `pushCredential`. */
  broker?: CredentialBroker;
}

/** Pull `oauth_token` binding summaries from a parsed env record. */
function collectOAuthBindings(
  envRecord: Record<string, unknown>,
): OAuthBindingSummary[] {
  const out: OAuthBindingSummary[] = [];
  for (const [key, rawBinding] of Object.entries(envRecord)) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const v = parsed.data as
      | string
      | { type: string; connectionId?: string; field?: "access" };
    if (typeof v === "object" && v.type === "oauth_token" && v.connectionId) {
      out.push({
        envVarName: key,
        connectionId: v.connectionId,
        field: v.field ?? "access",
      });
    }
  }
  return out;
}

/**
 * Run the smart resolver against the given dispatch. Behavior-neutral
 * in M1 — the function only observes and logs; it does not modify the
 * adapter config or env. Throws `CredentialBrokerRequiredError` when
 * `PAPERCLIP_REQUIRE_BROKER=1` and the resolver decides `env`.
 */
export async function applyCredentialBrokerResolver(
  deps: ApplyResolverDeps,
  input: ApplyResolverInput,
): Promise<ApplyResolverResult> {
  if (!credentialBrokerFeatureEnabled() && !input.explicit) {
    // Flag off and no explicit override: skip entirely. Legacy path runs.
    return { ran: false };
  }

  const oauthBindings = collectOAuthBindings(input.envRecord);
  if (oauthBindings.length === 0 && !input.explicit) {
    return { ran: false };
  }

  // Look up connections referenced by the bindings to learn their
  // providerId (for the provider-broker-supported check) and their
  // broker_targets (for the BYO check).
  const connIds = oauthBindings.map((b) => b.connectionId);
  const rows =
    connIds.length === 0
      ? []
      : await deps.db
          .select({
            id: oauthConnections.id,
            providerId: oauthConnections.providerId,
            brokerTargets: oauthConnections.brokerTargets,
          })
          .from(oauthConnections)
          .where(
            and(
              eq(oauthConnections.companyId, input.companyId),
              inArray(oauthConnections.id, connIds),
            ),
          );

  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const broker = await resolveCredentialBroker({
    resolveConnections: async (companyId) => {
      const connRows = await deps.db
        .select({
          id: oauthConnections.id,
          providerId: oauthConnections.providerId,
        })
        .from(oauthConnections)
        .where(eq(oauthConnections.companyId, companyId));
      const out: Array<{
        id: string;
        providerId: string;
        hosts: string[];
        headerInjection: { header: string; format: string };
      }> = [];
      for (const row of connRows) {
        const provider = deps.registry.get(row.providerId);
        if (!provider) continue;
        if (provider.config.broker?.supported !== true) continue;
        const hosts = extractHostsFromProviderConfig(provider.config);
        if (hosts.length === 0) continue;
        out.push({
          id: row.id,
          providerId: row.providerId,
          hosts,
          // OAuth bearer is the convention for all the providers we
          // ship in M3 (github, slack, linear, …). Per-provider header
          // overrides can be added later by extending the YAML.
          headerInjection: { header: "Authorization", format: "Bearer {value}" },
        });
      }
      return out;
    },
    logger: deps.logger,
  });

  const decision = resolveCredentialDelivery({
    explicit: input.explicit,
    executionTarget: {
      kind: input.executionTargetKind ?? "local",
      sandboxProvider: input.sandboxProvider,
    },
    oauthBindings,
    registeredBroker: broker,
    hasBrokerTargetsFor: (cid) => {
      const row = byId.get(cid);
      return (row?.brokerTargets?.length ?? 0) > 0;
    },
    providerBrokerSupported: (cid) => {
      const row = byId.get(cid);
      if (!row) return false;
      const provider = deps.registry.get(row.providerId);
      return provider?.config.broker?.supported === true;
    },
  });

  if (decision.mode === "env") {
    // Don't log the "no oauth bindings" reason — it's a non-event.
    // Don't log explicit_config — operator opted in, no remediation needed.
    if (
      decision.reason !== "no_oauth_bindings" &&
      decision.reason !== "explicit_config"
    ) {
      logCredentialBrokerFallbackToEnv(deps.logger, {
        runId: input.runId ?? "unknown",
        agentId: input.agentId ?? "unknown",
        executionTargetKind: input.executionTargetKind ?? "local",
        sandboxProvider: input.sandboxProvider,
        reason: decision.reason,
        bindings: oauthBindings.map((b) => ({
          envVarName: b.envVarName,
          connectionId: b.connectionId,
        })),
      });
      if (credentialBrokerRequired()) {
        throw new CredentialBrokerRequiredError(
          decision.reason,
          input.companyId,
        );
      }
    }
  } else if (decision.mode === "paperclip-broker" && broker) {
    // M2: actually mint a session. The caller will (1) push bearers to
    // the broker and (2) swap env values with placeholders before
    // returning resolved config to its caller.
    const brokerSession = await broker.mintSession({
      companyId: input.companyId,
      runId: input.runId ?? "unknown",
      connectionIds: oauthBindings.map((b) => b.connectionId),
      oauthEnvBindings: oauthBindings.map((b) => ({
        envVarName: b.envVarName,
        connectionId: b.connectionId,
        field: "access",
      })),
    });
    return { ran: true, decision, brokerSession, broker };
  } else {
    // byo-broker path: the orchestrator doesn't mint a session;
    // the operator's broker is fed by the refresh worker's push.
    // Caller still uses placeholders (deterministic from the binding
    // shape) but we don't have a CA / proxy URL to surface.
    deps.logger.debug(
      {
        event: "credential-broker-byo-mode-selected",
        companyId: input.companyId,
        runId: input.runId,
        agentId: input.agentId,
        decided_mode: decision.mode,
        reason: decision.reason,
      },
      "credential broker decided byo-broker; caller substitutes placeholders only",
    );
  }

  return { ran: true, decision };
}
