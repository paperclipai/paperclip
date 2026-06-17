#!/usr/bin/env node
import { readHttpConfigFromEnv } from "./config.js";
import { createGoogleSheetsMcpHttpServer } from "./http.js";

async function main(): Promise<void> {
  const config = readHttpConfigFromEnv();
  const { listen } = createGoogleSheetsMcpHttpServer({
    config: config.mcpConfig,
    token: config.token,
  });
  const port = await listen(config.port, config.host);
  const base = `http://${config.host}:${port}`;

  console.error(`Google Sheets MCP HTTP server listening on ${base}`);
  console.error(`  MCP endpoint: ${base}/mcp`);
  if (config.token) {
    console.error("  Auth:         GOOGLE_SHEETS_MCP_TOKEN required (Bearer header or ?token= query).");
  } else {
    console.error("  Auth:         none (loopback/local testing mode).");
  }
}

void main().catch((error) => {
  console.error("Failed to start Google Sheets MCP HTTP server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
