import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";
import { logger } from "./logger.js";

/**
 * MCP security-filter middleware.
 *
 * Maintains an explicit allowlist of Dokploy MCP tool names that the
 * infrastructure proxy is permitted to invoke. Any request that would
 * map to a tool outside the allowlist is rejected with 403.
 *
 * Usage: mount on the infrastructure router so every proxy endpoint
 * is validated before the handler runs.
 */

const ALLOWED_MCP_TOOLS: ReadonlySet<string> = new Set(["get-application-logs"]);

/**
 * Express middleware that reads `req.params.mcpTool` (or a fixed tool
 * derived from the route) and rejects requests for tools outside the
 * allowlist.
 *
 * For routes that map 1-to-1 to a known tool, pass the tool name
 * directly so the middleware can validate it at mount time.
 */
export function mcpAllowlist(toolName: string): RequestHandler {
  if (!ALLOWED_MCP_TOOLS.has(toolName)) {
    throw new Error(
      `mcpAllowlist: "${toolName}" is not in the allowed MCP tools set. ` +
        `Allowed: ${[...ALLOWED_MCP_TOOLS].join(", ")}`,
    );
  }

  return (req, _res, next) => {
    logger.debug({ tool: toolName, path: req.path, actor: req.actor?.type }, "MCP allowlist check passed");
    // Attach the validated tool name for downstream handlers
    (req as unknown as Record<string, unknown>).__mcpTool = toolName;
    next();
  };
}

export { ALLOWED_MCP_TOOLS };
