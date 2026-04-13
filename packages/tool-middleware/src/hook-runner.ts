/**
 * Hook runner — main entry point for Claude Code PreToolUse and PostToolUse hooks.
 *
 * Reads the hook event payload from stdin, processes it, and writes output to stdout.
 * Always exits 0 except for PreToolUse input validation rejections (exits 1 to block).
 *
 * Environment variables for configuration (see types.ts → resolveConfig):
 *   TOOL_MIDDLEWARE_ARTIFACTS_DIR   - artifact storage directory
 *   TOOL_MIDDLEWARE_CACHE_DIR       - cache directory
 *   LANGFUSE_BASE_URL               - Langfuse endpoint (empty = disabled)
 *   LANGFUSE_PUBLIC_KEY             - Langfuse public key
 *   LANGFUSE_SECRET_KEY             - Langfuse secret key
 *   TOOL_MIDDLEWARE_MAX_INPUT_BYTES - input ceiling (default 10,000)
 *   TOOL_MIDDLEWARE_MAX_OUTPUT_BYTES - output ceiling (default 1,500)
 *   PAPERCLIP_TASK_ID               - ticket id for telemetry
 *   PAPERCLIP_COMPANY_ID            - team id for telemetry
 */

import { validateToolInput, buildBlockResponse } from "./input-validator.js";
import { pruneToolOutput, formatSummaryForContext } from "./output-pruner.js";
import { buildCacheKey, readCache, writeCache, resolveTtlMs } from "./result-cache.js";
import { emitToolSpan, logToStderr, generateTraceId, generateSpanId } from "./langfuse-exporter.js";
import type { HookEvent, PreToolUseEvent, PostToolUseEvent } from "./types.js";
import { resolveConfig } from "./types.js";

function extractCommand(event: PreToolUseEvent | PostToolUseEvent): string {
  const input = event.tool_input;
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

async function handlePreToolUse(event: PreToolUseEvent): Promise<{ exitCode: number; stdout: string }> {
  const config = resolveConfig();

  // Input size validation
  const validation = validateToolInput(event.tool_name, event.tool_input, config.maxInputBytes);
  if (!validation.valid) {
    const response = buildBlockResponse(validation.errorMessage ?? "Input too large");
    return { exitCode: 2, stdout: response };
  }

  // Dedup cache check for Bash tools
  if (event.tool_name === "Bash" || event.tool_name === "bash") {
    const command = extractCommand(event);
    if (command) {
      const cacheKey = await buildCacheKey(command, process.cwd());
      const cached = await readCache(cacheKey, config.cacheDir);
      if (cached) {
        // Return cached result by blocking the tool and returning cached summary
        const cachedSummary = { ...cached, cache_hit: true };
        const response = JSON.stringify({
          decision: "block",
          reason: `[tool-middleware/cache-hit] Result served from cache (TTL not expired).\n${formatSummaryForContext(cachedSummary)}`,
        });
        return { exitCode: 2, stdout: response };
      }
    }
  }

  return { exitCode: 0, stdout: "" };
}

async function handlePostToolUse(event: PostToolUseEvent): Promise<{ exitCode: number; stdout: string }> {
  const config = resolveConfig();
  const startTime = Date.now();
  const traceId = generateTraceId();
  const spanId = generateSpanId();

  try {
    const { summary, stdoutRef } = await pruneToolOutput(
      event.tool_name,
      event.tool_input,
      event.tool_response,
      0, // duration not known at hook level — filled from metadata if available
      config,
    );

    const durationMs = Date.now() - startTime;
    summary.duration_ms = durationMs;

    // Write to dedup cache for Bash tools
    if (event.tool_name === "Bash" || event.tool_name === "bash") {
      const command = extractCommand(event);
      if (command) {
        const cacheKey = await buildCacheKey(command, process.cwd());
        const ttlMs = resolveTtlMs(command);
        await writeCache(cacheKey, summary, ttlMs, config.cacheDir).catch(() => {
          // Cache write failure is non-fatal
        });
      }
    }

    // Emit telemetry span
    const langfuseConfig = {
      baseUrl: config.langfuseBaseUrl,
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
    };

    const spanData = {
      traceId,
      spanId,
      toolName: event.tool_name,
      inputTokenCount: 0,
      outputTokenCount: 0,
      rawOutputBytes: stdoutRef.bytes,
      prunedOutputBytes: Buffer.byteLength(JSON.stringify(summary), "utf8"),
      executionDurationMs: durationMs,
      exitCode: summary.exit_code,
      originatingTicketId: config.ticketId,
      teamId: config.teamId,
      artifactRefs: [stdoutRef.uri],
      status: summary.status,
      sessionId: event.session_id ?? "",
    };

    emitToolSpan(spanData, langfuseConfig);
    logToStderr(spanData);

    // Output the pruned summary for Claude Code to inject into context
    const contextOutput = formatSummaryForContext(summary);
    return { exitCode: 0, stdout: contextOutput };
  } catch (err) {
    // Never crash the hook — log and return empty stdout to use original output
    process.stderr.write(`[tool-middleware] PostToolUse error: ${String(err)}\n`);
    return { exitCode: 0, stdout: "" };
  }
}

/** Main entry point — reads stdin, dispatches to handler, writes stdout. */
export async function runHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk as string;
  }

  let event: HookEvent;
  try {
    event = JSON.parse(raw) as HookEvent;
  } catch {
    // Invalid JSON input — exit cleanly (don't block Claude)
    process.exit(0);
  }

  const hookType = event.hook_event_type;
  let result: { exitCode: number; stdout: string };

  try {
    if (hookType === "PreToolUse") {
      result = await handlePreToolUse(event as PreToolUseEvent);
    } else if (hookType === "PostToolUse") {
      result = await handlePostToolUse(event as PostToolUseEvent);
    } else {
      // Unknown hook type — pass through
      result = { exitCode: 0, stdout: "" };
    }
  } catch (err) {
    process.stderr.write(`[tool-middleware] Unhandled error: ${String(err)}\n`);
    result = { exitCode: 0, stdout: "" };
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  process.exit(result.exitCode);
}
