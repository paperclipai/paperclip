import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCliPath } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { expect, it } from "vitest";
import { CLAUDE_TOOL_USE_META_KEY } from "./acpx/claude-tool-use-admission.js";
import { startRunnerToolBridge } from "./runner-tool-bridge.js";

type Block = { type: string; tool_use_id?: string };
type Message = { role: string; content: string | Block[] };

it("names each MCP tool call by the tool use the pinned Claude client received", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-tool-use-id-"));
  const config = join(root, "config"), cwd = join(root, "workspace");
  await Promise.all([mkdir(config), mkdir(cwd)]);
  const issued: string[] = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const body = JSON.parse(raw || "{}") as { messages?: Message[]; tools?: Array<{ name: string }> };
    const conversation = (body.messages ?? []).filter(message => message.role === "user" || message.role === "assistant");
    const last = conversation.at(-1)?.content;
    const answered = Array.isArray(last) && last.some(block => block.type === "tool_result");
    const offersProbe = (body.tools ?? []).some(tool => tool.name === "mcp__paperclip__probe");
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${issued.length}`, type: "message", role: "assistant",
      model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
    if (answered || !offersProbe) {
      frames.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local fixture complete." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      for (const index of [0, 1]) {
        const id = `toolu_01Fixture${issued.length + 1}`;
        issued.push(id);
        frames.push({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__paperclip__probe", input: {} } },
          { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ tag: id }) } },
          { type: "content_block_stop", index });
      }
      frames.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    frames.push({ type: "message_stop" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  const received: Array<string | undefined> = [];
  const bridge = await startRunnerToolBridge({
    tools: [{ name: "probe", description: "Local fixture probe.", inputSchema: { type: "object", properties: { tag: { type: "string" } } } }],
    preserveToolNames: true,
    providerToolUseIdMetaKey: CLAUDE_TOOL_USE_META_KEY,
    handler: async ({ providerToolUseId }) => {
      received.push(providerToolUseId);
      return { ok: true };
    },
  });
  try {
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    const address = api.address() as { port: number };
    const mcpConfig = { mcpServers: { paperclip: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${bridge.secret}` } } } };
    await promisify(execFile)(await claudeCliPath(), [
      "--bare", "--print", "--model", "claude-sonnet-5", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcpConfig),
      "--setting-sources", "", "--permission-mode", "dontAsk", "--allowedTools", "mcp__paperclip__probe",
      "--no-session-persistence", "--tools", "", "--max-turns", "2",
      "Call the probe tool, then report the result.",
    ], { cwd, timeout: 20_000, env: {
      PATH: process.env.PATH, TMPDIR: root, CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
    } });
    expect(issued).toHaveLength(2);
    expect(received).toHaveLength(issued.length);
    expect([...received].sort()).toEqual([...issued].sort());
  } finally {
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    await bridge.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30_000);
