/**
 * Credential broker extension slot for Paperclip plugins.
 *
 * Plugin SDK surface for the credential broker subsystem — see
 * `docs/superpowers/specs/2026-05-12-credential-broker-design.md` for the
 * full design.
 *
 * Exactly one credential broker plugin can be registered per Paperclip
 * server process. The server-side registry consumes the registered
 * factory at startup and uses the resulting broker to mint
 * per-run sessions and push refreshed OAuth tokens.
 *
 * Behavior is gated by `PAPERCLIP_FEATURE_CREDENTIAL_BROKER`; until the
 * flag is enabled (and a broker is registered), the OAuth resolution
 * path falls back to plaintext-in-env delivery — the legacy #5805 path.
 */

import type { PluginLogger } from "./types.js";

/** How an OAuth bearer is delivered to the agent's runtime. */
export type CredentialDeliveryMode = "env" | "paperclip-broker" | "byo-broker";

/**
 * Scoped session minted by the broker for one agent run.
 *
 * The orchestrator threads `proxyUrl`, the CA cert, and the
 * placeholder env values into the spawned agent process. The agent
 * never sees the real OAuth bearer — only the placeholder string.
 */
export interface CredentialBrokerSession {
  /** Opaque one-time-use bearer; agent uses it as `Proxy-Authorization`. */
  sessionToken: string;
  /** Proxy URL the orchestrator must set as `HTTPS_PROXY` / `HTTP_PROXY`. */
  proxyUrl: string;
  /** PEM-encoded CA cert the agent process must trust for MITM TLS. */
  caCertPem: string;
  /** `envVarName` → deterministic placeholder string (carries no secret content). */
  placeholders: Record<string, string>;
}

export interface MintSessionInput {
  /** Tenant scope for the session. */
  companyId: string;
  /** Run-scoped identifier; used for audit and session lifetime. */
  runId: string;
  /** Allowlisted OAuth connection IDs for this run. */
  connectionIds: string[];
  /** The env bindings being resolved; used to compute placeholders. */
  oauthEnvBindings: Array<{
    envVarName: string;
    connectionId: string;
    field: "access";
  }>;
  /** Hint for session TTL; the broker MAY clamp. */
  ttlSeconds?: number;
}

/** Minimal description of an execution target passed to brokers. */
export interface ExecutionTargetSummary {
  /** Discriminator from the existing AdapterExecutionTarget union. */
  kind: string;
  /** Populated when `kind === "sandbox"` — e.g. `"e2b"`, `"daytona"`. */
  sandboxProvider?: string;
}

export interface CredentialBroker {
  readonly id: string;

  /** Called by the orchestrator before sandbox exec. */
  mintSession(input: MintSessionInput): Promise<CredentialBrokerSession>;

  /** Called by the refresh worker after a token rotation. */
  pushCredential(input: {
    companyId: string;
    connectionId: string;
    field: "access" | "refresh";
    value: string;
    expiresAt?: Date;
  }): Promise<void>;

  /** Called on run completion. Best-effort; failures must not propagate. */
  revokeSession(sessionToken: string): Promise<void>;

  /**
   * Capability check: can this broker's proxy listener be reached
   * from a process spawned in the given execution target?
   *
   * The smart resolver consults this to decide between
   * `paperclip-broker` and `env` (fallback). Brokers in embedded mode
   * typically return `true` only for local-subprocess targets;
   * standalone deployments return `true` for any target with
   * network reachability to their service URL.
   */
  isReachableFrom(target: ExecutionTargetSummary): boolean;
}

export interface RegisterCredentialBrokerCtx {
  /** Resolves the per-company OAuth connection allowlist for the broker. */
  resolveConnections: (companyId: string) => Promise<
    Array<{
      id: string;
      providerId: string;
      hosts: string[];
      headerInjection: { header: string; format: string };
    }>
  >;
  logger: PluginLogger;
}

export type CredentialBrokerFactory = (
  ctx: RegisterCredentialBrokerCtx,
) => CredentialBroker | Promise<CredentialBroker>;

let registered: CredentialBrokerFactory | undefined;

/**
 * Register the credential broker for this Paperclip server process.
 *
 * Exactly one broker can be registered. Calling this twice throws —
 * the loader rejects ambiguous configurations rather than silently
 * picking one.
 */
export function registerCredentialBroker(factory: CredentialBrokerFactory): void {
  if (registered) {
    throw new Error(
      "registerCredentialBroker: a credential broker is already registered. " +
        "Only one credential-broker plugin can be active per Paperclip server process.",
    );
  }
  registered = factory;
}

/**
 * @internal — consumed by the server-side registry at startup.
 * Not part of the stable plugin SDK contract.
 */
export function __consumeRegisteredCredentialBrokerFactory():
  | CredentialBrokerFactory
  | undefined {
  return registered;
}

/** @internal — test helper. */
export function __resetRegistryForTests(): void {
  registered = undefined;
}

/** @internal — test helper. */
export function __getRegisteredBrokerFactoryForTests():
  | CredentialBrokerFactory
  | undefined {
  return registered;
}
