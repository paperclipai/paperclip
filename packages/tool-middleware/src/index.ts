/**
 * @paperclipai/tool-middleware
 *
 * Tool I/O middleware for Paperclip agent workflows:
 * - Artifact storage (content-addressed, secret-redacted)
 * - Output pruning (schema-constrained summaries)
 * - Input validation (byte ceiling enforcement)
 * - Dedup cache (disk-based, TTL per tool type)
 * - Langfuse telemetry (async, non-blocking)
 */

export { storeArtifact, readArtifact, pruneArtifacts, ARTIFACT_URI_PREFIX } from "./artifact-store.js";
export { redactSecrets, redactSecretsInValue } from "./secret-redactor.js";
export { pruneToolOutput, formatSummaryForContext } from "./output-pruner.js";
export { validateToolInput, buildBlockResponse } from "./input-validator.js";
export {
  readCache,
  writeCache,
  buildCacheKey,
  resolveTtlMs,
  hashCommand,
  computeCacheKeyHash,
  getCurrentGitSha,
} from "./result-cache.js";
export {
  emitToolSpan,
  logToStderr,
  generateTraceId,
  generateSpanId,
  type ToolSpanData,
  type LangfuseExporterConfig,
} from "./langfuse-exporter.js";
export { runHook } from "./hook-runner.js";
export {
  DEFAULT_CONFIG,
  resolveConfig,
  type ToolMiddlewareConfig,
  type ArtifactRef,
  type ToolResultSummary,
  type CacheKey,
  type CacheEntry,
  type HookEvent,
  type PreToolUseEvent,
  type PostToolUseEvent,
} from "./types.js";
