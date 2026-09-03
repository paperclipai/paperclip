import type {
  PluginActivityClient,
  PluginLogger,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";

/**
 * Wrap a tool handler so:
 *   - every success and every caught failure writes an activity log entry
 *   - the structured logger always sees an `info` (or `error`) line
 *   - thrown errors become `ToolResult { error }` instead of crashing the worker
 *
 * The shape `RefusalError` lets handlers throw a compliance-rule refusal that
 * carries a stable code, distinguishable from an upstream GitHub failure.
 */
export class RefusalError extends Error {
  readonly code: string;
  readonly reason: string;
  constructor(code: string, reason: string) {
    // The thrown message includes the code so log scrapers, test matchers,
    // and audit entries all surface the same stable identifier.
    super(`${code}: ${reason}`);
    this.name = "RefusalError";
    this.code = code;
    this.reason = reason;
  }
}

export interface AuditContext {
  activity: PluginActivityClient;
  logger: PluginLogger;
}

export interface HandlerEnv extends AuditContext {
  toolName: string;
}

export function wrapTool(
  ctx: AuditContext,
  toolName: string,
  fn: (params: unknown, runCtx: ToolRunContext, env: HandlerEnv) => Promise<ToolResult>,
): (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult> {
  return async (params, runCtx) => {
    const env: HandlerEnv = { ...ctx, toolName };
    try {
      const result = await fn(params, runCtx, env);
      if (result.error) {
        await safeLog(ctx, runCtx.companyId, `${toolName}: refused`, {
          toolName,
          agentId: runCtx.agentId,
          refusal: true,
          code: codeFromToolError(result.error),
        });
        ctx.logger.warn(`tool refused: ${toolName}`, { error: result.error });
      } else {
        await safeLog(ctx, runCtx.companyId, `${toolName}: ok`, {
          toolName,
          agentId: runCtx.agentId,
          ...(typeof result.data === "object" && result.data !== null
            ? { summary: pickSummaryFields(result.data as Record<string, unknown>) }
            : {}),
        });
      }
      return result;
    } catch (err: unknown) {
      // RefusalError already carries a `code: reason` message string; an
      // unhandled exception gets prefixed with `tool_unhandled_error:` so
      // the caller can distinguish a hard rule from an upstream failure.
      const isRefusal = err instanceof RefusalError;
      const code = isRefusal ? err.code : "tool_unhandled_error";
      const reason = isRefusal ? err.reason : err instanceof Error ? err.message : String(err);
      const errorString = isRefusal ? err.message : `tool_unhandled_error: ${reason}`;
      ctx.logger.error(`tool threw: ${toolName}`, { code, reason });
      await safeLog(ctx, runCtx.companyId, `${toolName}: error — ${code}`, {
        toolName,
        agentId: runCtx.agentId,
        code,
      });
      return { error: errorString };
    }
  };
}

function codeFromToolError(error: string): string {
  const separator = error.indexOf(":");
  const code = separator > 0 ? error.slice(0, separator).trim() : error.trim();
  return code || "tool_error";
}

async function safeLog(
  ctx: AuditContext,
  companyId: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  try {
    await ctx.activity.log({
      companyId,
      message,
      entityType: "github.tool",
      metadata,
    });
  } catch (err) {
    // Activity log failure must never break a tool call — but it must be
    // visible in the worker log so operators can fix the audit pipeline.
    ctx.logger.error("activity.log failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function pickSummaryFields(data: Record<string, unknown>): Record<string, unknown> {
  // Avoid dumping huge bodies into the audit log; keep only short scalar IDs.
  const out: Record<string, unknown> = {};
  for (const key of ["prNumber", "issueNumber", "headSha", "id", "state", "queuedAt", "conclusion"]) {
    const v = data[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}
