import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
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

// Sliding-window in-memory rate limiter. Mirrors the shape of
// company-search-rate-limit.ts; kept inline because these limits are
// k8s-callback-specific. For multi-replica deployments this would be lifted to
// Redis — that's tracked in docs/k8s-execution/CHANGELOG.md.
function createSlidingWindowLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return {
    consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
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
 */
async function appendShimRunEvent(
  db: Db,
  input: RunEventInput,
): Promise<boolean> {
  const [run] = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId));
  if (!run) return false;

  const [seqRow] = await db
    .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, run.id));
  const nextSeq = Number(seqRow?.maxSeq ?? 0) + 1;

  await db.insert(heartbeatRunEvents).values({
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    seq: nextSeq,
    eventType: input.type,
    payload: input.payload,
    // ts is folded into payload; createdAt is server-assigned.
  });
  return true;
}

/**
 * Stub git-credentials issuer. M2 ships the route + auth contract; live
 * issuance (GitHub App installation tokens, per-tenant deploy tokens) is M3.
 * Documented in docs/k8s-execution/CHANGELOG.md.
 */
async function issueGitCredentialsStub(): Promise<IssueGitCredentialsResult> {
  return { ok: false, reason: "not_configured" };
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
  const gitCredentialsHandler = createWorkspaceGitCredentialsRoute({
    runJwt,
    issueGitCredentials: issueGitCredentialsStub,
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
