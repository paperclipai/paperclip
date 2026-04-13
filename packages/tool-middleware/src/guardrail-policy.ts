/**
 * GuardrailPolicy — pre-dispatch validation middleware for model I/O.
 *
 * Intercepts model call payloads before they reach the API and programmatically
 * rejects those that violate structural invariants. This is enforcement, not
 * instructions — violations are rejected before the call is made.
 *
 * Violations logged as GUARDRAIL_VIOLATION spans (via Langfuse or stderr).
 * On first violation: returns instructive error to the agent.
 * On second violation in the same turn: forces a checkpoint.
 *
 * See T2 issue for full spec. Depends on T1 artifact + telemetry infrastructure.
 */

import { emitToolSpan, generateTraceId, generateSpanId } from "./langfuse-exporter.js";
import type { LangfuseExporterConfig } from "./langfuse-exporter.js";

// ---------------------------------------------------------------------------
// Violation types
// ---------------------------------------------------------------------------

export type GuardrailViolationType =
  | "tool_summary_too_large"
  | "raw_binary_or_base64_blob"
  | "dynamic_content_above_cache_breakpoint"
  | "missing_required_schema_fields"
  | "max_output_tokens_exceeded"
  | "context_window_limit";

export interface GuardrailViolation {
  type: GuardrailViolationType;
  offendingField: string;
  payloadSize: number;
  agentId: string;
  message: string;
}

