#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createTasksDemoHttpServer } from "./http.js";
import { DemoTaskStore } from "./store.js";

function port(raw: string | undefined): number {
  if (!raw) return 8849;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid port: ${raw}`);
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  // State lives in a file by default so the server can be stopped and started mid-task.
  const stateFile = env.TASKS_DEMO_STATE_FILE === "memory" ? null : env.TASKS_DEMO_STATE_FILE || join(homedir(), ".paperclip-tasks-demo", "state.json");
  const host = env.TASKS_DEMO_HOST?.trim() || "127.0.0.1";
  const token = env.TASKS_DEMO_TOKEN?.trim() || null;
  const { listen } = createTasksDemoHttpServer({ store: new DemoTaskStore({ file: stateFile }), token });
  const bound = await listen(port(env.PORT ?? env.TASKS_DEMO_PORT), host);
  const base = `http://${host}:${bound}`;
  console.error(`MCP Tasks demo server listening on ${base}`);
  console.error(`  MCP endpoint:  ${base}/mcp`);
  console.error(`  Status page:   ${base}/`);
  console.error(`  JSON state:    ${base}/api/state`);
  console.error(`  Task state:    ${stateFile ?? "in memory (lost on restart)"}`);
  console.error(`  Auth:          ${token ? "TASKS_DEMO_TOKEN required (Bearer header)" : "none (set TASKS_DEMO_TOKEN to require one)"}`);
}

void main().catch((error) => {
  console.error("Failed to start the MCP Tasks demo server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
