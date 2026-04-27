import type { Db } from "@paperclipai/db";
import {
  agentTaskSessions as agentTaskSessionsTable,
  agents as agentsTable,
  budgetIncidents,
  costEvents,
  heartbeatRuns,
  issues as issuesTable,
  pluginLogs,
} from "@paperclipai/db";
import { eq, and, like, desc, inArray, sql } from "drizzle-orm";
import type {
  HostServices,
  Company,
  Agent,
  Project,
  Issue,
  Goal,
  PluginWorkspace,
  IssueComment,
  PluginIssueAssigneeSummary,
  PluginIssueOrchestrationSummary,
} from "@paperclipai/plugin-sdk";
import type { CreateIssueThreadInteraction, IssueDocumentSummary } from "@paperclipai/shared";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { goalService } from "./goals.js";
import { documentService } from "./documents.js";
import { heartbeatService } from "./heartbeat.js";
import { budgetService } from "./budgets.js";
import { issueApprovalService } from "./issue-approvals.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { randomUUID } from "node:crypto";
import { activityService } from "./activity.js";
import { costService } from "./costs.js";
import { assetService } from "./assets.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { pluginDatabaseService } from "./plugin-database.js";
import { createPluginSecretsHandler } from "./plugin-secrets-handler.js";
import { logActivity } from "./activity-log.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";

// ---------------------------------------------------------------------------
// SSRF protection for plugin HTTP fetch
// ---------------------------------------------------------------------------

/** Maximum time (ms) a plugin fetch request may take before being aborted. */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Only these protocols are allowed for plugin HTTP requests. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const TELEMETRY_EVENT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Check if an IP address is in a private/reserved range (RFC 1918, loopback,
 * link-local, etc.) that plugins should never be able to reach.
 *
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) which Node's
 * dns.lookup may return depending on OS configuration.
 */
function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIP(v4MappedMatch[1]);

  // IPv4 patterns
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;                   // loopback
  if (ip.startsWith("169.254.")) return true;               // link-local
  if (ip === "0.0.0.0") return true;

  // IPv6 patterns
  if (lower === "::1") return true;                          // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true;                 // link-local
  if (lower === "::") return true;

  return false;
}

/**
 * Validate a URL for plugin fetch: protocol whitelist + private IP blocking.
 *
 * SSRF Prevention Strategy:
 * 1. Parse and validate the URL syntax
 * 2. Enforce protocol whitelist (http/https only)
 * 3. Resolve the hostname to IP(s) via DNS
 * 4. Validate that ALL resolved IPs are non-private
 * 5. Pin the first safe IP into the URL so fetch() does not re-resolve DNS
 *
 * This prevents DNS rebinding attacks where an attacker controls DNS to
 * resolve to a safe IP during validation, then to a private IP when fetch() runs.
 *
 * @returns Request-routing metadata used to connect directly to the resolved IP
 *          while preserving the original hostname for HTTP Host and TLS SNI.
 */
interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

