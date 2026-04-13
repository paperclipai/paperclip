/**
 * Tool I/O Middleware — shared types.
 *
 * Defines the hook event shapes received from Claude Code via stdin,
 * and the structured summary returned to the LLM context.
 */

// ---------------------------------------------------------------------------
// Hook event payloads (stdin from Claude Code)
// ---------------------------------------------------------------------------

/** Payload Claude Code sends to a PreToolUse hook via stdin. */
export interface PreToolUseEvent {
  hook_event_type: "PreToolUse";
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** Payload Claude Code sends to a PostToolUse hook via stdin. */
export interface PostToolUseEvent {
  hook_event_type: "PostToolUse";
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}

export type HookEvent = PreToolUseEvent | PostToolUseEvent;

// ---------------------------------------------------------------------------
// Artifact references
// ---------------------------------------------------------------------------

/** A content-addressed reference to a stored artifact. */
export interface ArtifactRef {
  /** SHA-256 hex digest of the stored content. */
  hash: string;
  /** Artifact URI: `artifact://{hash}` */
  uri: string;
  /** Stored byte count. */
  bytes: number;
  /** Line count of stored content. */
  lines: number;
}

// ---------------------------------------------------------------------------
// Pruned tool result (what the LLM sees)
// ---------------------------------------------------------------------------

/** Schema-constrained summary returned to the model context after pruning. */
export interface ToolResultSummary {
  tool: string;
  status: "success" | "error";
  exit_code: number;
  duration_ms: number;
  stdout_ref: string;
  stderr_ref: string;
  /** First 200 characters of output. */
  preview: string;
  /** Tool-specific extracted fields (from jq-equivalent filter), or null. */
  parsed: Record<string, unknown> | null;
  truncation_flag: boolean;
  original_bytes: number;
  original_lines: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Key material for the dedup cache. */
export interface CacheKey {
  commandHash: string;
  cwd: string;
  gitSha: string;
}

export interface CacheEntry {
  key: CacheKey;
  summary: ToolResultSummary;
  storedAt: number;
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// Hook runner config (from environment variables)
// ---------------------------------------------------------------------------

export interface ToolMiddlewareConfig {
  /** Directory for artifact storage. Default: `.agent_artifacts` */
  artifactsDir: string;
  /** Directory for disk cache. Default: `.agent_artifacts/cache` */
  cacheDir: string;
  /** Langfuse API base URL (empty = disabled). */
  langfuseBaseUrl: string;
  /** Langfuse public key. */
  langfusePublicKey: string;
  /** Langfuse secret key. */
  langfuseSecretKey: string;
  /** Maximum input bytes before rejection. Default: 10_000 */
  maxInputBytes: number;
  /** Maximum output bytes before truncation. Default: 1_500 */
  maxOutputBytes: number;
  /** Maximum output token estimate before truncation. Default: 300 */
  maxOutputTokens: number;
  /** Originating ticket/issue id for telemetry. */
  ticketId: string;
  /** Team/company id for telemetry. */
  teamId: string;
}

export const DEFAULT_CONFIG: ToolMiddlewareConfig = {
  artifactsDir: ".agent_artifacts",
  cacheDir: ".agent_artifacts/cache",
  langfuseBaseUrl: "",
  langfusePublicKey: "",
  langfuseSecretKey: "",
  maxInputBytes: 10_000,
  maxOutputBytes: 1_500,
  maxOutputTokens: 300,
  ticketId: "",
  teamId: "",
};

/** Resolve config from environment variables. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ToolMiddlewareConfig {
  const cwd = process.cwd();
  const artifactsDir = env.TOOL_MIDDLEWARE_ARTIFACTS_DIR
    ? (env.TOOL_MIDDLEWARE_ARTIFACTS_DIR.startsWith("/")
        ? env.TOOL_MIDDLEWARE_ARTIFACTS_DIR
        : `${cwd}/${env.TOOL_MIDDLEWARE_ARTIFACTS_DIR}`)
    : `${cwd}/${DEFAULT_CONFIG.artifactsDir}`;
  const cacheDir = env.TOOL_MIDDLEWARE_CACHE_DIR
    ? (env.TOOL_MIDDLEWARE_CACHE_DIR.startsWith("/")
        ? env.TOOL_MIDDLEWARE_CACHE_DIR
        : `${cwd}/${env.TOOL_MIDDLEWARE_CACHE_DIR}`)
    : `${artifactsDir}/cache`;

  return {
    artifactsDir,
    cacheDir,
    langfuseBaseUrl: env.LANGFUSE_BASE_URL ?? "",
    langfusePublicKey: env.LANGFUSE_PUBLIC_KEY ?? "",
    langfuseSecretKey: env.LANGFUSE_SECRET_KEY ?? "",
    maxInputBytes: parseInt(env.TOOL_MIDDLEWARE_MAX_INPUT_BYTES ?? "", 10) || DEFAULT_CONFIG.maxInputBytes,
    maxOutputBytes: parseInt(env.TOOL_MIDDLEWARE_MAX_OUTPUT_BYTES ?? "", 10) || DEFAULT_CONFIG.maxOutputBytes,
    maxOutputTokens: parseInt(env.TOOL_MIDDLEWARE_MAX_OUTPUT_TOKENS ?? "", 10) || DEFAULT_CONFIG.maxOutputTokens,
    ticketId: env.PAPERCLIP_TASK_ID ?? env.TOOL_MIDDLEWARE_TICKET_ID ?? "",
    teamId: env.PAPERCLIP_COMPANY_ID ?? env.TOOL_MIDDLEWARE_TEAM_ID ?? "",
  };
}
