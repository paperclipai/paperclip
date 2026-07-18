#!/usr/bin/env node
/**
 * Paperclip MCP server entrypoint. Dispatches on argv:
 *   (no flag) / --stdio   env-scoped stdio transport (default; unchanged)
 *   --http [--port N]      bearer-token-scoped multi-tenant HTTP transport
 */
import { runFromArgv } from "@paperclipai/mcp-transport";
import { buildPaperclipRunner } from "./index.js";

void runFromArgv(buildPaperclipRunner()).catch((error) => {
  console.error("Failed to start Paperclip MCP server:", error);
  process.exit(1);
});
