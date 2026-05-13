import { randomBytes } from "node:crypto";

import { createSessionCa, type SessionCa } from "./ca.js";

/**
 * In-memory session table + bearer cache for the credential broker.
 *
 * One BrokerSession per agent run. Stores:
 *   - the per-session ephemeral CA (used by the TLS-MITM proxy listener)
 *   - the placeholder strings the orchestrator sets in the agent's env
 *   - the allowlist of OAuth connection IDs this session may use
 *   - host-allowlist derived from connection providerId + provider YAML
 *   - the bearer cache (connectionId → latest access token), populated
 *     by CredentialBroker.pushCredential after a refresh
 *
 * The session lifetime is bounded by `expiresAt`. Expired sessions are
 * pruned lazily on lookup; callers may call `prune()` proactively.
 */

export interface BrokerSession {
  readonly sessionToken: string;
  readonly companyId: string;
  readonly runId: string;
  readonly connectionIds: ReadonlyArray<string>;
  /** envVarName → deterministic placeholder string (no secret content). */
  readonly placeholders: Readonly<Record<string, string>>;
  /** Hosts the proxy is allowed to MITM and inject for, with per-host injection rules. */
  readonly hostRules: ReadonlyMap<string, HostRule>;
  /** Ephemeral CA used for MITM TLS termination on this session. */
  readonly ca: SessionCa;
  /** Wall-clock expiration; the proxy refuses CONNECTs after this. */
  readonly expiresAt: Date;
  /** Look up the current bearer for a connection in this session. */
  bearerFor(connectionId: string): string | undefined;
  /** Record a pushed credential. Returns true if it updated an existing entry. */
  setBearer(connectionId: string, value: string): boolean;
}

export interface HostRule {
  /** OAuth connectionId this host serves on this session. */
  connectionId: string;
  /** Header to inject (e.g. "Authorization"). */
  header: string;
  /** Format string with `{value}` placeholder (e.g. "Bearer {value}"). */
  format: string;
}

export interface CreateSessionInput {
  companyId: string;
  runId: string;
  connectionIds: ReadonlyArray<string>;
  /** envVarName → connectionId mapping; the store builds the placeholders. */
  oauthEnvBindings: ReadonlyArray<{ envVarName: string; connectionId: string }>;
  /**
   * Per-connection set of allowlisted hosts and their header-injection
   * rules. Supplied by the broker at session-mint time after consulting
   * the OAuth provider registry.
   */
  hostRules: ReadonlyArray<{
    hostname: string;
    connectionId: string;
    header: string;
    format: string;
  }>;
  /** TTL in seconds; clamped to a maximum of 24h. */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function generateSessionToken(): string {
  // 32 bytes of crypto-random, url-safe base64 — short enough for headers.
  return randomBytes(32).toString("base64url");
}

function placeholderFor(connectionId: string, envVarName: string): string {
  // Deterministic, but carries no secret content. Includes the runtime
  // env var name so the proxy can detect when an agent shipped a stale
  // placeholder back upstream and strip it.
  return `__paperclip_broker_${connectionId}_${envVarName}__`;
}

export interface SessionStore {
  create(input: CreateSessionInput): BrokerSession;
  /** Look up by session token; returns undefined for missing or expired. */
  get(sessionToken: string): BrokerSession | undefined;
  /** Best-effort revoke. */
  revoke(sessionToken: string): void;
  /** Drop expired sessions; returns how many were removed. */
  prune(now?: Date): number;
  /** Aggregate write: orchestrator-pushed bearer reaches every active session. */
  setBearerEverywhere(
    companyId: string,
    connectionId: string,
    value: string,
  ): number;
  /** Test helper — number of sessions currently live. */
  size(): number;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, BrokerSession>();

  function clampTtl(ttlSeconds: number | undefined): number {
    const v = ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(v) || v < 60) return 60;
    return Math.min(MAX_TTL_SECONDS, Math.floor(v));
  }

  return {
    create(input: CreateSessionInput): BrokerSession {
      const ttl = clampTtl(input.ttlSeconds);
      const sessionToken = generateSessionToken();
      const ca = createSessionCa({ ttlSeconds: ttl });
      const expiresAt = new Date(Date.now() + ttl * 1000);
      const placeholders: Record<string, string> = {};
      for (const b of input.oauthEnvBindings) {
        placeholders[b.envVarName] = placeholderFor(
          b.connectionId,
          b.envVarName,
        );
      }
      const hostRules = new Map<string, HostRule>();
      for (const r of input.hostRules) {
        hostRules.set(r.hostname.toLowerCase(), {
          connectionId: r.connectionId,
          header: r.header,
          format: r.format,
        });
      }
      const bearerByConnection = new Map<string, string>();
      const session: BrokerSession = {
        sessionToken,
        companyId: input.companyId,
        runId: input.runId,
        connectionIds: [...input.connectionIds],
        placeholders,
        hostRules,
        ca,
        expiresAt,
        bearerFor(connectionId) {
          return bearerByConnection.get(connectionId);
        },
        setBearer(connectionId, value) {
          const prior = bearerByConnection.has(connectionId);
          bearerByConnection.set(connectionId, value);
          return prior;
        },
      };
      sessions.set(sessionToken, session);
      return session;
    },

    get(sessionToken: string): BrokerSession | undefined {
      const s = sessions.get(sessionToken);
      if (!s) return undefined;
      if (s.expiresAt.getTime() <= Date.now()) {
        sessions.delete(sessionToken);
        return undefined;
      }
      return s;
    },

    revoke(sessionToken: string): void {
      sessions.delete(sessionToken);
    },

    prune(now: Date = new Date()): number {
      let removed = 0;
      for (const [token, s] of sessions) {
        if (s.expiresAt.getTime() <= now.getTime()) {
          sessions.delete(token);
          removed++;
        }
      }
      return removed;
    },

    setBearerEverywhere(
      companyId: string,
      connectionId: string,
      value: string,
    ): number {
      let touched = 0;
      for (const s of sessions.values()) {
        if (s.companyId !== companyId) continue;
        if (!s.connectionIds.includes(connectionId)) continue;
        s.setBearer(connectionId, value);
        touched++;
      }
      return touched;
    },

    size(): number {
      return sessions.size;
    },
  };
}
