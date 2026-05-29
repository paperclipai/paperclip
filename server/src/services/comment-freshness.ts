import type { Request, Response } from "express";
import { logger } from "../middleware/logger.js";

export const IF_MATCH_HEADER = "if-match";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const SYSTEM_COMMENT_HEADER = "x-paperclip-system-comment";

export const STALE_COMMENT_CURSOR_ERROR = "stale_comment_cursor";
export const STALE_COMMENT_CURSOR_RETRY_HINT = "Refresh, reconcile, retry.";

export const COMMENT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const MISSED_COMMENT_PREVIEW_CHARS = 240;
const MISSED_COMMENT_LIMIT = 20;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export type StaleCommentCursorMissedComment = {
  id: string;
  authorType: string;
  createdAt: string;
  bodyPreview: string;
};

export type StaleCommentCursorBody = {
  error: typeof STALE_COMMENT_CURSOR_ERROR;
  expected: string | null;
  received: string;
  since: StaleCommentCursorMissedComment[];
  retryHint: typeof STALE_COMMENT_CURSOR_RETRY_HINT;
};

export function readIfMatch(req: Request): string | null {
  const header = req.header(IF_MATCH_HEADER);
  if (typeof header === "string" && header.trim().length > 0) {
    return stripIfMatchEnvelope(header.trim());
  }
  const body = req.body as { ifMatch?: unknown } | undefined;
  const bodyValue = body && typeof body === "object" ? body.ifMatch : undefined;
  if (typeof bodyValue === "string" && bodyValue.trim().length > 0) {
    return stripIfMatchEnvelope(bodyValue.trim());
  }
  return null;
}

function stripIfMatchEnvelope(value: string): string {
  // Accept both quoted-etag ("abc") and raw forms. RFC 7232 allows W/ prefix too.
  let v = value;
  if (v.startsWith("W/")) v = v.slice(2);
  if (v.length >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
    v = v.slice(1, -1);
  }
  return v;
}

export function readIdempotencyKey(req: Request): string | null {
  const header = req.header(IDEMPOTENCY_KEY_HEADER);
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length === 0 || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return null;
  return trimmed;
}

