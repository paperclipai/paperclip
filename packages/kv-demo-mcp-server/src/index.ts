import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KvStore } from "./store.js";
import { createToolDefinitions } from "./tools.js";

export interface CreateKvDemoMcpServerResult {
  server: McpServer;
  store: KvStore;
}

/**
 * Build an MCP server whose tools read and write the supplied {@link KvStore}.
 * Pass a shared store so the HTTP values UI observes the same state the tools
 * mutate.
 */
export function createKvDemoMcpServer(store: KvStore = new KvStore()): CreateKvDemoMcpServerResult {
  const server = new McpServer({
    name: "paperclip-kv-demo",
    version: "0.1.0",
  });

  for (const tool of createToolDefinitions(store)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape,
        annotations: tool.annotations,
      },
      tool.execute,
    );
  }

  return { server, store };
}

export { KvStore } from "./store.js";
export type { KvEntry, KvStateSnapshot } from "./store.js";
export { createToolDefinitions } from "./tools.js";
export { createKvDemoHttpServer } from "./http.js";
export type { KvDemoHttpServer, KvDemoHttpOptions } from "./http.js";
export { readConfigFromEnv } from "./config.js";
export type { KvDemoConfig } from "./config.js";
export { createTasksDemoHttpServer, handleTasksDemoRpc, PROTOCOL_VERSION as TASKS_DEMO_PROTOCOL_VERSION, TASKS_EXTENSION_ID } from "./tasks/http.js";
export type { TasksDemoHttpServer, TasksDemoHttpOptions } from "./tasks/http.js";
export { DemoTaskStore } from "./tasks/store.js";
export type { DemoTask, DemoTaskStatus, DemoState } from "./tasks/store.js";