async function validateAndResolveFetchUrl(urlString: string): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`,
    );
  }

  // Resolve the hostname to an IP and check for private ranges.
  // We pin the resolved IP into the URL to eliminate the TOCTOU window
  // between DNS resolution here and the second resolution fetch() would do.
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  // when DNS is misconfigured or unresponsive.
  const dnsPromise = dnsLookup(originalHostname, { all: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${originalHostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    // Filter to only non-private IPs instead of rejecting the entire request
    // when some IPs are private. This handles multi-homed hosts that resolve
    // to both private and public addresses.
    const safeResults = results.filter((entry) => !isPrivateIP(entry.address));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: parsed.protocol === "https:" && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls: parsed.protocol === "https:",
    };
  } catch (err) {
    // Re-throw our own errors; wrap DNS failures
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  }
}

function buildPinnedRequestOptions(
  target: ValidatedFetchTarget,
  init?: RequestInit,
): { options: HttpRequestOptions & { servername?: string }; body: string | undefined } {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  const body = init?.body === undefined || init?.body === null
    ? undefined
    : typeof init.body === "string"
      ? init.body
      : String(init.body);

  headers.set("Host", target.hostHeader);
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  const pathname = `${target.parsedUrl.pathname}${target.parsedUrl.search}`;
  const auth = target.parsedUrl.username || target.parsedUrl.password
    ? `${decodeURIComponent(target.parsedUrl.username)}:${decodeURIComponent(target.parsedUrl.password)}`
    : undefined;

  return {
    options: {
      protocol: target.parsedUrl.protocol,
      host: target.resolvedAddress,
      port: target.parsedUrl.port
        ? Number(target.parsedUrl.port)
        : target.useTls
          ? 443
          : 80,
      path: pathname,
      method,
      headers: Object.fromEntries(headers.entries()),
      auth,
      servername: target.tlsServername,
    },
    body,
  };
}

async function executePinnedHttpRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const { options, body } = buildPinnedRequestOptions(target, init);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const requestFn = target.useTls ? httpsRequest : httpRequest;
    const req = requestFn({ ...options, signal }, resolve);

    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

  const MAX_RESPONSE_BODY_BYTES = 200 * 1024 * 1024; // 200 MB
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        chunks.length = 0;
        response.destroy(new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buf);
    });
    response.on("end", resolve);
    response.on("error", reject);
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  return {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (
    PATH_LIKE_PATTERN.test(normalized)
    || WINDOWS_DRIVE_PATH_PATTERN.test(normalized)
  ) && !UUID_PATTERN.test(normalized);
}

function sanitizeWorkspaceText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function sanitizeWorkspacePath(cwd: string | null): string {
  if (!cwd) return "";
  return looksLikePath(cwd) ? cwd.trim() : "";
}

function sanitizeWorkspaceName(name: string, fallbackPath: string): string {
  const safeName = sanitizeWorkspaceText(name);
  if (safeName && !looksLikePath(safeName)) {
    return safeName;
  }
  const normalized = fallbackPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Workspace";
}

// ---------------------------------------------------------------------------
// Buffered plugin log writes
// ---------------------------------------------------------------------------

/** How many buffered log entries trigger an immediate flush. */
const LOG_BUFFER_FLUSH_SIZE = 100;

/** How often (ms) the buffer is flushed regardless of size. */
const LOG_BUFFER_FLUSH_INTERVAL_MS = 5_000;

/** Max length for a single plugin log message (bytes/chars). */
const MAX_LOG_MESSAGE_LENGTH = 10_000;

/** Max serialised JSON size for plugin log meta objects. */
const MAX_LOG_META_JSON_LENGTH = 50_000;

/** Max length for a metric name. */
const MAX_METRIC_NAME_LENGTH = 500;

/** Pino reserved field names that plugins must not overwrite. */
const PINO_RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "v",
]);

/** Truncate a string to `max` characters, appending a marker if truncated. */
function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...[truncated]";
}

/** Sanitise a plugin-supplied meta object: enforce size limit and strip reserved keys. */
function sanitiseMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (meta == null) return null;
  // Strip pino reserved keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PINO_RESERVED_KEYS.has(k)) {
      cleaned[k] = v;
    }
  }
  // Enforce total serialised size
  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _sanitised: true, _error: "meta was not JSON-serialisable" };
  }
  if (json.length > MAX_LOG_META_JSON_LENGTH) {
    return { _sanitised: true, _error: `meta exceeded ${MAX_LOG_META_JSON_LENGTH} chars` };
  }
  return cleaned;
}

interface BufferedLogEntry {
  db: Db;
  pluginId: string;
  level: string;
  message: string;
  meta: Record<string, unknown> | null;
}

const _logBuffer: BufferedLogEntry[] = [];

/**
 * Flush all buffered log entries to the database in a single batch insert per
 * unique db instance. Errors are swallowed with a console.error fallback so
 * flushing never crashes the process.
 */
export async function flushPluginLogBuffer(): Promise<void> {
  if (_logBuffer.length === 0) return;

  // Drain the buffer atomically so concurrent flushes don't double-insert.
  const entries = _logBuffer.splice(0, _logBuffer.length);

  // Group entries by db identity so multi-db scenarios are handled correctly.
  const byDb = new Map<Db, BufferedLogEntry[]>();
  for (const entry of entries) {
    const group = byDb.get(entry.db);
    if (group) {
      group.push(entry);
    } else {
      byDb.set(entry.db, [entry]);
    }
  }

  for (const [dbInstance, group] of byDb) {
    const values = group.map((e) => ({
      pluginId: e.pluginId,
      level: e.level,
      message: e.message,
      meta: e.meta,
    }));
    try {
      await dbInstance.insert(pluginLogs).values(values);
    } catch (err) {
      try {
        logger.warn({ err, count: values.length }, "Failed to batch-persist plugin logs to DB");
      } catch {
        console.error("[plugin-host-services] Batch log flush failed:", err);
      }
    }
  }
}

/** Interval handle for the periodic log flush. */
const _logFlushInterval = setInterval(() => {
  flushPluginLogBuffer().catch((err) => {
    console.error("[plugin-host-services] Periodic log flush error:", err);
  });
}, LOG_BUFFER_FLUSH_INTERVAL_MS);

// Allow the interval to be unref'd so it doesn't keep the process alive in tests.
if (_logFlushInterval.unref) _logFlushInterval.unref();

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Paperclip domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param pluginKey - The unique identifier from the plugin manifest (e.g., "acme.linear").
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
/** Maximum time (ms) to keep a session event subscription alive before forcing cleanup. */
const SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes

export function buildHostServices(
  db: Db,
  pluginId: string,
  pluginKey: string,
  eventBus: PluginEventBus,
  notifyWorker?: (method: string, params: unknown) => void,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
): HostServices & { dispose(): void } {
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const pluginDb = pluginDatabaseService(db);
  const secretsHandler = createPluginSecretsHandler({ db, pluginId });
  const companies = companyService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const projects = projectService(db);
  const issues = issueService(db);
  const documents = documentService(db);
  const goals = goalService(db);
  const activity = activityService(db);
  const costs = costService(db);
  const budgets = budgetService(db);
  const issueApprovals = issueApprovalService(db);
  const assets = assetService(db);
  const scopedBus = eventBus.forPlugin(pluginKey);

  // Track active session event subscriptions for cleanup
  const activeSubscriptions = new Set<{ unsubscribe: () => void; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  const ensureCompanyId = (companyId?: string) => {
    if (!companyId) throw new Error("companyId is required for this operation");
    return companyId;
  };

  const parseWindowValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return null;
  };

  const applyWindow = <T>(rows: T[], params?: { limit?: unknown; offset?: unknown }): T[] => {
    const offset = parseWindowValue(params?.offset) ?? 0;
    const limit = parseWindowValue(params?.limit);
    if (limit == null) return rows.slice(offset);
    return rows.slice(offset, offset + limit);
  };

  /**
   * Plugins are instance-wide in the current runtime. Company IDs are still
   * required for company-scoped data access, but there is no per-company
   * availability gate to enforce here.
   */
  const ensurePluginAvailableForCompany = async (_companyId: string) => {};

  const inCompany = <T extends { companyId: string | null | undefined }>(
    record: T | null | undefined,
    companyId: string,
  ): record is T => Boolean(record && record.companyId === companyId);

  const requireInCompany = <T extends { companyId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    companyId: string,
  ): T => {
    if (!inCompany(record, companyId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  const pluginActivityDetails = (
    details: Record<string, unknown> | null | undefined,
    actor?: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null },
  ) => {
    const initiatingActorType = actor?.actorAgentId ? "agent" : actor?.actorUserId ? "user" : null;
    const initiatingActorId = actor?.actorAgentId ?? actor?.actorUserId ?? null;
    return {
      ...(details ?? {}),
      sourcePluginId: pluginId,
      sourcePluginKey: pluginKey,
      initiatingActorType,
      initiatingActorId,
      initiatingAgentId: actor?.actorAgentId ?? null,
      initiatingUserId: actor?.actorUserId ?? null,
      initiatingRunId: actor?.actorRunId ?? null,
      pluginId,
      pluginKey,
    };
  };

  const defaultPluginOriginKind = `plugin:${pluginKey}`;
  const normalizePluginOriginKind = (originKind: unknown = defaultPluginOriginKind) => {
    if (originKind == null || originKind === "") return defaultPluginOriginKind;
    if (typeof originKind !== "string") {
      throw new Error("Plugin issue originKind must be a string");
    }
    if (originKind === defaultPluginOriginKind || originKind.startsWith(`${defaultPluginOriginKind}:`)) {
      return originKind;
    }
    throw new Error(`Plugin may only use originKind values under ${defaultPluginOriginKind}`);
  };

  const assertReadableOriginFilter = (originKind: unknown) => {
    if (typeof originKind !== "string" || !originKind.startsWith("plugin:")) return;
    normalizePluginOriginKind(originKind);
  };

  const logPluginActivity = async (input: {
    companyId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown> | null;
    actor?: { actorAgentId?: string | null; actorUserId?: string | null; actorRunId?: string | null };
  }) => {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "plugin",
      actorId: pluginId,
      agentId: input.actor?.actorAgentId ?? null,
      runId: input.actor?.actorRunId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: pluginActivityDetails(input.details, input.actor),
    });
  };

  const collectIssueSubtreeIds = async (companyId: string, rootIssueId: string) => {
    const seen = new Set<string>([rootIssueId]);
    let frontier = [rootIssueId];

    while (frontier.length > 0) {
      const children = await db
        .select({ id: issuesTable.id })
        .from(issuesTable)
        .where(and(eq(issuesTable.companyId, companyId), inArray(issuesTable.parentId, frontier)));
      frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
      for (const id of frontier) seen.add(id);
    }

    return [...seen];
  };

  const getIssueRunSummaries = async (
    companyId: string,
    issueIds: string[],
    options: { activeOnly?: boolean } = {},
  ) => {
    if (issueIds.length === 0) return [];
    const issueIdExpr = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const statusCondition = options.activeOnly
      ? inArray(heartbeatRuns.status, ["queued", "running"])
      : undefined;
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        issueId: issueIdExpr,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        error: heartbeatRuns.error,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(issueIdExpr, issueIds), statusCondition))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(100);

    return rows.map((row) => ({
      ...row,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  };

  const setBlockedByWithActivity = async (params: {
    issueId: string;
    companyId: string;
    blockedByIssueIds: string[];
    mutation: "set" | "add" | "remove";
    actorAgentId?: string | null;
    actorUserId?: string | null;
    actorRunId?: string | null;
  }) => {
    const existing = requireInCompany("Issue", await issues.getById(params.issueId), params.companyId);
    const previous = await issues.getRelationSummaries(params.issueId);
    await issues.update(params.issueId, {
      blockedByIssueIds: params.blockedByIssueIds,
      actorAgentId: params.actorAgentId ?? null,
      actorUserId: params.actorUserId ?? null,
    } as any);
    const relations = await issues.getRelationSummaries(params.issueId);
    await logPluginActivity({
      companyId: params.companyId,
      action: "issue.relations.updated",
      entityType: "issue",
      entityId: params.issueId,
      actor: {
        actorAgentId: params.actorAgentId,
        actorUserId: params.actorUserId,
        actorRunId: params.actorRunId,
      },
      details: {
        identifier: existing.identifier,
        mutation: params.mutation,
        blockedByIssueIds: params.blockedByIssueIds,
        previousBlockedByIssueIds: previous.blockedBy.map((relation) => relation.id),
      },
    });
    return relations;
  };

  const getIssueCostSummary = async (
    companyId: string,
    issueIds: string[],
    billingCode?: string | null,
  ) => {
    const scopeConditions = [
      issueIds.length > 0 ? inArray(costEvents.issueId, issueIds) : undefined,
      billingCode ? eq(costEvents.billingCode, billingCode) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    if (scopeConditions.length === 0) {
      return {
        costCents: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        billingCode: billingCode ?? null,
      };
    }
    const scopeCondition = scopeConditions.length === 1 ? scopeConditions[0]! : and(...scopeConditions);
    const [row] = await db
      .select({
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), scopeCondition));

    return {
      costCents: Number(row?.costCents ?? 0),
      inputTokens: Number(row?.inputTokens ?? 0),
      cachedInputTokens: Number(row?.cachedInputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      billingCode: billingCode ?? null,
    };
  };

  const getOpenBudgetIncidents = async (companyId: string) => {
    const rows = await db
      .select({
        id: budgetIncidents.id,
        scopeType: budgetIncidents.scopeType,
        scopeId: budgetIncidents.scopeId,
        metric: budgetIncidents.metric,
        windowKind: budgetIncidents.windowKind,
        thresholdType: budgetIncidents.thresholdType,
        amountLimit: budgetIncidents.amountLimit,
        amountObserved: budgetIncidents.amountObserved,
        status: budgetIncidents.status,
        approvalId: budgetIncidents.approvalId,
        createdAt: budgetIncidents.createdAt,
      })
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
      .orderBy(desc(budgetIncidents.createdAt));

    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  };

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    state: {
      async get(params) {
        return stateStore.get(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
      async set(params) {
        await stateStore.set(pluginId, {
          scopeKind: params.scopeKind as any,
          scopeId: params.scopeId,
          namespace: params.namespace,
          stateKey: params.stateKey,
          value: params.value,
        });
      },
      async delete(params) {
        await stateStore.delete(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
    },

    db: {
      async namespace() {
        return pluginDb.getRuntimeNamespace(pluginId);
      },
      async query(params) {
        return pluginDb.query(pluginId, params.sql, params.params);
      },
      async execute(params) {
        return pluginDb.execute(pluginId, params.sql, params.params);
      },
    },

    entities: {
      async upsert(params) {
        return registry.upsertEntity(pluginId, params as any) as any;
      },
      async list(params) {
        return registry.listEntities(pluginId, params as any) as any;
      },
    },

    events: {
      async emit(params) {
        if (params.companyId) {
          await ensurePluginAvailableForCompany(params.companyId);
        }
        await scopedBus.emit(params.name, params.companyId, params.payload);
      },
      async subscribe(params: { eventPattern: string; filter?: Record<string, unknown> | null }) {
        const handler = async (event: import("@paperclipai/plugin-sdk").PluginEvent) => {
          if (notifyWorker) {
            notifyWorker("onEvent", { event });
          }
        };
        if (params.filter) {
          scopedBus.subscribe(params.eventPattern as any, params.filter as any, handler);
        } else {
          scopedBus.subscribe(params.eventPattern as any, handler);
        }
      },
    },

    http: {
      async fetch(params) {
        // SSRF protection: validate protocol whitelist + block private IPs.
        // Resolve once, then connect directly to that IP to prevent DNS rebinding.
        const target = await validateAndResolveFetchUrl(params.url);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);

        try {
          const init = params.init as RequestInit | undefined;
          return await executePinnedHttpRequest(target, init, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      },
    },

    secrets: {
      async resolve(params) {
        return secretsHandler.resolve(params);
      },
    },

    activity: {
      async log(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        await logActivity(db, {
          companyId,
          actorType: "plugin",
          actorId: pluginId,
          action: params.message,
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: pluginActivityDetails(params.metadata),
        });
      },
    },

    metrics: {
      async write(params) {
        const safeName = truncStr(String(params.name ?? ""), MAX_METRIC_NAME_LENGTH);
        logger.debug({ pluginId, name: safeName, value: params.value, tags: params.tags }, "Plugin metric write");

        // Persist metrics to plugin_logs via the batch buffer (same path as
        // logger.log) so they benefit from batched writes and are flushed
        // reliably on shutdown. Using level "metric" makes them queryable
        // alongside regular logs via the same API (§26).
        _logBuffer.push({
          db,
          pluginId,
          level: "metric",
          message: safeName,
          meta: sanitiseMeta({ value: params.value, tags: params.tags ?? null }),
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error("[plugin-host-services] Triggered metric flush failed:", err);
          });
        }
      },
    },

    telemetry: {
      async track(params) {
        const eventName = String(params.eventName ?? "").trim();
        if (!TELEMETRY_EVENT_NAME_REGEX.test(eventName)) {
          throw new Error(
            'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".',
          );
        }
        const telemetryClient = getTelemetryClient();
        if (!telemetryClient) return;
        telemetryClient.track(`plugin.${pluginKey}.${eventName}`, params.dimensions);
      },
    },

    logger: {
      async log(params) {
        const { level, meta } = params;
        const safeMessage = truncStr(String(params.message ?? ""), MAX_LOG_MESSAGE_LENGTH);
        const safeMeta = sanitiseMeta(meta);
        const pluginLogger = logger.child({ service: "plugin-worker", pluginId });
        const logFields = {
          ...safeMeta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error") pluginLogger.error(logFields, `[plugin] ${safeMessage}`);
        else if (level === "warn") pluginLogger.warn(logFields, `[plugin] ${safeMessage}`);
        else if (level === "debug") pluginLogger.debug(logFields, `[plugin] ${safeMessage}`);
        else pluginLogger.info(logFields, `[plugin] ${safeMessage}`);

        // Persist to plugin_logs table via the module-level batch buffer (§26.1).
        // Fire-and-forget — logging should never block the worker.
        _logBuffer.push({
          db,
          pluginId,
          level: level ?? "info",
          message: safeMessage,
          meta: safeMeta,
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error("[plugin-host-services] Triggered log flush failed:", err);
          });
        }
      },
    },

    companies: {
      async list(params) {
        return applyWindow((await companies.list()) as Company[], params);
      },
      async get(params) {
        await ensurePluginAvailableForCompany(params.companyId);
        return (await companies.getById(params.companyId)) as Company;
      },
    },

    projects: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return applyWindow((await projects.list(companyId)) as Project[], params);
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        return (inCompany(project, companyId) ? project : null) as Project | null;
      },
      async listWorkspaces(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return [];
        const rows = await projects.listWorkspaces(params.projectId);
        return rows.map((row) => {
          const path = sanitizeWorkspacePath(row.cwd);
          const name = sanitizeWorkspaceName(row.name, path);
          return {
            id: row.id,
            projectId: row.projectId,
            name,
            path,
            isPrimary: row.isPrimary,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        });
      },
      async getPrimaryWorkspace(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return null;
        const row = project.primaryWorkspace;
        const path = sanitizeWorkspacePath(project.codebase.effectiveLocalFolder);
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `${project.id}:managed`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },

      async getWorkspaceForIssue(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = await issues.getById(params.issueId);
        if (!inCompany(issue, companyId)) return null;
        const projectId = (issue as Record<string, unknown>).projectId as string | null;
        if (!projectId) return null;
        const project = await projects.getById(projectId);
        if (!inCompany(project, companyId)) return null;
        const row = project.primaryWorkspace;
        const path = sanitizeWorkspacePath(project.codebase.effectiveLocalFolder);
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `${project.id}:managed`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },
    },

    issues: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        assertReadableOriginFilter(params.originKind);
        return applyWindow((await issues.list(companyId, params as any)) as Issue[], params);
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = await issues.getById(params.issueId);
        return (inCompany(issue, companyId) ? issue : null) as Issue | null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { actorAgentId, actorUserId, actorRunId, originKind, ...issueInput } = params;
        const normalizedOriginKind = normalizePluginOriginKind(originKind);
        const issue = (await issues.create(companyId, {
          ...(issueInput as any),
          originKind: normalizedOriginKind,
          originId: params.originId ?? null,
          originRunId: params.originRunId ?? actorRunId ?? null,
          createdByAgentId: actorAgentId ?? null,
          createdByUserId: actorUserId ?? null,
        })) as Issue;
        await logPluginActivity({
          companyId,
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          actor: { actorAgentId, actorUserId, actorRunId },
          details: {
            title: issue.title,
            identifier: issue.identifier,
            originKind: normalizedOriginKind,
            originId: issue.originId,
            billingCode: issue.billingCode,
            blockedByIssueIds: params.blockedByIssueIds ?? [],
          },
        });
        return issue;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const existing = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const patch = { ...(params.patch as Record<string, unknown>) };
        const actorAgentId = typeof patch.actorAgentId === "string" ? patch.actorAgentId : null;
        const actorUserId = typeof patch.actorUserId === "string" ? patch.actorUserId : null;
        const actorRunId = typeof patch.actorRunId === "string" ? patch.actorRunId : null;
        delete patch.actorAgentId;
        delete patch.actorUserId;
        delete patch.actorRunId;
        if (patch.originKind !== undefined) {
          patch.originKind = normalizePluginOriginKind(patch.originKind);
        }
        const updated = (await issues.update(params.issueId, {
          ...(patch as any),
          actorAgentId,
          actorUserId,
        })) as Issue;
        await logPluginActivity({
          companyId,
          action: "issue.updated",
          entityType: "issue",
          entityId: updated.id,
          actor: { actorAgentId, actorUserId, actorRunId },
          details: {
            identifier: updated.identifier,
            patch,
            _previous: {
              status: existing.status,
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
          },
        });
        return updated;
      },
      async getRelations(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        return await issues.getRelationSummaries(params.issueId);
      },
      async setBlockedBy(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return setBlockedByWithActivity({
          companyId,
          issueId: params.issueId,
          blockedByIssueIds: params.blockedByIssueIds,
          mutation: "set",
          actorAgentId: params.actorAgentId,
          actorUserId: params.actorUserId,
          actorRunId: params.actorRunId,
        });
      },
      async addBlockers(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const previous = await issues.getRelationSummaries(params.issueId);
        const nextBlockedByIssueIds = [
          ...new Set([
            ...previous.blockedBy.map((relation) => relation.id),
            ...params.blockerIssueIds,
          ]),
        ];
        return setBlockedByWithActivity({
          companyId,
          issueId: params.issueId,
          blockedByIssueIds: nextBlockedByIssueIds,
          mutation: "add",
          actorAgentId: params.actorAgentId,
          actorUserId: params.actorUserId,
          actorRunId: params.actorRunId,
        });
      },
      async removeBlockers(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const previous = await issues.getRelationSummaries(params.issueId);
        const removals = new Set(params.blockerIssueIds);
        const nextBlockedByIssueIds = previous.blockedBy
          .map((relation) => relation.id)
          .filter((issueId) => !removals.has(issueId));
        return setBlockedByWithActivity({
          companyId,
          issueId: params.issueId,
          blockedByIssueIds: nextBlockedByIssueIds,
          mutation: "remove",
          actorAgentId: params.actorAgentId,
          actorUserId: params.actorUserId,
          actorRunId: params.actorRunId,
        });
      },
      async assertCheckoutOwner(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const ownership = await issues.assertCheckoutOwner(
          params.issueId,
          params.actorAgentId,
          params.actorRunId,
        );
        if (ownership.adoptedFromRunId) {
          await logPluginActivity({
            companyId,
            action: "issue.checkout_lock_adopted",
            entityType: "issue",
            entityId: params.issueId,
            actor: {
              actorAgentId: params.actorAgentId,
              actorRunId: params.actorRunId,
            },
            details: {
              previousCheckoutRunId: ownership.adoptedFromRunId,
              checkoutRunId: params.actorRunId,
              reason: "stale_checkout_run",
            },
          });
        }
        return {
          issueId: ownership.id,
          status: ownership.status as Issue["status"],
          assigneeAgentId: ownership.assigneeAgentId,
          checkoutRunId: ownership.checkoutRunId,
          adoptedFromRunId: ownership.adoptedFromRunId,
        };
      },
      async getSubtree(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rootIssue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const includeRoot = params.includeRoot !== false;
        const subtreeIssueIds = await collectIssueSubtreeIds(companyId, rootIssue.id);
        const issueIds = includeRoot ? subtreeIssueIds : subtreeIssueIds.filter((issueId) => issueId !== rootIssue.id);
        const issueRows = issueIds.length > 0
          ? await db
            .select()
            .from(issuesTable)
            .where(and(eq(issuesTable.companyId, companyId), inArray(issuesTable.id, issueIds)))
          : [];
        const issuesById = new Map(issueRows.map((issue) => [issue.id, issue as Issue]));
        const outputIssues = issueIds
          .map((issueId) => issuesById.get(issueId))
          .filter((issue): issue is Issue => Boolean(issue));

        const assigneeAgentIds = [
          ...new Set(outputIssues.map((issue) => issue.assigneeAgentId).filter((id): id is string => Boolean(id))),
        ];

        const [relationPairs, documentPairs, activeRunRows, assigneeRows] = await Promise.all([
          params.includeRelations
            ? Promise.all(issueIds.map(async (issueId) => [issueId, await issues.getRelationSummaries(issueId)] as const))
            : Promise.resolve(null),
          params.includeDocuments
            ? Promise.all(
              issueIds.map(async (issueId) => {
                const docs = await documents.listIssueDocuments(issueId);
                const summaries: IssueDocumentSummary[] = docs.map((document) => {
                  const { body: _body, ...summary } = document as typeof document & { body?: string };
                  return { ...summary, format: "markdown" as const };
                });
                return [
                  issueId,
                  summaries,
                ] as const;
              }),
            )
            : Promise.resolve(null),
          params.includeActiveRuns
            ? getIssueRunSummaries(companyId, issueIds, { activeOnly: true })
            : Promise.resolve(null),
          params.includeAssignees && assigneeAgentIds.length > 0
            ? db
              .select({
                id: agentsTable.id,
                name: agentsTable.name,
                role: agentsTable.role,
                title: agentsTable.title,
                status: agentsTable.status,
              })
              .from(agentsTable)
              .where(and(eq(agentsTable.companyId, companyId), inArray(agentsTable.id, assigneeAgentIds)))
            : Promise.resolve(params.includeAssignees ? [] : null),
        ]);

        const activeRuns = activeRunRows
          ? Object.fromEntries(issueIds.map((issueId) => [
            issueId,
            activeRunRows.filter((run) => run.issueId === issueId),
          ]))
          : undefined;

        return {
          rootIssueId: rootIssue.id,
          companyId,
          issueIds,
          issues: outputIssues,
          ...(relationPairs ? { relations: Object.fromEntries(relationPairs) } : {}),
          ...(documentPairs ? { documents: Object.fromEntries(documentPairs) } : {}),
          ...(activeRuns ? { activeRuns } : {}),
          ...(assigneeRows
            ? {
                assignees: Object.fromEntries(assigneeRows.map((agent) => [
                  agent.id,
                  { ...agent, status: agent.status as Agent["status"] } as PluginIssueAssigneeSummary,
                ])),
              }
            : {}),
        };
      },
      async requestWakeup(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        if (!issue.assigneeAgentId) {
          throw new Error("Issue has no assigned agent to wake");
        }
        if (["backlog", "done", "cancelled"].includes(issue.status)) {
          throw new Error(`Issue is not wakeable in status: ${issue.status}`);
        }
        const relations = await issues.getRelationSummaries(issue.id);
        const unresolvedBlockers = relations.blockedBy.filter((blocker) => blocker.status !== "done");
        if (unresolvedBlockers.length > 0) {
          throw new Error("Issue is blocked by unresolved blockers");
        }
        const budgetBlock = await budgets.getInvocationBlock(companyId, issue.assigneeAgentId, {
          issueId: issue.id,
          projectId: issue.projectId,
        });
        if (budgetBlock) {
          throw new Error(budgetBlock.reason);
        }
        const contextSource = params.contextSource ?? "plugin.issue.requestWakeup";
        const run = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: params.reason ?? "plugin_issue_wakeup_requested",
          payload: {
            issueId: issue.id,
            mutation: "plugin_wakeup",
            pluginId,
            pluginKey,
            contextSource,
          },
          idempotencyKey: params.idempotencyKey ?? null,
          requestedByActorType: "system",
          requestedByActorId: pluginId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            wakeReason: params.reason ?? "plugin_issue_wakeup_requested",
            source: contextSource,
            pluginId,
            pluginKey,
          },
        });
        await logPluginActivity({
          companyId,
          action: "issue.assignment_wakeup_requested",
          entityType: "issue",
          entityId: issue.id,
          actor: {
            actorAgentId: params.actorAgentId,
            actorUserId: params.actorUserId,
            actorRunId: params.actorRunId,
          },
          details: {
            identifier: issue.identifier,
            assigneeAgentId: issue.assigneeAgentId,
            runId: run?.id ?? null,
            reason: params.reason ?? "plugin_issue_wakeup_requested",
            contextSource,
          },
        });
        return { queued: Boolean(run), runId: run?.id ?? null };
      },
      async requestWakeups(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const results = [];
        for (const issueId of [...new Set(params.issueIds)]) {
          const issue = requireInCompany("Issue", await issues.getById(issueId), companyId);
          if (!issue.assigneeAgentId) {
            throw new Error("Issue has no assigned agent to wake");
          }
          if (["backlog", "done", "cancelled"].includes(issue.status)) {
            throw new Error(`Issue is not wakeable in status: ${issue.status}`);
          }
          const relations = await issues.getRelationSummaries(issue.id);
          const unresolvedBlockers = relations.blockedBy.filter((blocker) => blocker.status !== "done");
          if (unresolvedBlockers.length > 0) {
            throw new Error("Issue is blocked by unresolved blockers");
          }
          const budgetBlock = await budgets.getInvocationBlock(companyId, issue.assigneeAgentId, {
            issueId: issue.id,
            projectId: issue.projectId,
          });
          if (budgetBlock) {
            throw new Error(budgetBlock.reason);
          }
          const contextSource = params.contextSource ?? "plugin.issue.requestWakeups";
          const run = await heartbeat.wakeup(issue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: params.reason ?? "plugin_issue_wakeup_requested",
            payload: {
              issueId: issue.id,
              mutation: "plugin_wakeup",
              pluginId,
              pluginKey,
              contextSource,
            },
            idempotencyKey: params.idempotencyKeyPrefix ? `${params.idempotencyKeyPrefix}:${issue.id}` : null,
            requestedByActorType: "system",
            requestedByActorId: pluginId,
            contextSnapshot: {
              issueId: issue.id,
              taskId: issue.id,
              wakeReason: params.reason ?? "plugin_issue_wakeup_requested",
              source: contextSource,
              pluginId,
              pluginKey,
            },
          });
          await logPluginActivity({
            companyId,
            action: "issue.assignment_wakeup_requested",
            entityType: "issue",
            entityId: issue.id,
            actor: {
              actorAgentId: params.actorAgentId,
              actorUserId: params.actorUserId,
              actorRunId: params.actorRunId,
            },
            details: {
              identifier: issue.identifier,
              assigneeAgentId: issue.assigneeAgentId,
              runId: run?.id ?? null,
              reason: params.reason ?? "plugin_issue_wakeup_requested",
              contextSource,
            },
          });
          results.push({ issueId: issue.id, queued: Boolean(run), runId: run?.id ?? null });
        }
        return results;
      },
      async getOrchestrationSummary(params): Promise<PluginIssueOrchestrationSummary> {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rootIssue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const subtreeIssueIds = params.includeSubtree
          ? await collectIssueSubtreeIds(companyId, rootIssue.id)
          : [rootIssue.id];
        const relationPairs = await Promise.all(
          subtreeIssueIds.map(async (issueId) => [issueId, await issues.getRelationSummaries(issueId)] as const),
        );
        const approvalRows = (
          await Promise.all(
            subtreeIssueIds.map(async (issueId) => {
              const rows = await issueApprovals.listApprovalsForIssue(issueId);
              return rows.map((approval) => ({
                issueId,
                id: approval.id,
                type: approval.type,
                status: approval.status,
                requestedByAgentId: approval.requestedByAgentId,
                requestedByUserId: approval.requestedByUserId,
                decidedByUserId: approval.decidedByUserId,
                decidedAt: approval.decidedAt?.toISOString() ?? null,
                createdAt: approval.createdAt.toISOString(),
              }));
            }),
          )
        ).flat();
        const [runs, costsSummary, openBudgetIncidents] = await Promise.all([
          getIssueRunSummaries(companyId, subtreeIssueIds),
          getIssueCostSummary(companyId, subtreeIssueIds, params.billingCode ?? rootIssue.billingCode ?? null),
          getOpenBudgetIncidents(companyId),
        ]);
        const issueRows = await db
          .select({
            id: issuesTable.id,
            assigneeAgentId: issuesTable.assigneeAgentId,
            projectId: issuesTable.projectId,
          })
          .from(issuesTable)
          .where(and(eq(issuesTable.companyId, companyId), inArray(issuesTable.id, subtreeIssueIds)));
        const invocationBlocks = (
          await Promise.all(
            issueRows
              .filter((issueRow) => issueRow.assigneeAgentId)
              .map(async (issueRow) => {
                const block = await budgets.getInvocationBlock(companyId, issueRow.assigneeAgentId!, {
                  issueId: issueRow.id,
                  projectId: issueRow.projectId,
                });
                return block
                  ? {
                    issueId: issueRow.id,
                    agentId: issueRow.assigneeAgentId!,
                    scopeType: block.scopeType,
                    scopeId: block.scopeId,
                    scopeName: block.scopeName,
                    reason: block.reason,
                  }
                  : null;
              }),
          )
        ).filter((block): block is NonNullable<typeof block> => block !== null);
        return {
          issueId: rootIssue.id,
          companyId,
          subtreeIssueIds,
          relations: Object.fromEntries(relationPairs),
          approvals: approvalRows,
          runs,
          costs: costsSummary,
          openBudgetIncidents,
          invocationBlocks,
        };
      },
      async listComments(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (!inCompany(await issues.getById(params.issueId), companyId)) return [];
        return (await issues.listComments(params.issueId)) as IssueComment[];
      },
      async createComment(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const comment = (await issues.addComment(
          params.issueId,
          params.body,
          { agentId: params.authorAgentId },
        )) as IssueComment;
        await logPluginActivity({
          companyId,
          action: "issue.comment.created",
          entityType: "issue",
          entityId: issue.id,
          actor: { actorAgentId: params.authorAgentId ?? null },
          details: {
            identifier: issue.identifier,
            commentId: comment.id,
            bodySnippet: comment.body.slice(0, 120),
          },
        });
        return comment;
      },
      async createInteraction(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const interaction = await issueThreadInteractionService(db).create(issue, params.interaction as CreateIssueThreadInteraction, {
          agentId: params.authorAgentId ?? null,
        });
        await logPluginActivity({
          companyId,
          action: "issue.thread_interaction_created",
          entityType: "issue",
          entityId: issue.id,
          actor: { actorAgentId: params.authorAgentId ?? null },
          details: {
            identifier: issue.identifier,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            continuationPolicy: interaction.continuationPolicy,
          },
        });
        return interaction as any;
      },
    },

    issueDocuments: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const rows = await documents.listIssueDocuments(params.issueId);
        return rows as any;
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const doc = await documents.getIssueDocumentByKey(params.issueId, params.key);
        return (doc ?? null) as any;
      },
      async upsert(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        const result = await documents.upsertIssueDocument({
          issueId: params.issueId,
          key: params.key,
          body: params.body,
          title: params.title ?? null,
          format: params.format ?? "markdown",
          changeSummary: params.changeSummary ?? null,
        });
        await logPluginActivity({
          companyId,
          action: "issue.document_upserted",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            documentKey: params.key,
            title: params.title ?? null,
            format: params.format ?? "markdown",
          },
        });
        return result.document as any;
      },
      async delete(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = requireInCompany("Issue", await issues.getById(params.issueId), companyId);
        await documents.deleteIssueDocument(params.issueId, params.key);
        await logPluginActivity({
          companyId,
          action: "issue.document_deleted",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            documentKey: params.key,
          },
        });
      },
    },

    agents: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await agents.list(companyId);
        return applyWindow(
          rows.filter((agent) => !params.status || agent.status === params.status) as Agent[],
          params,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        return (inCompany(agent, companyId) ? agent : null) as Agent | null;
      },
      async pause(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.pause(params.agentId)) as Agent;
      },
      async resume(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.resume(params.agentId)) as Agent;
      },
      async invoke(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const run = await heartbeat.wakeup(params.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");
        return { runId: run.id };
      },
    },

    goals: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await goals.list(companyId);
        return applyWindow(
          rows.filter((goal) =>
            (!params.level || goal.level === params.level) &&
            (!params.status || goal.status === params.status),
          ) as Goal[],
          params,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const goal = await goals.getById(params.goalId);
        return (inCompany(goal, companyId) ? goal : null) as Goal | null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return (await goals.create(companyId, {
          title: params.title,
          description: params.description,
          level: params.level as any,
          status: params.status as any,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        })) as Goal;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Goal", await goals.getById(params.goalId), companyId);
        return (await goals.update(params.goalId, params.patch as any)) as Goal;
      },
    },

    agentSessions: {
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const taskKey = params.taskKey ?? `plugin:${pluginKey}:session:${randomUUID()}`;

        const row = await db
          .insert(agentTaskSessionsTable)
          .values({
            companyId,
            agentId: params.agentId,
            adapterType: agent!.adapterType,
            taskKey,
            sessionParamsJson: null,
            sessionDisplayId: null,
            lastRunId: null,
            lastError: null,
          })
          .returning()
          .then((rows) => rows[0]);

        return {
          sessionId: row!.id,
          agentId: params.agentId,
          companyId,
          status: "active" as const,
          createdAt: row!.createdAt.toISOString(),
        };
      },

      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.agentId, params.agentId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .orderBy(desc(agentTaskSessionsTable.createdAt));

        return rows.map((row) => ({
          sessionId: row.id,
          agentId: row.agentId,
          companyId: row.companyId,
          status: "active" as const,
          createdAt: row.createdAt.toISOString(),
        }));
      },

      async sendMessage(params) {
        if (disposed) {
          throw new Error("Host services have been disposed");
        }

        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);

        // Verify session exists and belongs to this plugin
        const session = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!session) throw new Error(`Session not found: ${params.sessionId}`);

        const run = await heartbeat.wakeup(session.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          contextSnapshot: {
            taskKey: session.taskKey,
            wakeSource: "automation",
            wakeTriggerDetail: "system",
          },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");

        // Subscribe to live events and forward to the plugin worker as notifications.
        // Track the subscription so it can be cleaned up on dispose() if the run
        // never reaches a terminal status (hang, crash, network partition).
        if (notifyWorker) {
          const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

          const cleanup = () => {
            unsubscribe();
            clearTimeout(timeoutTimer);
            activeSubscriptions.delete(entry);
          };

          const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (!payload || payload.runId !== run.id) return;

            if (event.type === "heartbeat.run.log" || event.type === "heartbeat.run.event") {
              notifyWorker("agents.sessions.event", {
                sessionId: params.sessionId,
                runId: run.id,
                seq: (payload.seq as number) ?? 0,
                eventType: "chunk",
                stream: (payload.stream as string) ?? null,
                message: (payload.chunk as string) ?? (payload.message as string) ?? null,
                payload: payload,
              });
            } else if (event.type === "heartbeat.run.status") {
              const status = payload.status as string;
              if (TERMINAL_STATUSES.has(status)) {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: status === "succeeded" ? "done" : "error",
                  stream: "system",
                  message: status === "succeeded" ? "Run completed" : `Run ${status}`,
                  payload: payload,
                });
                cleanup();
              } else {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: "status",
                  stream: "system",
                  message: `Run status: ${status}`,
                  payload: payload,
                });
              }
            }
          });

          // Safety-net timeout: if the run never reaches a terminal status,
          // force-cleanup the subscription to prevent unbounded leaks.
          const timeoutTimer = setTimeout(() => {
            logger.warn(
              { pluginId, pluginKey, runId: run.id },
              "session event subscription timed out — forcing cleanup",
            );
            cleanup();
          }, SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS);

          const entry = { unsubscribe, timer: timeoutTimer };
          activeSubscriptions.add(entry);
        }

        return { runId: run.id };
      },

      async close(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const deleted = await db
          .delete(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .returning()
          .then((rows) => rows.length);
        if (deleted === 0) throw new Error(`Session not found: ${params.sessionId}`);
      },
    },

    /**
     * Clean up all active session event subscriptions and flush any buffered
     * log entries. Must be called when the plugin worker is stopped, crashed,
     * or unloaded to prevent leaked listeners and lost log entries.
     */
    dispose() {
      disposed = true;

      // Clear event bus subscriptions to prevent accumulation on worker restart.
      // Without this, each crash/restart cycle adds duplicate subscriptions.
      scopedBus.clear();

      // Snapshot to avoid iterator invalidation from concurrent sendMessage() calls
      const snapshot = Array.from(activeSubscriptions);
      activeSubscriptions.clear();

      for (const entry of snapshot) {
        clearTimeout(entry.timer);
        entry.unsubscribe();
      }

      // Flush any buffered log entries synchronously-as-possible on dispose.
      flushPluginLogBuffer().catch((err) => {
        console.error("[plugin-host-services] dispose() log flush failed:", err);
      });
    },
  };
}
