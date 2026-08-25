#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBlindJudgePaperclipMcpServer } from "./blind-judge.js";

const server = createBlindJudgePaperclipMcpServer();
const transport = new StdioServerTransport();

void server.connect(transport).catch((error) => {
  console.error("Failed to start scoped Paperclip blind-judge MCP server:", error);
  process.exit(1);
});
