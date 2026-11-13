import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpRuntimeEvent } from "acpx/runtime";
import { expect, it, vi } from "vitest";

import { ACP_SESSION_UPDATE_EVENT_KINDS, createAcpSessionUpdateEventConverter } from "./acp-session-update-event.js";
import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown };
type Message = { role: string; content: string | Block[] };
type Raw = { message: Record<string, unknown>; afterPromptResponse: boolean };

const textOf = (content: string | Block[] | undefined): string => typeof content === "string" ? content
  : (content ?? []).map(block => block.text ?? "").join("\n");

it("converts the real Claude ACP stream exactly as ACPX does for every update kind it emits", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-session-update-events-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  await writeFile(join(cwd, "README.md"), "fixture\n");
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
    const names = new Set((body.tools ?? []).map(tool => tool.name));
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${++sequence}`, type: "message",
      role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
    let index = 0;
    const thinking = (value: string) => frames.push(
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: value } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "fixture-signature" } },
      { type: "content_block_stop", index: index++ });
    const text = (value: string) => frames.push(
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: index++ });
    const tool = (name: string, input: Record<string, unknown>) => frames.push(
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_01Kinds${sequence}${index}`, name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: index++ });
    const prompt = textOf(last);
    if (results.length > 0) {
      text("Step complete.");
    } else if (/KINDS-MCP/.test(prompt) && names.has("mcp__paperclip__probe")) {
      thinking("I should call the probe.");
      text("Calling the probe.");
      tool("mcp__paperclip__probe", { tag: "kinds" });
    } else if (/KINDS-FOREGROUND/.test(prompt)) {
      tool("Bash", { command: "echo foreground-kinds", description: "foreground echo" });
    } else if (/KINDS-BACKGROUND/.test(prompt)) {
      tool("Bash", { command: "sleep 1; echo background-kinds", description: "background sleep", run_in_background: true });
    } else if (/KINDS-PLAN/.test(prompt) && names.has("TodoWrite")) {
      tool("TodoWrite", { todos: [{ content: "First step", status: "in_progress", activeForm: "Doing the first step" }, { content: "Second step", status: "pending", activeForm: "Doing the second step" }] });
    } else {
      text("Nothing to run.");
    }
    const usesTool = frames.some(frame => (frame as { content_block?: { type?: string } }).content_block?.type === "tool_use");
    frames.push({ type: "message_delta", delta: { stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  const mcp = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 200 : 405); response.end(); return; }
    const message = JSON.parse(raw || "{}") as { id?: number; method?: string; params?: { protocolVersion?: string } };
    const reply = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "kinds" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kinds", version: "1" } });
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    if (message.method === "tools/list") return reply({ tools: [{ name: "probe", description: "Fixture probe.", inputSchema: { type: "object", properties: { tag: { type: "string" } } } }] });
    if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "probe output" }] });
    reply({});
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => mcp.listen(0, "127.0.0.1", resolve));
  const apiPort = (api.address() as { port: number }).port;
  const mcpPort = (mcp.address() as { port: number }).port;
  let capture: Raw[] | null = null;
  let promptAnswered = false;
  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => {
      const child = spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcess;
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (message.method === undefined && (message.result as { stopReason?: unknown } | undefined)?.stopReason !== undefined) promptAnswered = true;
          if (message.method === "session/update") capture?.push({ message, afterPromptResponse: promptAnswered });
        }
      });
      return child;
    },
    close: async () => undefined,
  };
  const options = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-session-update-events",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Follow the fixture.",
    mcpServers: [{ name: "paperclip", url: `http://127.0.0.1:${mcpPort}/mcp`, bearerToken: "fixture", runnerOwned: false }],
    retainFailedAdmissionCleanup: vi.fn(),
  } as unknown as AcpxRuntimePortOpenOptions;
  const converter = createAcpSessionUpdateEventConverter();
  const seen = new Map<string, { acpx: number; paperclip: number }>();
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  const runTurn = async (turnId: string, text: string) => {
    capture = [];
    promptAnswered = false;
    const yielded: AcpRuntimeEvent[] = [];
    const turn = port!.startTurn({ text, requestId: turnId, onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    for await (const event of turn.events) yielded.push(event);
    expect(await turn.result).toMatchObject({ status: "completed" });
    const raw = capture as Raw[];
    capture = null;
    const converted: Array<{ event: AcpRuntimeEvent | null; raw: Raw }> = [];
    for (const message of raw) converted.push({ event: await converter.convert(message.message), raw: message });
    const produced = converted.filter(entry => entry.event !== null);
    expect(produced.map(entry => entry.event).slice(0, yielded.length)).toEqual(yielded);
    expect(produced.slice(yielded.length).every(entry => entry.raw.afterPromptResponse)).toBe(true);
    for (const [index, entry] of converted.entries()) {
      const kind = String((entry.raw.message.params as { update: { sessionUpdate: unknown } }).update.sessionUpdate);
      const counts = seen.get(kind) ?? { acpx: 0, paperclip: 0 };
      const producedIndex = produced.indexOf(entry);
      if (entry.event !== null) counts.paperclip += 1;
      if (producedIndex >= 0 && producedIndex < yielded.length) counts.acpx += 1;
      seen.set(kind, counts);
      void index;
    }
    return yielded;
  };
  try {
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
    });
    await runTurn("turn-mcp", "KINDS-MCP: think, say something and call the probe.");
    await runTurn("turn-foreground", "KINDS-FOREGROUND: run a foreground command.");
    await runTurn("turn-background", "KINDS-BACKGROUND: run a background command.");
    await runTurn("turn-plan", "KINDS-PLAN: write a plan.");
    for (const required of ["tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk", "usage_update", "available_commands_update"]) {
      expect(seen.get(required)?.acpx ?? 0, required).toBeGreaterThan(0);
    }
    for (const [kind, counts] of seen) {
      if ((ACP_SESSION_UPDATE_EVENT_KINDS as readonly string[]).includes(kind)) {
        expect(counts.paperclip, kind).toBeGreaterThan(0);
      } else {
        expect(counts, kind).toEqual({ acpx: 0, paperclip: 0 });
      }
    }
    if (process.env.PAPERCLIP_PRINT_SESSION_UPDATE_KINDS) console.log(JSON.stringify(Object.fromEntries(seen)));
  } finally {
    converter.close();
    try { await port?.close({ reason: "session update conversion verified" }); }
    finally {
      api.closeAllConnections();
      mcp.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await new Promise<void>(resolve => mcp.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 90_000);
