import {
  type CredentialBroker,
  type CredentialBrokerSession,
  type ExecutionTargetSummary,
  type MintSessionInput,
  type RegisterCredentialBrokerCtx,
} from "@paperclipai/plugin-sdk";

import { createSessionStore, type SessionStore } from "./session-store.js";
import { createProxyListener, type ProxyListener } from "./proxy-listener.js";

/**
 * Built-in credential broker. Implementation of the SDK's CredentialBroker
 * interface that:
 *
 *   - keeps an in-memory session store (M2.2)
 *   - runs the TLS-MITM forward proxy (M2.3) on loopback by default
 *   - exposes mintSession / pushCredential / revokeSession / isReachableFrom
 *     to the server-side resolver
 *
 * `isReachableFrom` is conservative: returns `true` only for runtimes
 * whose process can dial loopback on this host. Remote sandboxes
 * (e2b, daytona, kubernetes Pod off-host) need the standalone bootstrap
 * mode (M3.3) — until then, the smart resolver falls back to `env` for
 * those runtimes with `reason: broker_unreachable_from_runtime`.
 */

export interface BuiltinBrokerOptions {
  /** Listener host; defaults to loopback (`127.0.0.1`). */
  listenHost?: string;
  /** Listener port; defaults to 0 (ephemeral, OS-assigned). */
  listenPort?: number;
  /** Session TTL hint passed to the store (clamped to ≤24h). */
  defaultSessionTtlSeconds?: number;
}

export interface BuiltinBroker extends CredentialBroker {
  /** Start the proxy listener. Idempotent. */
  start(): Promise<void>;
  /** Stop the proxy listener. */
  stop(): Promise<void>;
  /** @internal — test helper exposing the underlying store. */
  __store(): SessionStore;
}

/** Local subprocess and SSH targets can dial our loopback listener. */
const REACHABLE_TARGET_KINDS = new Set([
  "local",
  "subprocess",
  "ssh", // ssh-tunneled localhost — typically reachable
]);

export function createBuiltinBroker(
  ctx: RegisterCredentialBrokerCtx,
  options: BuiltinBrokerOptions = {},
): BuiltinBroker {
  const store = createSessionStore();
  const proxy: ProxyListener = createProxyListener({
    store,
    log: (entry) => {
      // sessionToken is the live Proxy-Authorization bearer — runId +
      // companyId are sufficient for correlation, so drop the token from
      // the structured fields to avoid leaking a replayable credential
      // into application logs.
      const { sessionToken: _sessionToken, ...redacted } = entry;
      ctx.logger.info("credential broker proxied request", {
        event: "credential-broker-request",
        ...redacted,
      });
    },
  });
  let started = false;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  // Period between sweeps of the in-memory session store. Without a
  // scheduled prune, expired sessions (each holding an RSA-2048 CA
  // keypair + per-host leaf cache) accumulate until their token is
  // looked up again — which never happens for completed runs. 60s is
  // well under typical session TTLs and well over the cost of one
  // O(active sessions) sweep.
  const PRUNE_INTERVAL_MS = 60_000;

  return {
    id: "builtin",

    async start(): Promise<void> {
      if (started) return;
      await proxy.listen({
        host: options.listenHost ?? "127.0.0.1",
        port: options.listenPort,
      });
      started = true;
      pruneTimer = setInterval(() => {
        try {
          store.prune();
        } catch (err) {
          ctx.logger.warn("credential broker prune failed", {
            event: "credential-broker-prune-failed",
            err: { message: (err as Error).message },
          });
        }
      }, PRUNE_INTERVAL_MS);
      // Don't keep the event loop alive purely for pruning — if the
      // server process is exiting, we want it to.
      pruneTimer.unref?.();
      ctx.logger.info("credential broker listener started", {
        event: "credential-broker-started",
        mode: "embedded",
        proxyUrl: proxy.proxyUrl(),
      });
    },

    async stop(): Promise<void> {
      if (!started) return;
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = undefined;
      }
      await proxy.close();
      started = false;
    },

    async mintSession(input: MintSessionInput): Promise<CredentialBrokerSession> {
      // Resolve the host-injection rules from the connection allowlist.
      const connections = await ctx.resolveConnections(input.companyId);
      const allowedById = new Map(
        connections
          .filter((c) => input.connectionIds.includes(c.id))
          .map((c) => [c.id, c] as const),
      );
      const hostRules: Array<{
        hostname: string;
        connectionId: string;
        header: string;
        format: string;
      }> = [];
      for (const cid of input.connectionIds) {
        const conn = allowedById.get(cid);
        if (!conn) continue; // resolveConnections filtered it out
        for (const host of conn.hosts) {
          hostRules.push({
            hostname: host,
            connectionId: conn.id,
            header: conn.headerInjection.header,
            format: conn.headerInjection.format,
          });
        }
      }

      const session = store.create({
        companyId: input.companyId,
        runId: input.runId,
        connectionIds: input.connectionIds,
        oauthEnvBindings: input.oauthEnvBindings.map((b) => ({
          envVarName: b.envVarName,
          connectionId: b.connectionId,
        })),
        hostRules,
        ttlSeconds:
          input.ttlSeconds ?? options.defaultSessionTtlSeconds,
      });

      // Lazy-start the proxy if it isn't running yet — convenient for
      // tests and small deployments that don't run a startup hook.
      if (!started) await this.start();

      return {
        sessionToken: session.sessionToken,
        proxyUrl: proxy.proxyUrl(),
        caCertPem: session.ca.caPem,
        placeholders: { ...session.placeholders },
      };
    },

    async pushCredential(input: {
      companyId: string;
      connectionId: string;
      field: "access" | "refresh";
      value: string;
      expiresAt?: Date;
    }): Promise<void> {
      // The broker only injects access tokens — refresh tokens stay in
      // the server's company_secrets pipeline and are never handed to
      // the proxy. A pushCredential for `refresh` is a no-op.
      if (input.field !== "access") return;
      store.setBearerEverywhere(input.companyId, input.connectionId, input.value);
    },

    async revokeSession(sessionToken: string): Promise<void> {
      store.revoke(sessionToken);
    },

    isReachableFrom(target: ExecutionTargetSummary): boolean {
      return REACHABLE_TARGET_KINDS.has(target.kind);
    },

    __store(): SessionStore {
      return store;
    },
  };
}

export function registerBuiltinCredentialBroker(
  registerCredentialBroker: (
    factory: (ctx: RegisterCredentialBrokerCtx) => CredentialBroker | Promise<CredentialBroker>,
  ) => void,
  options?: BuiltinBrokerOptions,
): void {
  registerCredentialBroker((ctx) => createBuiltinBroker(ctx, options));
}