export function hasSystemBypassHeader(req: Request): boolean {
  const header = req.header(SYSTEM_COMMENT_HEADER);
  if (typeof header !== "string") return false;
  const trimmed = header.trim();
  if (trimmed !== "1" && trimmed.toLowerCase() !== "true") return false;
  // Only honored when authenticated as the local harness/server itself.
  // In local_trusted deployments req.actor.source === "local_implicit".
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

export type CommentCursor = {
  latestCommentId: string | null;
  totalComments: number;
};

export type MissedCommentRow = {
  id: string;
  authorType: string;
  createdAt: Date;
  body: string;
};

export type CommentFreshnessDependencies = {
  getCommentCursor: (issueId: string) => Promise<CommentCursor>;
  listMissedComments: (issueId: string, afterCommentId: string) => Promise<MissedCommentRow[]>;
};

export type CommentFreshnessOutcome =
  | { status: "fresh"; clientCursor: string | null }
  | { status: "bypassed" }
  | { status: "missing"; clientCursor: null }
  | {
      status: "stale";
      clientCursor: string;
      serverCursor: string | null;
      missedComments: StaleCommentCursorMissedComment[];
    };

export async function evaluateCommentFreshness(
  req: Request,
  issueId: string,
  deps: CommentFreshnessDependencies,
): Promise<CommentFreshnessOutcome> {
  if (hasSystemBypassHeader(req)) {
    return { status: "bypassed" };
  }
  const clientCursor = readIfMatch(req);
  if (clientCursor === null) {
    return { status: "missing", clientCursor: null };
  }
  const cursor = await deps.getCommentCursor(issueId);
  const serverCursor = cursor.latestCommentId;
  if (serverCursor === clientCursor) {
    return { status: "fresh", clientCursor };
  }
  if (serverCursor === null) {
    return { status: "stale", clientCursor, serverCursor: null, missedComments: [] };
  }
  const missedRows = await deps.listMissedComments(issueId, clientCursor);
  const limited = missedRows.slice(0, MISSED_COMMENT_LIMIT);
  return {
    status: "stale",
    clientCursor,
    serverCursor,
    missedComments: limited.map((row) => previewMissedComment(row)),
  };
}

function previewMissedComment(row: MissedCommentRow): StaleCommentCursorMissedComment {
  const body = typeof row.body === "string" ? row.body : "";
  const bodyPreview =
    body.length > MISSED_COMMENT_PREVIEW_CHARS
      ? `${body.slice(0, MISSED_COMMENT_PREVIEW_CHARS)}…`
      : body;
  return {
    id: row.id,
    authorType: row.authorType,
    createdAt: row.createdAt.toISOString(),
    bodyPreview,
  };
}

export function buildStaleCommentCursorBody(
  outcome: Extract<CommentFreshnessOutcome, { status: "stale" }>,
): StaleCommentCursorBody {
  return {
    error: STALE_COMMENT_CURSOR_ERROR,
    expected: outcome.serverCursor,
    received: outcome.clientCursor,
    since: outcome.missedComments,
    retryHint: STALE_COMMENT_CURSOR_RETRY_HINT,
  };
}

export function recordStaleCommentCursor(input: {
  endpoint: string;
  agentId: string | null;
  runId: string | null;
  issueId: string;
  staleId: string;
  currentId: string | null;
}): void {
  logger.info(
    {
      event: "stale_comment_cursor",
      endpoint: input.endpoint,
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
      staleId: input.staleId,
      currentId: input.currentId,
    },
    "stale_comment_cursor",
  );
}

export type CommentFreshnessGuardArgs = {
  req: Request;
  res: Response;
  issueId: string;
  endpoint: string;
  actor: { agentId: string | null; runId: string | null };
  deps: CommentFreshnessDependencies;
};

/**
 * Centralised guard for the comment write endpoints. Returns `true` when the
 * request is fresh enough to proceed and `false` (after writing a 409) when the
 * caller should abort.
 */
export async function enforceCommentFreshness(args: CommentFreshnessGuardArgs): Promise<boolean> {
  const outcome = await evaluateCommentFreshness(args.req, args.issueId, args.deps);
  if (outcome.status === "stale") {
    recordStaleCommentCursor({
      endpoint: args.endpoint,
      agentId: args.actor.agentId,
      runId: args.actor.runId,
      issueId: args.issueId,
      staleId: outcome.clientCursor,
      currentId: outcome.serverCursor,
    });
    args.res.status(409).json(buildStaleCommentCursorBody(outcome));
    return false;
  }
  return true;
}

// ===== Idempotency-Key replay cache =====

type CachedResponse = {
  status: number;
  body: unknown;
  expiresAt: number;
};

export class IdempotencyCache {
  private readonly store = new Map<string, CachedResponse>();
  private readonly ttlMs: number;
  private now: () => number;

  constructor(ttlMs: number = COMMENT_IDEMPOTENCY_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private buildKey(scope: string, actorId: string, idempotencyKey: string): string {
    return `${scope}::${actorId}::${idempotencyKey}`;
  }

  private prune(now: number) {
    if (this.store.size === 0) return;
    for (const [key, value] of this.store) {
      if (value.expiresAt <= now) this.store.delete(key);
    }
  }

  get(scope: string, actorId: string, idempotencyKey: string): { status: number; body: unknown } | null {
    const now = this.now();
    this.prune(now);
    const cached = this.store.get(this.buildKey(scope, actorId, idempotencyKey));
    if (!cached) return null;
    if (cached.expiresAt <= now) {
      this.store.delete(this.buildKey(scope, actorId, idempotencyKey));
      return null;
    }
    return { status: cached.status, body: cached.body };
  }

  put(scope: string, actorId: string, idempotencyKey: string, status: number, body: unknown): void {
    const now = this.now();
    this.prune(now);
    this.store.set(this.buildKey(scope, actorId, idempotencyKey), {
      status,
      body,
      expiresAt: now + this.ttlMs,
    });
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }

  setNow(now: () => number) {
    this.now = now;
  }
}

export const commentIdempotencyCache = new IdempotencyCache();

export function idempotencyActorKey(req: Request): string {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return `agent:${req.actor.agentId}`;
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return `user:${req.actor.userId}`;
  }
  return "anonymous";
}
