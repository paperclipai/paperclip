import type { Db } from "@paperclipai/db";
import type {
  CornerstoneToolRequest,
  CornerstoneToolResult,
  CornerstoneToolStatus,
  CornerstoneToolsCallback,
} from "@paperclipai/adapter-utils";
import { secretService } from "./secrets.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CORNERSTONE_API_BASE_URL =
  "https://cornerstone-api-lymgtgeena-nw.a.run.app";
// Canonical Cornerstone workspace name is `aiops` (no hyphen — verified via
// GET /admin/namespaces 2026-04-24: actual workspace rows are `aiops`,
// `default`, `usefulmachines`, `testworkspace`, `suzannah`). Earlier planning
// docs use the hyphenated `ai-ops` form; that doesn't match the row and will
// 403 namespace_not_granted.
export const AI_OPS_WRITE_WORKSPACE = "aiops";
export const CORNERSTONE_API_KEY_SECRET_NAME = "CORNERSTONE_API_KEY";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CornerstoneToolName =
  | "get_context"
  | "search"
  | "list_facts"
  | "recall"
  | "add_fact"
  | "save_conversation"
  | "steward_inspect"
  | "steward_advise"
  | "steward_preview"
  | "steward_apply"
  | "steward_status";

export const CORNERSTONE_TOOL_NAMES: readonly CornerstoneToolName[] = [
  "get_context",
  "search",
  "list_facts",
  "recall",
  "add_fact",
  "save_conversation",
  "steward_inspect",
  "steward_advise",
  "steward_preview",
  "steward_apply",
  "steward_status",
] as const;

// steward_apply is destructive; blocked for dogfood until approval queue UI
// ships. Every call returns pending_approval with a structured error code so
// the agent can report it cleanly without retrying.
const BLOCKED_TOOLS: ReadonlySet<CornerstoneToolName> = new Set(["steward_apply"]);

// Write tools always get their namespace forced to aiops regardless of what
// the agent passes. Per-agent attribution is carried via key prefix
// conventions (donald_audit_, alan_investigation_, etc.), not namespace.
const WRITE_TOOLS: ReadonlySet<CornerstoneToolName> = new Set([
  "add_fact",
  "save_conversation",
  "steward_preview",
  "steward_apply",
]);

export type { CornerstoneToolRequest, CornerstoneToolResult, CornerstoneToolStatus, CornerstoneToolsCallback };

export interface CornerstoneToolsDeps {
  db?: Db;
  companyId: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  // Test hook. Prod path resolves via secretService(db).getByName + latest
  // version decrypt; tests pass a plain string to skip DB wiring.
  apiKeyResolver?: () => Promise<string>;
  // Per-task Cornerstone namespace inherited from issues.target_workspace.
  // When set, this overrides the AI_OPS_WRITE_WORKSPACE fallback for both
  // reads and writes — and on writes, agent-supplied namespace input is
  // ignored (delegation safety / prompt-injection guard). When null, falls
  // through to AI_OPS_WRITE_WORKSPACE so the previous global behaviour
  // remains the default for tasks that haven't been routed yet.
  targetWorkspace?: string | null;
}