export interface GuardrailResult {
  allowed: boolean;
  violations: GuardrailViolation[];
  /** Instructive error message to return to the agent on rejection. */
  errorMessage?: string;
  /** True when double-violation detected — caller should force a checkpoint. */
  forceCheckpoint: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GuardrailPolicyConfig {
  /** Maximum tool summary bytes before rejection (default 1,500). */
  maxToolSummaryBytes: number;
  /** Maximum tool summary token estimate before rejection (default 300). */
  maxToolSummaryTokens: number;
  /** Maximum output tokens for the current run profile. */
  maxOutputTokens: number;
  /** Context window size in tokens (hard stop at 90%). */
  contextWindowTokens: number;
  /** Originating agent ID for logging. */
  agentId: string;
  /** Langfuse config for violation logging (no-op if not configured). */
  langfuse: LangfuseExporterConfig;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailPolicyConfig = {
  maxToolSummaryBytes: 1_500,
  maxToolSummaryTokens: 300,
  maxOutputTokens: 32_768,
  contextWindowTokens: 200_000,
  agentId: "",
  langfuse: { baseUrl: "", publicKey: "", secretKey: "" },
};

// ---------------------------------------------------------------------------
// Dynamic content patterns (ISO timestamps, UUIDs, session IDs, etc.)
// These must NOT appear above the cache breakpoint marker.
// ---------------------------------------------------------------------------

const DYNAMIC_PATTERNS = [
  { name: "iso_timestamp", regex: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/ },
  { name: "uuid", regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: "session_id", regex: /session[_-]?id\s*[=:]\s*["']?[a-zA-Z0-9_\-]{8,}["']?/i },
  { name: "ticket_number", regex: /(?:ANGA|PAP|AUT|DEV)-\d+/ },
  { name: "cwd_path", regex: /(?:^|\s)\/(?:Users|home|workspace|tmp|var|etc)\/[^\s'"]+/m },
] as const;

// Base64 blob detection (>100 chars of base64 that look like binary data, not artifact refs)
const BASE64_BLOB_RE = /(?<![a-zA-Z0-9_\-])([A-Za-z0-9+/]{100,}={0,2})(?![a-zA-Z0-9_\-])/;
// artifact:// refs are allowed
const ARTIFACT_REF_RE = /^artifact:\/\/[0-9a-f]{64}$/;

/** Required fields for a valid ToolResult object (subset — see full schema). */
const TOOL_RESULT_REQUIRED_FIELDS = [
  "tool", "status", "exit_code", "duration_ms",
  "stdout_ref", "stderr_ref", "preview",
  "original_bytes", "original_lines",
] as const;

// ---------------------------------------------------------------------------
// Cache breakpoint detection
// ---------------------------------------------------------------------------

const CACHE_BREAKPOINT_MARKER_RE = /<!-- CACHE_BREAKPOINT -->|<cache[_-]?breakpoint\s*\/>|PAPERCLIP_CACHE_BREAK/i;

/**
 * Split a payload string into above/below the cache breakpoint.
 * If no breakpoint found, the entire string is considered "above" (conservative).
 */
function splitAtCacheBreakpoint(text: string): { above: string; below: string } {
  const match = CACHE_BREAKPOINT_MARKER_RE.exec(text);
  if (!match || match.index === undefined) {
    return { above: text, below: "" };
  }
  return {
    above: text.slice(0, match.index),
    below: text.slice(match.index + match[0].length),
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Field path extraction for objects
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function serializePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

// ---------------------------------------------------------------------------
// Per-turn violation counter (in-process state; resets between hook invocations)
// ---------------------------------------------------------------------------

// Map from sessionId → violation count in current turn
const turnViolationCounts = new Map<string, number>();

export function resetTurnViolations(sessionId: string): void {
  turnViolationCounts.delete(sessionId);
}

function recordViolation(sessionId: string): number {
  const prev = turnViolationCounts.get(sessionId) ?? 0;
  const next = prev + 1;
  turnViolationCounts.set(sessionId, next);
  return next;
}

// ---------------------------------------------------------------------------
// GuardrailPolicy
// ---------------------------------------------------------------------------

export class GuardrailPolicy {
  private config: GuardrailPolicyConfig;

  constructor(config: Partial<GuardrailPolicyConfig> = {}) {
    this.config = { ...DEFAULT_GUARDRAIL_CONFIG, ...config };
  }

  /**
   * Validate a model call payload before dispatch.
   *
   * @param payload - The full payload to be sent to the model.
   * @param sessionId - Session ID for per-turn violation tracking.
   * @returns GuardrailResult — allowed or rejected with violation details.
   */
  validate(payload: unknown, sessionId = ""): GuardrailResult {
    const violations: GuardrailViolation[] = [];
    const serialized = serializePayload(payload);
    const payloadSize = Buffer.byteLength(serialized, "utf8");

    // -----------------------------------------------------------------------
    // Check 1: Tool summary size (defense-in-depth — T1 pruner enforces first)
    // -----------------------------------------------------------------------
    this.checkToolSummaries(payload, payloadSize, violations);

    // -----------------------------------------------------------------------
    // Check 2: Raw binary or base64 blobs
    // -----------------------------------------------------------------------
    this.checkBase64Blobs(serialized, payloadSize, violations);

    // -----------------------------------------------------------------------
    // Check 3: Dynamic content above cache breakpoint
    // -----------------------------------------------------------------------
    this.checkDynamicContent(serialized, payloadSize, violations);

    // -----------------------------------------------------------------------
    // Check 4: Missing required schema fields in tool outputs
    // -----------------------------------------------------------------------
    this.checkToolResultSchemaFields(payload, payloadSize, violations);

    // -----------------------------------------------------------------------
    // Check 5: max_output_tokens ceiling
    // -----------------------------------------------------------------------
    this.checkOutputTokens(payload, payloadSize, violations);

    // -----------------------------------------------------------------------
    // Check 6: Total prompt size (90% context window)
    // -----------------------------------------------------------------------
    this.checkContextWindowLimit(serialized, payloadSize, violations);

    if (violations.length === 0) {
      return { allowed: true, violations: [], forceCheckpoint: false };
    }

    // Log violations to Langfuse (async, non-blocking)
    this.logViolations(violations, sessionId, payloadSize);

    // Track per-turn violation count
    const violationCount = recordViolation(sessionId);
    const forceCheckpoint = violationCount >= 2;

    const errorMessage = this.buildErrorMessage(violations, forceCheckpoint);

    return {
      allowed: false,
      violations,
      errorMessage,
      forceCheckpoint,
    };
  }

  // -----------------------------------------------------------------------
  // Internal checkers
  // -----------------------------------------------------------------------

  private checkToolSummaries(
    payload: unknown,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    // Walk the payload looking for ToolResult-like objects
    const toolResults = this.extractToolResults(payload);
    for (const { field, value } of toolResults) {
      const valueStr = serializePayload(value);
      const bytes = Buffer.byteLength(valueStr, "utf8");
      const tokens = estimateTokens(valueStr);
      if (bytes > this.config.maxToolSummaryBytes || tokens > this.config.maxToolSummaryTokens) {
        violations.push({
          type: "tool_summary_too_large",
          offendingField: field,
          payloadSize,
          agentId: this.config.agentId,
          message:
            `Tool output in field "${field}" is ${bytes} bytes (~${tokens} tokens), ` +
            `exceeding the ${this.config.maxToolSummaryBytes} byte / ${this.config.maxToolSummaryTokens} token limit. ` +
            `Use artifact ref instead: artifact://{hash}`,
        });
      }
    }
  }

  private extractToolResults(payload: unknown): Array<{ field: string; value: unknown }> {
    const results: Array<{ field: string; value: unknown }> = [];
    if (!isRecord(payload)) return results;

    // Check top-level and one level deep
    for (const [key, value] of Object.entries(payload)) {
      if (this.looksLikeToolResult(value)) {
        results.push({ field: key, value });
      }
      if (isRecord(value)) {
        for (const [subKey, subValue] of Object.entries(value)) {
          if (this.looksLikeToolResult(subValue)) {
            results.push({ field: `${key}.${subKey}`, value: subValue });
          }
        }
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (this.looksLikeToolResult(value[i])) {
            results.push({ field: `${key}[${i}]`, value: value[i] });
          }
        }
      }
    }
    return results;
  }

  private looksLikeToolResult(value: unknown): boolean {
    if (!isRecord(value)) return false;
    // Must have at least 3 of the required ToolResult fields
    const presentFields = TOOL_RESULT_REQUIRED_FIELDS.filter((f) => f in value);
    return presentFields.length >= 3;
  }

  private checkBase64Blobs(
    serialized: string,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    // Skip artifact refs which are legitimate base64-like strings
    const withoutArtifactRefs = serialized.replace(/artifact:\/\/[0-9a-f]{64}/g, "");
    const match = BASE64_BLOB_RE.exec(withoutArtifactRefs);
    if (match) {
      violations.push({
        type: "raw_binary_or_base64_blob",
        offendingField: "payload",
        payloadSize,
        agentId: this.config.agentId,
        message:
          `Payload contains a raw base64 blob (${match[1]?.length ?? 0} chars). ` +
          `Store binary data as an artifact and include only the artifact ref.`,
      });
    }
  }

  private checkDynamicContent(
    serialized: string,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    const { above } = splitAtCacheBreakpoint(serialized);
    if (!above) return;

    for (const pattern of DYNAMIC_PATTERNS) {
      if (pattern.regex.test(above)) {
        // Reset lastIndex for global patterns
        if ("lastIndex" in pattern.regex) {
          (pattern.regex as RegExp).lastIndex = 0;
        }
        violations.push({
          type: "dynamic_content_above_cache_breakpoint",
          offendingField: `content_above_breakpoint:${pattern.name}`,
          payloadSize,
          agentId: this.config.agentId,
          message:
            `Dynamic content "${pattern.name}" detected above the cache breakpoint marker. ` +
            `Move dynamic fields (timestamps, UUIDs, session IDs, ticket numbers, paths) ` +
            `below <!-- CACHE_BREAKPOINT --> to preserve prompt caching.`,
        });
        // Report one violation per check pass (first match wins)
        return;
      }
    }
  }

  private checkToolResultSchemaFields(
    payload: unknown,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    const toolResults = this.extractToolResults(payload);
    for (const { field, value } of toolResults) {
      if (!isRecord(value)) continue;
      const missing = TOOL_RESULT_REQUIRED_FIELDS.filter((f) => !(f in value));
      if (missing.length > 0) {
        violations.push({
          type: "missing_required_schema_fields",
          offendingField: field,
          payloadSize,
          agentId: this.config.agentId,
          message:
            `Tool result in "${field}" is missing required fields: ${missing.join(", ")}. ` +
            `All tool results must conform to the ToolResult schema.`,
        });
      }
    }
  }

  private checkOutputTokens(
    payload: unknown,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    if (!isRecord(payload)) return;
    const maxTokens = payload.max_tokens ?? payload.maxTokens ?? payload.max_output_tokens;
    if (typeof maxTokens !== "number") return;
    if (maxTokens > this.config.maxOutputTokens) {
      violations.push({
        type: "max_output_tokens_exceeded",
        offendingField: "max_tokens",
        payloadSize,
        agentId: this.config.agentId,
        message:
          `max_output_tokens=${maxTokens} exceeds the configured ceiling of ${this.config.maxOutputTokens}. ` +
          `Reduce max_output_tokens to fit within the run profile limit.`,
      });
    }
  }

  private checkContextWindowLimit(
    serialized: string,
    payloadSize: number,
    violations: GuardrailViolation[],
  ): void {
    const tokens = estimateTokens(serialized);
    const limit = Math.floor(this.config.contextWindowTokens * 0.9);
    if (tokens > limit) {
      violations.push({
        type: "context_window_limit",
        offendingField: "total_prompt",
        payloadSize,
        agentId: this.config.agentId,
        message:
          `Total prompt is ~${tokens} tokens, exceeding 90% of the ${this.config.contextWindowTokens}-token context window. ` +
          `Checkpoint immediately: summarize progress, clear context, resume with fresh session.`,
      });
    }
  }

  private buildErrorMessage(violations: GuardrailViolation[], forceCheckpoint: boolean): string {
    const lines = [`[guardrail] ${violations.length} violation(s) detected:`];
    for (const v of violations) {
      lines.push(`  • [${v.type}] ${v.message}`);
    }
    if (forceCheckpoint) {
      lines.push("\n[guardrail] Second violation in this turn — forced checkpoint triggered. Save state and start a new session.");
    } else {
      lines.push("\nFix the violation and retry. Second violation triggers a forced checkpoint.");
    }
    return lines.join("\n");
  }

  private logViolations(
    violations: GuardrailViolation[],
    sessionId: string,
    payloadSize: number,
  ): void {
    for (const v of violations) {
      const spanData = {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        toolName: `GUARDRAIL_VIOLATION:${v.type}`,
        inputTokenCount: 0,
        outputTokenCount: 0,
        rawOutputBytes: payloadSize,
        prunedOutputBytes: 0,
        executionDurationMs: 0,
        exitCode: 1,
        originatingTicketId: "",
        teamId: "",
        artifactRefs: [],
        status: "error" as const,
        sessionId,
      };
      emitToolSpan(spanData, this.config.langfuse);
      process.stderr.write(
        `[guardrail] VIOLATION type=${v.type} field=${v.offendingField} agent=${v.agentId}\n`,
      );
    }
  }
}

/** Convenience function — create and use a one-off policy instance. */
export function validatePayload(
  payload: unknown,
  sessionId: string,
  config?: Partial<GuardrailPolicyConfig>,
): GuardrailResult {
  return new GuardrailPolicy(config).validate(payload, sessionId);
}
