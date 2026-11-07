#!/usr/bin/env node
import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error("Failed to start Gmail MCP server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
