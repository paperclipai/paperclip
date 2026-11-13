import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";
import { persistedAcpxTurnUsage } from "./usage-accounting.js";

type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown };
type Message = { role: string; content: string | Block[] };

const textOf = (content: string | Block[] | undefined): string => typeof content === "string" ? content
  : (content ?? []).map(block => block.text ?? "").join("\n");

it("knows from the real Claude ACP stream when a turn leaves background work running", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-background-tasks-acp-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  const toolResults: string[] = [];
  let notified = 0;
  let sequence = 0;
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
    const offersBash = (body.tools ?? []).some(tool => tool.name === "Bash");
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${++sequence}`, type: "message",
      role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
    const text = (value: string) => frames.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    const bash = (input: Record<string, unknown>) => frames.push(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_01Background${sequence}`, name: "Bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } });
    if (results.length > 0) {
      toolResults.push(...results.map(block => JSON.stringify(block.content)));
      text("Done.");
    } else if (/<task-notification>/.test(textOf(last))) {
      notified += 1;
      text("The background command finished.");
    } else if (offersBash && /FOREGROUND-TURN/.test(textOf(last))) {
      bash({ command: "echo foreground-done", description: "foreground echo" });
    } else if (offersBash && /BACKGROUND-TURN/.test(textOf(last))) {
      bash({ command: "sleep 2; echo background-done", description: "background sleep", run_in_background: true });
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
  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  let spawned = 0;
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => {
      spawned += 1;
      return spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    },
    close: async () => undefined,
  };
  const options: AcpxRuntimePortOpenOptions = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-background-tasks",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Run the requested command.",
    mcpServers: [],
    retainFailedAdmissionCleanup: vi.fn(),
  } as AcpxRuntimePortOpenOptions;
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  const runTurn = async (turnId: string, text: string) => {
    const before = await port!.getStatus();
    const turn = port!.startTurn({ text, requestId: turnId, onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    for await (const _event of turn.events) void _event;
    const result = await turn.result;
    const state = port!.backgroundTaskState?.() ?? null;
    const usage = persistedAcpxTurnUsage(before, await port!.getStatus(), turnId, "claude");
    return { result, state, usage };
  };
  try {
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
    });
    const foreground = await runTurn("turn-foreground", "FOREGROUND-TURN: run the foreground command.");
    expect(foreground.result).toMatchObject({ status: "completed" });
    expect(toolResults.join("\n")).toContain("foreground-done");
    expect(foreground.state).toEqual({ live: 0 });
    expect(foreground.usage).toMatchObject({ tag: "usage_update", breakdown: { inputTokens: expect.any(Number) } });

    const background = await runTurn("turn-background", "BACKGROUND-TURN: start the command in the background.");
    expect(background.result).toMatchObject({ status: "completed" });
    expect(toolResults.join("\n")).toContain("Command running in background with ID:");
    expect(background.state).toEqual({ live: 1 });
    expect(background.usage).toMatchObject({ tag: "usage_update", breakdown: { inputTokens: expect.any(Number) } });
    expect(spawned).toBe(1);

    await vi.waitFor(() => expect(notified).toBe(1), { timeout: 20_000, interval: 50 });
    expect(port.backgroundTaskState?.()).toBeNull();
  } finally {
    try { await port?.close({ reason: "background task tracking verified" }); }
    finally {
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 60_000);