function isCornerstoneToolName(name: string): name is CornerstoneToolName {
  return (CORNERSTONE_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : null;
}

function readOptionalInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Steward sub-operation routing tables.
//
// The `steward_*` agent-facing tools collapse a family of REST endpoints
// behind a single tool name. The agent chooses which sub-endpoint via an
// `operation` field on the tool input. Unknown operations surface as a
// structured "unsupported_operation" error without hitting the API.
// ---------------------------------------------------------------------------

const STEWARD_INSPECT_OPERATIONS: Readonly<Record<string, string>> = {
  duplicates: "/ops/steward/inspect/duplicates",
  contradictions: "/ops/steward/inspect/contradictions",
  stale: "/ops/steward/inspect/stale",
  expired: "/ops/steward/inspect/expired",
  orphans: "/ops/steward/inspect/orphans",
  "key-taxonomy": "/ops/steward/inspect/key-taxonomy",
  "missing-dates": "/ops/steward/inspect/missing-dates",
  "stale-embeddings": "/ops/steward/inspect/stale-embeddings",
  "cross-workspace-duplicates": "/ops/steward/inspect/cross-workspace-duplicates",
  "retrieval-interference": "/ops/steward/inspect/retrieval-interference",
  "composite-health": "/ops/steward/inspect/composite-health",
  "fact-quality": "/ops/steward/inspect/fact-quality",
};

const STEWARD_ADVISE_OPERATIONS: Readonly<Record<string, string>> = {
  merge: "/ops/steward/advise/merge",
  consolidate: "/ops/steward/advise/consolidate",
  "stale-review": "/ops/steward/advise/stale-review",
  "key-taxonomy": "/ops/steward/advise/key-taxonomy",
  contradictions: "/ops/steward/advise/contradictions",
};

const STEWARD_PREVIEW_OPERATIONS: Readonly<Record<string, string>> = {
  "merge-duplicates": "/ops/steward/mutate/merge-duplicates/preview",
  "merge-notes": "/ops/steward/mutate/merge-notes/preview",
  "archive-stale": "/ops/steward/mutate/archive-stale/preview",
  "delete-by-filter": "/ops/steward/mutate/delete-by-filter/preview",
  "consolidate-facts": "/ops/steward/mutate/consolidate-facts/preview",
  "reembed-stale": "/ops/steward/mutate/reembed-stale/preview",
  "rename-keys": "/ops/steward/mutate/rename-keys/preview",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCornerstoneToolsCallback(
  deps: CornerstoneToolsDeps,
): CornerstoneToolsCallback {
  const baseUrl = (deps.apiBaseUrl ?? DEFAULT_CORNERSTONE_API_BASE_URL).replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  // Closure-captured task workspace. Resolved once per heartbeat factory
  // invocation; null = no per-task routing, fall through to env fallback.
  const taskWorkspace = deps.targetWorkspace ?? null;
  // Effective write namespace: task wins over env fallback; agent input is
  // never consulted on writes regardless of taskWorkspace.
  const writeNamespace = taskWorkspace ?? AI_OPS_WRITE_WORKSPACE;

  let resolveApiKey: () => Promise<string>;
  if (deps.apiKeyResolver) {
    resolveApiKey = deps.apiKeyResolver;
  } else {
    if (!deps.db) {
      throw new Error("createCornerstoneToolsCallback requires either `db` or `apiKeyResolver`");
    }
    const secrets = secretService(deps.db);
    resolveApiKey = async () => {
      const secret = await secrets.getByName(deps.companyId, CORNERSTONE_API_KEY_SECRET_NAME);
      if (!secret) {
        throw new CornerstoneToolConfigError(
          "cornerstone_api_key_missing",
          `Company ${deps.companyId} has no ${CORNERSTONE_API_KEY_SECRET_NAME} secret configured`,
        );
      }
      return secrets.resolveSecretValue(deps.companyId, secret.id, "latest");
    };
  }

  async function callApi(
    method: "GET" | "POST",
    path: string,
    options: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
  ): Promise<{ ok: true; body: unknown } | { ok: false; status: number; body: unknown }> {
    const apiKey = await resolveApiKey();
    const url = new URL(`${baseUrl}${path}`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }
    const res = await doFetch(url.toString(), {
      method,
      headers: {
        "X-API-Key": apiKey,
        "content-type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const raw = await res.text();
    let parsed: unknown = raw;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // fall through with string body
      }
    }
    if (!res.ok) return { ok: false, status: res.status, body: parsed };
    return { ok: true, body: parsed };
  }

  function apiErrorMessage(body: unknown): string {
    const rec = asRecord(body);
    if (rec) {
      const detail = rec.detail ?? rec.error ?? rec.message;
      if (typeof detail === "string") return detail;
    }
    if (typeof body === "string" && body.length > 0) return body;
    return "Cornerstone API error";
  }

  // Detects the Cornerstone API's namespace-grant rejections. The API returns
  // 403 with detail strings like "namespace_not_granted" or
  // "Namespace is required. This principal has multiple workspace grants" —
  // both indicate the resolved namespace is not authorised for the principal
  // (or no namespace was resolvable at all). We surface this as a stable
  // structured code so adapters / agents can react cleanly without parsing
  // free-text detail.
  function isNamespaceGrantFailure(status: number, body: unknown): boolean {
    if (status !== 403) return false;
    const rec = asRecord(body);
    const detail = rec
      ? (rec.detail ?? rec.error ?? rec.message)
      : typeof body === "string"
        ? body
        : null;
    if (typeof detail !== "string") return false;
    const lower = detail.toLowerCase();
    return (
      lower.includes("namespace_not_granted") ||
      lower.includes("namespace is required") ||
      lower.includes("not granted")
    );
  }

  function mapApiError(
    res: { ok: false; status: number; body: unknown },
    namespace: string | null,
  ): CornerstoneToolResult {
    if (isNamespaceGrantFailure(res.status, res.body)) {
      const ns = namespace ?? writeNamespace;
      return errorResult(
        "target_workspace_grant_missing",
        `Cornerstone principal has no grant for namespace "${ns}". ` +
          (taskWorkspace
            ? `This task's targetWorkspace is "${taskWorkspace}" — request a grant for it on this principal, or update issues.target_workspace to a namespace this principal can access.`
            : `Falling back to AI_OPS_WRITE_WORKSPACE ("${AI_OPS_WRITE_WORKSPACE}"); set issues.target_workspace to a namespace this principal can access.`),
        res,
      );
    }
    return errorResult("cornerstone_api_error", apiErrorMessage(res.body), res);
  }

  function errorResult(
    code: string,
    message: string,
    extra?: { status?: number; body?: unknown },
  ): CornerstoneToolResult {
    return {
      status: "error",
      errorCode: code,
      errorMessage: message,
      output: extra?.body !== undefined
        ? { status: extra.status ?? null, body: extra.body }
        : undefined,
    };
  }

  async function dispatch(req: CornerstoneToolRequest): Promise<CornerstoneToolResult> {
    if (!isCornerstoneToolName(req.name)) {
      return errorResult("unknown_tool", `Unknown Cornerstone tool: ${req.name}`);
    }
    const toolName: CornerstoneToolName = req.name;
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        status: "pending_approval",
        errorCode: "approval_queue_not_available",
        errorMessage:
          `Destructive Cornerstone tool ${toolName} is gated pending the approval-queue UI (Bug 2 follow-up). Use steward_preview to see the intended effect and surface the audit as a recommendation.`,
      };
    }
    const input = asRecord(req.input) ?? {};
    const isWrite = WRITE_TOOLS.has(toolName);
    const namespaceRaw = readOptionalString(input.namespace);
    // Resolution rules (Mal's directive 2026-04-25):
    //   Writes:  taskWorkspace ?? AI_OPS_WRITE_WORKSPACE   (agent IGNORED)
    //   Reads:   taskWorkspace ?? agentSupplied ?? AI_OPS_WRITE_WORKSPACE
    // Task wins for delegation safety — agent-supplied namespace via tool
    // call cannot override a parent task's workspace (closes prompt-injection
    // hole). For reads, agent input still serves as a useful escape hatch
    // when the task itself didn't pin a workspace (back-compat for tasks
    // filed before targetWorkspace existed).
    const namespace = isWrite
      ? writeNamespace
      : (taskWorkspace ?? namespaceRaw ?? AI_OPS_WRITE_WORKSPACE);

    try {
      switch (toolName) {
        case "get_context":
          return await handleGetContext(input, namespace);
        case "search":
          return await handleSearch(input, namespace);
        case "list_facts":
          return await handleListFacts(input, namespace);
        case "recall":
          return await handleRecall(input, namespace);
        case "add_fact":
          return await handleAddFact(input);
        case "save_conversation":
          return await handleSaveConversation(input);
        case "steward_inspect":
          return await handleStewardMeta(input, namespace, "steward_inspect");
        case "steward_advise":
          return await handleStewardMeta(input, namespace, "steward_advise");
        case "steward_preview":
          return await handleStewardPreview(input);
        case "steward_status":
          return await handleStewardStatus(input);
        case "steward_apply":
          // Unreachable — steward_apply is short-circuited by BLOCKED_TOOLS above.
          return errorResult("approval_queue_not_available", "steward_apply blocked");
      }
    } catch (err) {
      if (err instanceof CornerstoneToolConfigError) {
        return errorResult(err.code, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResult("cornerstone_api_unreachable", message);
    }
  }

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  async function handleGetContext(
    input: Record<string, unknown>,
    namespace: string | null,
  ): Promise<CornerstoneToolResult> {
    const query = readString(input.query);
    if (!query) return errorResult("invalid_input", "get_context requires non-empty `query`");
    const body: Record<string, unknown> = {
      query,
      namespace: namespace ?? "",
      detail_level: readOptionalString(input.detail_level) ?? "standard",
      max_tokens: readOptionalInt(input.max_tokens) ?? 2000,
    };
    const res = await callApi("POST", "/context", { body });
    if (!res.ok) {
      return mapApiError(res, namespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleSearch(
    input: Record<string, unknown>,
    namespace: string | null,
  ): Promise<CornerstoneToolResult> {
    const query = readString(input.query);
    if (!query) return errorResult("invalid_input", "search requires non-empty `query`");
    const body: Record<string, unknown> = {
      query,
      namespace: namespace ?? "",
      detail_level: readOptionalString(input.detail_level) ?? "minimal",
      max_tokens: readOptionalInt(input.max_tokens) ?? 600,
    };
    const res = await callApi("POST", "/context", { body });
    if (!res.ok) {
      return mapApiError(res, namespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleListFacts(
    input: Record<string, unknown>,
    namespace: string | null,
  ): Promise<CornerstoneToolResult> {
    const query: Record<string, string> = {};
    if (namespace) query.namespace = namespace;
    const keyPrefix = readOptionalString(input.key_prefix);
    if (keyPrefix) query.key_prefix = keyPrefix;
    const category = readOptionalString(input.category);
    if (category) query.category = category;
    const limit = readOptionalInt(input.limit);
    if (limit !== null) query.limit = String(Math.max(1, Math.min(limit, 500)));
    const res = await callApi("GET", "/memory/facts", { query });
    if (!res.ok) {
      return mapApiError(res, namespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleRecall(
    input: Record<string, unknown>,
    namespace: string | null,
  ): Promise<CornerstoneToolResult> {
    // recall is agent-surface convenience for POST /context with higher detail.
    const query = readString(input.query);
    if (!query) return errorResult("invalid_input", "recall requires non-empty `query`");
    const body: Record<string, unknown> = {
      query,
      namespace: namespace ?? "",
      detail_level: readOptionalString(input.detail_level) ?? "comprehensive",
      max_tokens: readOptionalInt(input.max_tokens) ?? 4000,
    };
    const res = await callApi("POST", "/context", { body });
    if (!res.ok) {
      return mapApiError(res, namespace);
    }
    return { status: "ok", output: res.body };
  }

  // -------------------------------------------------------------------------
  // Write tools (namespace forced to aiops)
  // -------------------------------------------------------------------------

  async function handleAddFact(input: Record<string, unknown>): Promise<CornerstoneToolResult> {
    const key = readString(input.key);
    const value = readString(input.value);
    if (!key) return errorResult("invalid_input", "add_fact requires non-empty `key`");
    if (!value) return errorResult("invalid_input", "add_fact requires non-empty `value`");
    const body: Record<string, unknown> = {
      key,
      value,
      namespace: writeNamespace,
      category: readOptionalString(input.category) ?? "general",
      confidence: typeof input.confidence === "number" ? input.confidence : 0.9,
    };
    const res = await callApi("POST", "/memory/fact", { body });
    if (!res.ok) {
      return mapApiError(res, writeNamespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleSaveConversation(
    input: Record<string, unknown>,
  ): Promise<CornerstoneToolResult> {
    const topic = readString(input.topic);
    if (!topic) return errorResult("invalid_input", "save_conversation requires non-empty `topic`");
    const messages = Array.isArray(input.messages) ? input.messages : null;
    if (!messages || messages.length === 0) {
      return errorResult("invalid_input", "save_conversation requires non-empty `messages` array");
    }
    const body: Record<string, unknown> = {
      topic,
      messages,
      namespace: writeNamespace,
    };
    const source = readOptionalString(input.source);
    if (source) body.source = source;
    const res = await callApi("POST", "/ingest", { body });
    if (!res.ok) {
      return mapApiError(res, writeNamespace);
    }
    return { status: "ok", output: res.body };
  }

  // -------------------------------------------------------------------------
  // Steward meta-tool dispatch
  // -------------------------------------------------------------------------

  async function handleStewardMeta(
    input: Record<string, unknown>,
    namespace: string | null,
    tool: "steward_inspect" | "steward_advise",
  ): Promise<CornerstoneToolResult> {
    const operation = readString(input.operation);
    if (!operation) {
      return errorResult(
        "invalid_input",
        `${tool} requires an \`operation\` field (see input_schema for valid values)`,
      );
    }
    const table =
      tool === "steward_inspect" ? STEWARD_INSPECT_OPERATIONS : STEWARD_ADVISE_OPERATIONS;
    const path = table[operation];
    if (!path) {
      return errorResult(
        "unsupported_operation",
        `${tool} does not support operation \`${operation}\`. Supported: ${Object.keys(table).join(", ")}`,
      );
    }
    // Cornerstone API: /ops/steward/inspect/* is GET-only (read-only query),
    // /ops/steward/advise/* is POST-only (takes a plan-generation body).
    // Verified empirically 2026-04-24: POST /inspect/duplicates → 405,
    // GET /advise/merge → 405. Ada's audit failed because all four parallel
    // steward_inspect calls 405'd, every tool_result came back isError=true,
    // MA hit requires_action and terminated without a synthesis span.
    const res =
      tool === "steward_inspect"
        ? await callApi("GET", path, { query: buildStewardQueryParams(input, namespace) })
        : await callApi("POST", path, { body: buildStewardRequestBody(input, namespace) });
    if (!res.ok) {
      return mapApiError(res, namespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleStewardPreview(
    input: Record<string, unknown>,
  ): Promise<CornerstoneToolResult> {
    const operation = readString(input.operation);
    if (!operation) {
      return errorResult(
        "invalid_input",
        "steward_preview requires an `operation` field (see input_schema for valid values)",
      );
    }
    const path = STEWARD_PREVIEW_OPERATIONS[operation];
    if (!path) {
      return errorResult(
        "unsupported_operation",
        `steward_preview does not support operation \`${operation}\`. Supported: ${Object.keys(STEWARD_PREVIEW_OPERATIONS).join(", ")}`,
      );
    }
    // Preview is a write-scope tool: namespace resolved from taskWorkspace
    // (or env fallback). Agent-supplied namespace input is dropped by
    // buildStewardRequestBody anyway since we pass writeNamespace explicitly.
    const body = buildStewardRequestBody(input, writeNamespace);
    const res = await callApi("POST", path, { body });
    if (!res.ok) {
      return mapApiError(res, writeNamespace);
    }
    return { status: "ok", output: res.body };
  }

  async function handleStewardStatus(
    input: Record<string, unknown>,
  ): Promise<CornerstoneToolResult> {
    const jobId = readString(input.job_id);
    if (!jobId) {
      return errorResult("invalid_input", "steward_status requires `job_id`");
    }
    const res = await callApi("GET", `/ops/maintenance/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      // steward_status is a job-id lookup, not namespace-scoped — pass null
      // so any 403 here surfaces as a generic api_error rather than the
      // workspace-grant code (the API would reject for a different reason).
      return mapApiError(res, null);
    }
    return { status: "ok", output: res.body };
  }

  return dispatch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CornerstoneToolConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CornerstoneToolConfigError";
  }
}

function buildStewardRequestBody(
  input: Record<string, unknown>,
  namespace: string | null,
): Record<string, unknown> {
  // Pass through agent-supplied fields (minus namespace + operation, which we own).
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "namespace" || k === "operation") continue;
    passthrough[k] = v;
  }
  if (namespace) passthrough.namespace = namespace;
  return passthrough;
}

function buildStewardQueryParams(
  input: Record<string, unknown>,
  namespace: string | null,
): Record<string, string> {
  // Query-string variant for GET endpoints (steward_inspect). Scalar-only —
  // GET /inspect/* doesn't accept complex shapes, so silently drop nested
  // objects/arrays rather than serialising them incorrectly.
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "namespace" || k === "operation") continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string") query[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") query[k] = String(v);
  }
  if (namespace) query.namespace = namespace;
  return query;
}
