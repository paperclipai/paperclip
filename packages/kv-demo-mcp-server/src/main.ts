#!/usr/bin/env node
import { readConfigFromEnv } from "./config.js";
import { createKvDemoHttpServer } from "./http.js";

async function main(): Promise<void> {
  const config = readConfigFromEnv();
  const { listen } = createKvDemoHttpServer({ token: config.token });
  const port = await listen(config.port, config.host);

  const base = `http://${config.host}:${port}`;
  console.error(`KV demo MCP server listening on ${base}`);
  console.error(`  MCP endpoint:  ${base}/mcp`);
  console.error(`  Values UI:     ${base}/`);
  console.error(`  JSON state:    ${base}/api/state`);
  if (config.token) {
    console.error("  Auth:          KV_DEMO_TOKEN required (Bearer header or ?token= query).");
  } else {
    console.error("  Auth:          none (set KV_DEMO_TOKEN to require a shared secret).");
  }
}

void main().catch((error) => {
  console.error("Failed to start KV demo MCP server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
