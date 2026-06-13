import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash } from "node:crypto";

/**
 * Client-supplied idempotency keys for mutating endpoints.
 *
 * Behavior follows the PLA-14 spec:
 * - Clients send an `Idempotency-Key` header.
 * - The server caches the successful (2xx) response under
 *   `(namespace, key)` with a configurable TTL.
 * - A repeat request with the same key inside the TTL replays the
 *   stored response (same status code, same body) and sets the
 *   `Idempotency-Key-Replay: true` response header.
 * - A repeat request with the same key but a *different* body is
 *   rejected with `422` so callers cannot accidentally collapse
 *   two distinct logical operations into one cached result.
 * - Non-2xx responses are not cached; the next attempt is treated
 *   as a fresh request.
 *
 * The default store is an in-process Map. It is sufficient for the
 * single-server local Paperclip deployment that drives this work;
 * it is not shared across replicas. See `IdempotencyStore` to plug
 * in a different backend.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches PLA-14 spec.
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_KEY_LENGTH = 255;
const PENDING_WAIT_TIMEOUT_MS = 30_000;
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Key-Replay";

export interface CompletedIdempotencyEntry {
  status: "completed";
  httpStatus: number;
  body: unknown;
  bodyHash: string;
  expiresAt: number;
}

interface PendingIdempotencyEntry {
  status: "pending";
  bodyHash: string;
  waiters: Array<(outcome: PendingOutcome) => void>;
}

type PendingOutcome =
  | { kind: "completed"; entry: CompletedIdempotencyEntry }
  | { kind: "failed"; httpStatus: number | null };

type IdempotencyEntry = CompletedIdempotencyEntry | PendingIdempotencyEntry;

export interface IdempotencyStore {
  get(key: string): IdempotencyEntry | undefined;
  set(key: string, entry: IdempotencyEntry): void;
  delete(key: string): void;
  size(): number;
}

export interface CreateInMemoryStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

export function createInMemoryIdempotencyStore(
  opts: CreateInMemoryStoreOptions = {},
): IdempotencyStore {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, IdempotencyEntry>();

  function evictIfExpired(key: string, entry: IdempotencyEntry | undefined) {
    if (!entry) return undefined;
    if (entry.status === "completed" && entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    get(key) {
      return evictIfExpired(key, map.get(key));
    },
    set(key, entry) {
      if (!map.has(key) && map.size >= maxEntries) {
        const oldest = map.keys().next();
        if (!oldest.done) {
          map.delete(oldest.value);
        }
      }
      map.set(key, entry);
    },
    delete(key) {
      map.delete(key);
    },
    size() {
      return map.size;
    },
  };
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /**
   * Namespace function applied to the cache key. Should incorporate
   * everything that scopes "same request": tenant id and authenticated
   * principal id at minimum. Returning `null` or `undefined` disables
   * dedup for the request (treated as no header).
   */
  namespace: (req: Request) => string | null | undefined;
  ttlMs?: number;
  headerName?: string;
  now?: () => number;
  /** Override the default 30s wait for concurrent same-key followers. */
  pendingWaitTimeoutMs?: number;
}

export function idempotency(options: IdempotencyOptions): RequestHandler {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const headerName = options.headerName ?? IDEMPOTENCY_HEADER;
  const now = options.now ?? (() => Date.now());
  const waitTimeoutMs = options.pendingWaitTimeoutMs ?? PENDING_WAIT_TIMEOUT_MS;

  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    const rawHeader = req.header(headerName);
    if (rawHeader === undefined) {
      next();
      return;
    }

    const key = typeof rawHeader === "string" ? rawHeader.trim() : "";
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      res.status(400).json({
        error: `Invalid ${headerName} header (must be 1-${MAX_KEY_LENGTH} characters).`,
      });
      return;
    }

    const ns = options.namespace(req);
    if (ns === null || ns === undefined) {
      next();
      return;
    }

    const storeKey = `${ns}:${key}`;
    const bodyHash = hashRequestBody(req);

    const replayCompleted = (entry: CompletedIdempotencyEntry) => {
      if (entry.bodyHash !== bodyHash) {
        res.status(422).json({
          error:
            `${headerName} reuse with a different request body. Each ${headerName} must map to one logical request.`,
        });
        return;
      }
      res.setHeader(IDEMPOTENCY_REPLAY_HEADER, "true");
      res.status(entry.httpStatus).json(entry.body);
    };

    const existing = options.store.get(storeKey);

    if (existing && existing.status === "completed") {
      replayCompleted(existing);
      return;
    }

    if (existing && existing.status === "pending") {
      if (existing.bodyHash !== bodyHash) {
        res.status(422).json({
          error:
            `${headerName} reuse with a different request body. Each ${headerName} must map to one logical request.`,
        });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        res.status(409).json({
          error:
            `Concurrent request with the same ${headerName} is still in flight. Retry with the same key once it completes.`,
        });
      }, waitTimeoutMs);

      existing.waiters.push((outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome.kind === "completed") {
          replayCompleted(outcome.entry);
        } else {
          res.status(409).json({
            error:
              `Concurrent request with the same ${headerName} failed (status ${outcome.httpStatus ?? "unknown"}). Retry with the same key.`,
          });
        }
      });
      return;
    }

    const pending: PendingIdempotencyEntry = {
      status: "pending",
      bodyHash,
      waiters: [],
    };
    options.store.set(storeKey, pending);

    // We capture the response body by wrapping `res.json`. This is what
    // lets a replayed request return the same payload byte-for-byte. The
    // tradeoff: routes that bypass `res.json` and write the body via
    // `res.send(stringOrBuffer)`, `res.write(...)` / streams, or
    // `res.end(...)` will leave `capturedBodySet = false` and the slot
    // will fall through to `settleFailure` even if the wire response was
    // a 2xx. If you wire this middleware onto a new route, make sure the
    // happy path goes through `res.json(...)`. See docs/api/agents.md.
    let capturedBody: unknown;
    let capturedBodySet = false;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      capturedBody = body;
      capturedBodySet = true;
      return originalJson(body);
    }) as Response["json"];

    let settled = false;
    const settleSuccess = (httpStatus: number, body: unknown) => {
      if (settled) return;
      settled = true;
      const completed: CompletedIdempotencyEntry = {
        status: "completed",
        httpStatus,
        body,
        bodyHash,
        expiresAt: now() + ttlMs,
      };
      options.store.set(storeKey, completed);
      for (const waiter of pending.waiters) {
        waiter({ kind: "completed", entry: completed });
      }
    };
    const settleFailure = (httpStatus: number | null) => {
      if (settled) return;
      settled = true;
      options.store.delete(storeKey);
      for (const waiter of pending.waiters) {
        waiter({ kind: "failed", httpStatus });
      }
    };

    res.once("finish", () => {
      const httpStatus = res.statusCode;
      if (httpStatus >= 200 && httpStatus < 300 && capturedBodySet) {
        settleSuccess(httpStatus, capturedBody);
      } else {
        settleFailure(httpStatus);
      }
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        settleFailure(null);
      }
    });

    next();
  };
}

function hashRequestBody(req: Request): string {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (raw && Buffer.isBuffer(raw) && raw.length > 0) {
    return createHash("sha256").update(raw).digest("hex");
  }
  return createHash("sha256")
    .update(JSON.stringify(req.body ?? null))
    .digest("hex");
}
