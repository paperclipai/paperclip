import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { clusterTenantPolicies, companySecrets, companySecretVersions, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { clusterTenantPoliciesService } from "../services/cluster-tenant-policies.js";
import { issueGitCredentials, type SecretService } from "../services/git-credentials.js";
import { logger } from "../middleware/logger.js";
import { bootstrapTokensService } from "../services/bootstrap-tokens.js";
import { runJwtService, type RunJwtService } from "../services/run-jwt.js";
import { createAgentAuthExchangeRoute } from "./agent-auth-exchange.js";
import { createRunsEventsRoute, type RunEventInput } from "./runs-events.js";
import {
  createWorkspaceGitCredentialsRoute,
  type IssueGitCredentialsResult,
} from "./workspace-git-credentials.js";

const RUN_JWT_TTL_SECONDS = 3600;
const BOOTSTRAP_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_TOKEN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Sliding-window in-memory rate limiter. Mirrors the shape of
// company-search-rate-limit.ts; kept inline because these limits are
// k8s-callback-specific. For multi-replica deployments this would be lifted to
// Redis — that's tracked in docs/k8s-execution/CHANGELOG.md.
//
// Without periodic eviction the `hits` Map would grow unboundedly: keys for
// run IDs and client IPs that were active once but never again would persist
// for the lifetime of the process. We sweep idle keys every windowMs.
export interface SlidingWindowLimiter {
  consume(key: string): { allowed: boolean; retryAfterSeconds: number };
  /** Stop the eviction interval. Tests must call this to let the process exit. */
  stop(): void;
}

function createSlidingWindowLimiter(opts: { windowMs: number; max: number }): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  const sweep = () => {
    const cutoff = Date.now() - opts.windowMs;
    for (const [key, ts] of hits) {
      // Drop keys whose newest hit is already outside the window — they cannot
      // affect any future consume() decision.
      const newest = ts.length > 0 ? ts[ts.length - 1]! : 0;
      if (newest <= cutoff) hits.delete(key);
    }
  };
  // unref() so the interval doesn't keep the event loop alive in tests / CLI.
  const sweeper = setInterval(sweep, opts.windowMs);
  if (typeof sweeper.unref === "function") sweeper.unref();
  return {
    consume(key) {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= opts.max) {
        const oldest = recent[0] ?? now;
        hits.set(key, recent);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + opts.windowMs - now) / 1000)),
        };
      }
      recent.push(now);
      hits.set(key, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    stop() { clearInterval(sweeper); },
  };
}

function clientIp(req: Request): string {
  // express respects `trust proxy` if set; this falls back to req.ip otherwise.
  // The downstream key is opaque, so any stable identifier works.
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function bearer(req: Request): string | undefined {
  const a = req.get("authorization");
  return a ?? undefined;
}

/**
 * Append a run event from an authenticated agent shim into heartbeat_run_events.
 * Looks up the run row to learn agentId/companyId, then inserts at next seq.
 *
 * Returns false if the run is unknown (treated as 404 by the caller).
 *
 * Concurrent appends for the same runId are serialized via a row-level lock on
 * the heartbeat_runs row (SELECT ... FOR UPDATE inside a transaction). Without
 * the lock, two concurrent callers could both read the same max(seq) and insert
 * duplicates — the (run_id, seq) index is non-unique so this would silently
 * corrupt event ordering.
 */
async function appendShimRunEvent(
  db: Db,
  input: RunEventInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update");
    if (!run) return false;

    const [seqRow] = await tx
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id));
    const nextSeq = Number(seqRow?.maxSeq ?? 0) + 1;

    await tx.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq: nextSeq,
      eventType: input.type,
      payload: input.payload,
    });
    return true;
  });
}

/**
 * Resolve a per-company secret by UUID via the existing SecretProvider
 * registry. Reads the secret's latest version row and delegates decryption
 * to the matching provider. Throws if the secret or version is not found,
 * or if the provider is unsupported. The caller (issueGitCredentials)
 * maps any thrown error to `{ok: false, reason: "internal_error"}`.
 */
function createDbBackedSecretService(db: Db): SecretService {
  return {
    async resolve(secretId: string, companyId: string): Promise<string> {
      const [secret] = await db
        .select()
        .from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
      if (!secret) throw new Error(`secret not found: ${secretId}`);
      const [versionRow] = await db
        .select()
        .from(companySecretVersions)
        .where(and(
          eq(companySecretVersions.secretId, secret.id),
          eq(companySecretVersions.version, secret.latestVersion),
        ));
      if (!versionRow) throw new Error(`secret version not found: ${secretId} v${secret.latestVersion}`);
      const provider = getSecretProvider(secret.provider as SecretProvider);
      return provider.resolveVersion({
        material: versionRow.material as Record<string, unknown>,
        externalRef: secret.externalRef ?? null,
      });
    },
  };
}

export interface K8sCallbackRoutesOptions {
  /** Optional override (used by tests). Production reads PAPERCLIP_RUN_JWT_SECRET. */
  runJwt?: RunJwtService;
}

