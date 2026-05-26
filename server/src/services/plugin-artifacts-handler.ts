/**
 * Plugin artifacts host-side handler — resolves attachment bytes on behalf of
 * the dispatching agent, enforcing all seven security gates locked in by
 * SecurityEngineer for PLA-574.
 *
 * The worker calls `ctx.artifacts.fetch(attachmentId)` from inside a tool
 * handler. The SDK serializes that into a JSON-RPC `artifacts.fetch` request
 * carrying ONLY `{ attachmentId, runId }`. This handler:
 *
 *  1. Validates `(pluginDbId, runId)` against the in-memory run-context
 *     registry. If absent → `runcontext_invalid`. The worker is never trusted
 *     to assert agent identity.
 *  2. Loads the attachment by ID.
 *  3. Authorizes against the **dispatching agent's** companyId (from the
 *     registered runContext), NOT the worker's tenant. Mismatch + missing
 *     attachment are collapsed into a single `not_found` shape to deny
 *     existence/no-access enumeration.
 *  4. Applies a sliding-window rate limit per dispatching agent (60/min
 *     global) AND per (dispatching-agent, attachment-company) sub-bucket
 *     (30/min). Either ceiling triggers `rate_limited`.
 *  5. Emits a six-field audit log entry (success OR deny) via `logActivity`.
 *     Audit fields: dispatchingAgentId, dispatchingCompanyId,
 *     attachmentCompanyId, attachmentId, pluginId, outcome.
 *  6. Streams the storage object into a buffer (single-resource only;
 *     enforces a max byte cap to avoid OOM via JSON-RPC base64 inflation).
 *  7. Returns `{ filename, contentType, byteSize, contentBase64 }`. Bytes
 *     are NEVER logged.
 *
 * @see PLA-574 — host-mediated cross-tenant artifact fetch
 */

import type { Readable } from "node:stream";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import type { PluginRunContextRegistry } from "./plugin-run-context-registry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Request shape over the wire. The worker only supplies `runId`. */
export interface PluginArtifactsFetchParams {
  attachmentId: string;
  runId: string;
}

/** Response shape returned to the worker. Bytes are base64-encoded. */
export interface PluginArtifactsFetchResult {
  filename: string;
  contentType: string;
  byteSize: number;
  contentBase64: string;
}

/** Service shape consumed by `HostServices.artifacts`. */
export interface PluginArtifactsService {
  fetch(params: PluginArtifactsFetchParams): Promise<PluginArtifactsFetchResult>;
}

/**
 * Minimal attachment metadata required by this handler. Kept narrow so the
 * service abstraction doesn't bloat — implemented by the existing
 * `issueService(db).getAttachmentById` shape.
 */
export interface AttachmentLookupRow {
  id: string;
  companyId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
}

export interface AttachmentLookup {
  getAttachmentById(id: string): Promise<AttachmentLookupRow | null>;
}

