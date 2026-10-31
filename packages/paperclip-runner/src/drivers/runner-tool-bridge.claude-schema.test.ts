import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCliPath } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { expect, it } from "vitest";
import { requestHumanInputAction } from "../protocol-actions/request-human-input.js";
import { startRunnerToolBridge } from "./runner-tool-bridge.js";

it("keeps the human-input tool available in the pinned Claude client", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-question-schema-"));
  const config = join(root, "config"), cwd = join(root, "workspace");
  await Promise.all([mkdir(config), mkdir(cwd)]);
  const offered: Array<Array<{ name: string; input_schema: Record<string, unknown> }>> = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (Array.isArray(body.tools)) offered.push(body.tools);
    response.writeHead(200, { "content-type": "text/event-stream" });
    // The real client reaches only this local API, which never asks it to run tools.
    const frames = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local fixture complete." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  const bridge = await startRunnerToolBridge({ tools: [
    { name: "request_human_input", description: "Ask a durable question.", inputSchema: requestHumanInputAction.live.descriptor.inputSchema },
    { name: "write_document", description: "Discovery control.", inputSchema: { type: "object", properties: { key: { type: "string" } } } },
  ], handler: async () => { throw new Error("This fixture must not execute tools"); } });
  try {
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    const address = api.address() as { port: number };
    const mcpConfig = { mcpServers: { paperclip: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${bridge.secret}` } } } };
    await promisify(execFile)(await claudeCliPath(), [
      "--bare", "--print", "--model", "claude-sonnet-5", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcpConfig),
      "--setting-sources", "", "--permission-mode", "dontAsk", "--no-session-persistence", "--tools", "", "--max-turns", "1",
      "Report this local fixture's result. Do not call tools.",
    ], { cwd, timeout: 20_000, env: {
      PATH: process.env.PATH, TMPDIR: root, CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
    } });
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.at(-1)?.map(tool => tool.name)).toContain("mcp__paperclip__write_document");
    const question = offered.at(-1)?.find(tool => tool.name === "mcp__paperclip__request_human_input");
    expect(question).toBeDefined();
    expect(question!.input_schema).toMatchObject({ type: "object", properties: {
      idempotencyKey: { type: "string" }, interactionKind: { enum: expect.arrayContaining(["questions", "confirmation"]) },
      title: { type: "string" }, prompt: { type: "string" }, payload: { type: "object" },
    }, required: expect.arrayContaining(["idempotencyKey", "interactionKind", "title", "prompt", "continuationPolicy"]) });
  } finally {
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    await bridge.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30_000);