export function k8sCallbackRoutes(db: Db, options: K8sCallbackRoutesOptions = {}) {
  const router = Router();

  const runJwt = options.runJwt ?? (() => {
    const secret = process.env.PAPERCLIP_RUN_JWT_SECRET?.trim();
    if (!secret) {
      throw new Error(
        "PAPERCLIP_RUN_JWT_SECRET is required to run the k8s callback routes (used to sign agent-shim run JWTs)",
      );
    }
    return runJwtService(secret);
  })();

  const bootstrapTokens = bootstrapTokensService(db);
  const bootstrapTokenCleanupTimer = setInterval(() => {
    bootstrapTokens.purgeExpired({ olderThanMs: BOOTSTRAP_TOKEN_RETENTION_MS })
      .catch((err: unknown) => {
        logger.warn({ err }, "bootstrap token retention cleanup failed");
      });
  }, BOOTSTRAP_TOKEN_CLEANUP_INTERVAL_MS);
  if (typeof bootstrapTokenCleanupTimer.unref === "function") bootstrapTokenCleanupTimer.unref();

  const exchangeHandler = createAgentAuthExchangeRoute({
    bootstrapTokens,
    runJwt,
    runJwtTtlSeconds: RUN_JWT_TTL_SECONDS,
  });
  const eventsHandler = createRunsEventsRoute({
    runJwt,
    appendRunEvent: async (input) => {
      const ok = await appendShimRunEvent(db, input);
      if (!ok) {
        // Surface as a route-level error; mounted handler converts to 404.
        throw new RunNotFoundError(input.runId);
      }
    },
  });
  const tenantPolicies = clusterTenantPoliciesService(db);
  const secretService = createDbBackedSecretService(db);
  const gitCredentialsHandler = createWorkspaceGitCredentialsRoute({
    runJwt,
    issueGitCredentials: async ({ companyId, repoUrl }) => {
      // Resolve the cluster context from the company. The route surface (and
      // the run-JWT it verifies) doesn't carry clusterConnectionId, and the
      // tenant policy is keyed on (clusterConnectionId, companyId). For V1 we
      // only support a single cluster connection per company; if there are
      // zero or multiple matches we fail closed with not_configured.
      const policies = await db
        .select()
        .from(clusterTenantPolicies)
        .where(eq(clusterTenantPolicies.companyId, companyId));
      if (policies.length !== 1) {
        return { ok: false, reason: "not_configured" };
      }
      return issueGitCredentials(
        { db, secretService, clusterTenantPolicies: tenantPolicies },
        { companyId, clusterConnectionId: policies[0]!.clusterConnectionId, repoUrl },
      );
    },
  });

  // Rate limiters per spec note in the task plan.
  const exchangeLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 10 });
  const eventsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 1000 });
  const gitCredsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: 30 });

  router.post("/agent-auth/exchange", async (req: Request, res: Response) => {
    const limit = exchangeLimiter.consume(clientIp(req));
    if (!limit.allowed) {
      res
        .status(429)
        .set("Retry-After", String(limit.retryAfterSeconds))
        .json({ error: "rate_limited" });
      return;
    }
    try {
      const result = await exchangeHandler(req.body ?? {});
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err }, "agent-auth/exchange failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  router.post("/runs/:runId/events", async (req: Request, res: Response) => {
    const rawRunId = req.params.runId;
    const runId = typeof rawRunId === "string" ? rawRunId : "";
    const limit = eventsLimiter.consume(`run:${runId}`);
    if (!limit.allowed) {
      res
        .status(429)
        .set("Retry-After", String(limit.retryAfterSeconds))
        .json({ error: "rate_limited" });
      return;
    }
    try {
      const result = await eventsHandler({
        params: { runId },
        headers: { authorization: bearer(req) },
        body: (req.body ?? {}) as Record<string, unknown> & { type?: string; ts?: string },
      });
      if (result.body === undefined) {
        res.status(result.status).end();
      } else {
        res.status(result.status).json(result.body);
      }
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        res.status(404).json({ error: "run_not_found" });
        return;
      }
      logger.error({ err, runId }, "runs/:runId/events failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  router.post("/workspace/git-credentials", async (req: Request, res: Response) => {
    // Pre-extract runId from JWT claim for keying. If the header isn't a
    // valid Bearer JWT, key by client IP so that anonymous floods still
    // get throttled rather than being charged to no key at all.
    let key = `ip:${clientIp(req)}`;
    const auth = bearer(req);
    if (auth?.startsWith("Bearer ")) {
      const v = runJwt.verify(auth.slice("Bearer ".length));
      if (v.ok) key = `run:${v.claims.runId}`;
    }
    const limit = gitCredsLimiter.consume(key);
    if (!limit.allowed) {
      res
        .status(429)
        .set("Retry-After", String(limit.retryAfterSeconds))
        .json({ error: "rate_limited" });
      return;
    }
    try {
      const result = await gitCredentialsHandler({
        headers: { authorization: bearer(req) },
        body: (req.body ?? {}) as { repoUrl?: string },
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error({ err }, "workspace/git-credentials failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  return router;
}

class RunNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`run_not_found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}