export interface CreateArtifactsHandlerOptions {
  db: Db;
  /** The plugin DB UUID (used as registry key + audit field). */
  pluginDbId: string;
  /** Human-readable plugin manifest id (audit field only). */
  pluginKey: string;
  storage: StorageService;
  attachments: AttachmentLookup;
  runContextRegistry: PluginRunContextRegistry;
  /** Override the per-agent global rate limit (default 60/min). */
  globalRateLimit?: { maxAttempts: number; windowMs: number };
  /** Override the per-(agent, company) sub-bucket limit (default 30/min). */
  perCompanyRateLimit?: { maxAttempts: number; windowMs: number };
  /** Hard ceiling on attachment size streamed through this path. */
  maxByteSize?: number;
  /** Inject a clock for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type ArtifactsErrorCode =
  | "runcontext_invalid"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "too_large";

export class ArtifactsError extends Error {
  readonly code: ArtifactsErrorCode;
  constructor(code: ArtifactsErrorCode, message: string) {
    super(message);
    this.name = "ArtifactsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding-window, in-memory
// ---------------------------------------------------------------------------

function createRateLimiter(
  maxAttempts: number,
  windowMs: number,
  now: () => number,
) {
  const attempts = new Map<string, number[]>();

  return {
    /** Returns true if allowed; records the attempt as side-effect. */
    check(key: string): boolean {
      const ts = now();
      const windowStart = ts - windowMs;
      const existing = (attempts.get(key) ?? []).filter((t) => t > windowStart);
      if (existing.length >= maxAttempts) {
        // Persist the trimmed list so memory doesn't grow unboundedly.
        attempts.set(key, existing);
        return false;
      }
      existing.push(ts);
      attempts.set(key, existing);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Stream → bounded Buffer
// ---------------------------------------------------------------------------

async function readStreamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      // Destroy upstream stream so the storage backend can release resources.
      stream.destroy();
      throw new ArtifactsError(
        "too_large",
        `artifact exceeds maximum size of ${maxBytes} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GLOBAL = { maxAttempts: 60, windowMs: 60_000 };
const DEFAULT_PER_COMPANY = { maxAttempts: 30, windowMs: 60_000 };
/** 10 MiB — large enough for screenshots / small docs, small enough to fit
 *  comfortably inside one JSON-RPC base64 payload. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPluginArtifactsHandler(
  opts: CreateArtifactsHandlerOptions,
): PluginArtifactsService {
  const {
    db,
    pluginDbId,
    pluginKey,
    storage,
    attachments,
    runContextRegistry,
  } = opts;
  const now = opts.now ?? (() => Date.now());
  const globalCfg = opts.globalRateLimit ?? DEFAULT_GLOBAL;
  const perCompanyCfg = opts.perCompanyRateLimit ?? DEFAULT_PER_COMPANY;
  const maxByteSize = opts.maxByteSize ?? DEFAULT_MAX_BYTES;

  const globalLimiter = createRateLimiter(
    globalCfg.maxAttempts,
    globalCfg.windowMs,
    now,
  );
  const perCompanyLimiter = createRateLimiter(
    perCompanyCfg.maxAttempts,
    perCompanyCfg.windowMs,
    now,
  );
  const log = logger.child({ service: "plugin-artifacts-handler", pluginId: pluginKey });

  /**
   * Best-effort audit emission. Failures are logged but do NOT change the
   * decision returned to the worker (audit logging is not in the critical
   * authorization path — if it fails, we still return the correct decision).
   */
  async function audit(input: {
    outcome: "allowed" | "denied";
    deniedReason?: ArtifactsErrorCode;
    dispatchingAgentId: string;
    dispatchingCompanyId: string;
    attachmentCompanyId: string | null;
    attachmentId: string;
    runId: string;
    byteSize?: number;
  }) {
    try {
      // We audit against the DISPATCHING agent's company so the activity log
      // shows up in their tenant's audit trail (where the data was actually
      // accessed). The plugin key and outcome are first-class for the
      // six-field schema PLA-574 §Audit.
      await logActivity(db, {
        companyId: input.dispatchingCompanyId,
        actorType: "plugin",
        actorId: pluginDbId,
        action: "artifact.fetched",
        entityType: "issue_attachment",
        entityId: input.attachmentId,
        agentId: input.dispatchingAgentId,
        runId: input.runId,
        details: {
          pluginKey,
          pluginDbId,
          outcome: input.outcome,
          deniedReason: input.deniedReason ?? null,
          dispatchingAgentId: input.dispatchingAgentId,
          dispatchingCompanyId: input.dispatchingCompanyId,
          attachmentCompanyId: input.attachmentCompanyId,
          attachmentId: input.attachmentId,
          byteSize: input.byteSize ?? null,
        },
      });
    } catch (err) {
      log.warn({ err, attachmentId: input.attachmentId }, "audit log write failed");
    }
  }

  return {
    async fetch(params: PluginArtifactsFetchParams): Promise<PluginArtifactsFetchResult> {
      // ---------- Gate 0: shape validation (single-resource) ----------
      if (!params || typeof params !== "object") {
        throw new ArtifactsError("runcontext_invalid", "invalid request");
      }
      const { attachmentId, runId } = params;
      if (typeof attachmentId !== "string" || attachmentId.length === 0) {
        throw new ArtifactsError("runcontext_invalid", "invalid attachmentId");
      }
      if (typeof runId !== "string" || runId.length === 0) {
        throw new ArtifactsError("runcontext_invalid", "invalid runId");
      }

      // ---------- Gate 1: server-validated runContext lookup ----------
      // Source of truth for dispatching agent identity. The worker's claim is
      // discarded — only the (pluginDbId, runId) → registered entry counts.
      const ctx = runContextRegistry.get(pluginDbId, runId);
      if (!ctx) {
        // No audit — we don't have a tenant/agent to log against.
        throw new ArtifactsError(
          "runcontext_invalid",
          "no active dispatch for this runId",
        );
      }

      // ---------- Gate 2: rate limit (global first, then per-company) ----------
      // Global check happens before lookups to make brute-force enumeration
      // strictly bounded. We don't know attachmentCompanyId yet for the
      // per-company bucket; that's a second check after the lookup succeeds.
      if (!globalLimiter.check(`agent:${ctx.agentId}`)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          attachmentCompanyId: null,
          attachmentId,
          runId,
        });
        throw new ArtifactsError("rate_limited", "global per-agent rate limit exceeded");
      }

      // ---------- Gate 3: attachment lookup ----------
      const attachment = await attachments.getAttachmentById(attachmentId);
      if (!attachment) {
        // Collapse non-existence into not_found to match the no-access case.
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          attachmentCompanyId: null,
          attachmentId,
          runId,
        });
        throw new ArtifactsError("not_found", "attachment not found");
      }

      // ---------- Gate 4: dispatching-agent authorization ----------
      // Agents are scoped to a single company per the JWT actor model
      // (see routes/authz.ts:assertCompanyAccess). For an agent to read an
      // attachment, the dispatching agent's company MUST match the
      // attachment's company. We DO NOT use the worker's tenant for authz.
      if (ctx.companyId !== attachment.companyId) {
        await audit({
          outcome: "denied",
          deniedReason: "not_found",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          attachmentCompanyId: attachment.companyId,
          attachmentId,
          runId,
        });
        // Collapse to not_found to prevent existence enumeration by a
        // dispatching agent guessing IDs in other tenants.
        throw new ArtifactsError("not_found", "attachment not found");
      }

      // ---------- Gate 5: per-(agent, attachment-company) sub-bucket ----------
      const subKey = `agent:${ctx.agentId}|company:${attachment.companyId}`;
      if (!perCompanyLimiter.check(subKey)) {
        await audit({
          outcome: "denied",
          deniedReason: "rate_limited",
          dispatchingAgentId: ctx.agentId,
          dispatchingCompanyId: ctx.companyId,
          attachmentCompanyId: attachment.companyId,
          attachmentId,
          runId,
        });
        throw new ArtifactsError(
          "rate_limited",
          "per-attachment-company rate limit exceeded",
        );
      }

      // ---------- Gate 6: storage fetch + bounded read ----------
      const object = await storage.getObject(attachment.companyId, attachment.objectKey);
      const buf = await readStreamToBuffer(object.stream, maxByteSize);

      // ---------- Gate 7: audit success + return ----------
      await audit({
        outcome: "allowed",
        dispatchingAgentId: ctx.agentId,
        dispatchingCompanyId: ctx.companyId,
        attachmentCompanyId: attachment.companyId,
        attachmentId,
        runId,
        byteSize: buf.length,
      });

      return {
        filename: attachment.originalFilename ?? "attachment",
        contentType: attachment.contentType ?? object.contentType ?? "application/octet-stream",
        byteSize: buf.length,
        // Bytes only ever appear in the response payload — never logs/details.
        contentBase64: buf.toString("base64"),
      };
    },
  };
}
