import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpRuntimeEvent } from "acpx/runtime";
import { expect, it, vi } from "vitest";

import { startRunnerToolBridge } from "../runner-tool-bridge.js";
import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import { CLAUDE_TOOL_USE_META_KEY, ClaudeToolUseAdmission } from "./claude-tool-use-admission.js";
import type { ClaudeProviderTurnResult } from "./claude-provider-turns.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

type Block = { type: string; text?: string; tool_use_id?: string };
type Message = { role: string; content: string | Block[] };

const textOf = (content: string | Block[] | undefined): string => typeof content === "string" ? content
  : (content ?? []).map(block => block.text ?? "").join("\n");

it("adopts Claude's own task-notification cycle as a provider-started turn through the real ACP stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-provider-turn-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  let sequence = 0;
  let cycleToolUseId = "";
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
    const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean; messages?: Message[]; tools?: Array<{ name: string }> };
    const model = body.model ?? "claude-sonnet-5";
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    const conversation = (body.messages ?? []).filter(message => message.role === "user" || message.role === "assistant");
    const last = conversation.at(-1)?.content;
    const results = Array.isArray(last) ? last.filter(block => block.type === "tool_result") : [];
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${++sequence}`, type: "message",
      role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }];
    const text = (value: string) => frames.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    const tool = (id: string, name: string, input: Record<string, unknown>) => frames.push(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } });
    if (results.length > 0) {
      text("Done.");
    } else if (/<task-notification>/.test(textOf(last))) {
      cycleToolUseId = `toolu_01Cycle${sequence}`;
      tool(cycleToolUseId, "mcp__paperclip__probe", { tag: "finished" });
    } else if (/BACKGROUND-TURN/.test(textOf(last))) {
      tool(`toolu_01Background${sequence}`, "Bash", { command: "sleep 3; echo background-done", description: "background sleep", run_in_background: true });
    } else {
      text("Nothing to run.");
    }
    frames.push({ type: "message_stop" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address() as { port: number };

  const admission = new ClaudeToolUseAdmission();
  let activeTurn = "";
  const dispatched: Array<{ turn: string; callId: string; tag: unknown }> = [];
  const bridge = await startRunnerToolBridge({
    tools: [{ name: "probe", description: "Local stand-in for paperclip_finish.", inputSchema: { type: "object", properties: { tag: { type: "string" } } } }],
    preserveToolNames: true,
    providerToolUseIdMetaKey: CLAUDE_TOOL_USE_META_KEY,
    timeoutMs: null,
    handler: async call => {
      const turn = activeTurn;
      const callId = await admission.admit(turn, call.providerToolUseId, call.signal);
      dispatched.push({ turn, callId, tag: (call.arguments as { tag?: unknown }).tag });
      return { ok: true };
    },
  });
  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
    close: async () => undefined,
  };
  const options: AcpxRuntimePortOpenOptions = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-provider-turn",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Use Paperclip tools.",
    mcpServers: [{ name: "paperclip", url: bridge.url, bearerToken: bridge.secret, runnerOwned: true }],
    retainFailedAdmissionCleanup: vi.fn(),
  } as AcpxRuntimePortOpenOptions;
  const adopted: Array<{ requestId: string; events: AcpRuntimeEvent[]; result: Promise<ClaudeProviderTurnResult> }> = [];
  const replay = (id: number, toolUseId: string, tag: string) => fetch(bridge.url, { method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "probe", arguments: { tag }, _meta: { [CLAUDE_TOOL_USE_META_KEY]: toolUseId } } }) })
    .then(response => response.json() as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>);
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  try {
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
    });
    const cycles = port.providerCycles!()!;
    void (async () => {
      for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
        if (item.type !== "started") continue;
        const requestId = item.requestId;
        activeTurn = requestId;
        admission.beginTurn(requestId);
        cycles.adopt({ onPermissionRequest: async () => ({ outcome: "allow_once" }), busy: () => false });
        const events: AcpRuntimeEvent[] = [];
        let settle!: (result: ClaudeProviderTurnResult) => void;
        adopted.push({ requestId, events, result: new Promise((resolve) => { settle = resolve; }) });
        let next = await cycles.next();
        for (; next?.type === "event"; next = await cycles.next()) {
          events.push(next.event);
          admission.observe(requestId, next.event);
        }
        admission.endTurn(requestId);
        settle(next?.type === "ended" ? next.result : { status: "failed", error: { code: "closed", message: "closed", retryable: false } });
      }
    })();
    activeTurn = "turn-1";
    admission.beginTurn("turn-1");
    const turn = port.startTurn({ text: "BACKGROUND-TURN: start the command in the background.", requestId: "turn-1",
      onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    for await (const event of turn.events) admission.observe("turn-1", event);
    expect(await turn.result).toMatchObject({ status: "completed" });
    admission.endTurn("turn-1");
    expect(port.backgroundTaskState?.()).toEqual({ live: 1 });

    await vi.waitFor(() => expect(adopted).toHaveLength(1), { timeout: 20_000, interval: 50 });
    const [cycle] = adopted;
    const result = await cycle!.result;
    expect(cycle!.requestId).toMatch(/^provider-/);
    expect(result).toMatchObject({ status: "completed", stopReason: "end_turn",
      usage: { tag: "usage_update", text: "terminal prompt usage", breakdown: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) } } });
    expect(cycle!.events.some(event => event.type === "tool_call" && event.toolCallId === cycleToolUseId)).toBe(true);
    expect(dispatched).toEqual([{ turn: cycle!.requestId, callId: `tool-use:${cycleToolUseId}`, tag: "finished" }]);
    expect(port.backgroundTaskState?.()).toBeNull();

    const conflicting = await replay(901, cycleToolUseId, "replayed");
    expect(conflicting.result.isError).toBe(true);
    await expect(admission.admit(cycle!.requestId, cycleToolUseId, new AbortController().signal))
      .rejects.toThrow("not bound to the active turn");
    expect(dispatched).toHaveLength(1);
  } finally {
    try { await port?.close({ reason: "provider-started turn verified" }); }
    finally {
      await bridge.close();
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 60_000);
