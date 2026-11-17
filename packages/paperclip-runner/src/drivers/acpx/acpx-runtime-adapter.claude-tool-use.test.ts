import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { startRunnerToolBridge } from "../runner-tool-bridge.js";
import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import { CLAUDE_TOOL_USE_META_KEY, ClaudeToolUseAdmission } from "./claude-tool-use-admission.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

type Block = { type: string; text?: string; tool_use_id?: string };
type Message = { role: string; content: string | Block[] };

const textOf = (content: string | Block[] | undefined): string => typeof content === "string" ? content
  : (content ?? []).map(block => block.text ?? "").join("\n");

it("admits each Claude tool call through the real ACP turn stream only for its own turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-tool-use-acp-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  const issued: string[][] = [];
  const answered: string[][] = [];
  const exportedLogs: string[] = [];
  let diagnosticResult = "";
  let providerPid: number | undefined;
  let releaseTurnTwo!: () => void;
  const turnTwoGate = new Promise<void>(resolve => { releaseTurnTwo = resolve; });
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url === "/v1/logs" || request.url === "/v1/traces") {
      if (request.url === "/v1/logs") exportedLogs.push(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
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
    const results = Array.isArray(last) ? last.filter(block => block.type === "tool_result").map(block => block.tool_use_id!) : [];
    const offersProbe = (body.tools ?? []).some(tool => tool.name === "mcp__paperclip__probe");
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${issued.length}_${answered.length}`, type: "message",
      role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
    const text = (value: string) => frames.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    if (results.length > 0) {
      if (results.includes("toolu_Diagnostics")) diagnosticResult = JSON.stringify(last);
      answered.push(results);
      text("Probe complete.");
    } else if (process.platform === "linux" && /TURN-DIAGNOSTICS/.test(textOf(last))) {
      frames.push(
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_Diagnostics", name: "Bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `ps -ww -o args= --ppid ${providerPid}`, description: "Inspect this fixture's CLI process." }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else if (offersProbe && /TURN-ONE/.test(textOf(last))) {
      const ids = [0, 1].map(index => `toolu_01Acp${issued.length + 1}${index}`);
      issued.push(ids);
      ids.forEach((id, index) => frames.push(
        { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__paperclip__probe", input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ tag: id }) } },
        { type: "content_block_stop", index }));
      frames.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      if (/TURN-TWO/.test(textOf(last))) await turnTwoGate;
      text("Nothing to call.");
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
  const dispatched: Array<{ callId: string; tag: unknown }> = [];
  const bridge = await startRunnerToolBridge({
    tools: [{ name: "probe", description: "Local fixture probe.", inputSchema: { type: "object", properties: { tag: { type: "string" } } } }],
    preserveToolNames: true,
    providerToolUseIdMetaKey: CLAUDE_TOOL_USE_META_KEY,
    timeoutMs: null,
    handler: async call => {
      const callId = await admission.admit(activeTurn, call.providerToolUseId, call.signal);
      dispatched.push({ callId, tag: (call.arguments as { tag?: unknown }).tag });
      return { ok: true };
    },
  });
  const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => {
      const child = spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      providerPid = child.pid;
      return child;
    },
    close: async () => undefined,
  };
  const options: AcpxRuntimePortOpenOptions = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-tool-use",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1", CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_LOGS_EXPORTER: "otlp", OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${address.port}/v1/logs`,
      OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1", OTEL_BLRP_SCHEDULE_DELAY: "50" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Use Paperclip tools.",
    mcpServers: [{ name: "paperclip", url: bridge.url, bearerToken: bridge.secret, runnerOwned: true }],
    retainFailedAdmissionCleanup: vi.fn(),
  } as AcpxRuntimePortOpenOptions;
  const runTurn = async (turnId: string, text: string, during?: () => Promise<void>) => {
    activeTurn = turnId;
    admission.beginTurn(turnId);
    const turn = port!.startTurn({ text, requestId: turnId, onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    const pumped = (async () => {
      for await (const event of turn.events) {
        admission.observe(turnId, event);
      }
    })();
    await during?.();
    await pumped;
    const result = await turn.result;
    admission.endTurn(turnId);
    return result;
  };
  const replay = (id: number, toolUseId: string, tag: string) => fetch(bridge.url, { method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "probe", arguments: { tag }, _meta: { [CLAUDE_TOOL_USE_META_KEY]: toolUseId } } }) })
    .then(response => response.json() as Promise<{ result: { isError?: boolean; content: Array<{ text: string }> } }>);
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  try {
    const unauthorized = await fetch(bridge.url, { method: "POST",
      headers: { Authorization: "Bearer wrong-fixture-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 899, method: "tools/list", params: {} }) });
    expect(unauthorized.status).toBe(401);
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
    });
    expect(await runTurn("turn-1", "TURN-ONE: call the probe tool twice.")).toMatchObject({ status: "completed" });
    expect(issued).toHaveLength(1);
    const [first, second] = issued[0]!;
    expect(dispatched.map(call => call.callId).sort()).toEqual([`tool-use:${first}`, `tool-use:${second}`].sort());
    expect(dispatched.map(call => call.tag).sort()).toEqual([first, second].sort());
    expect(answered.flat().sort()).toEqual([first, second].sort());

    if (process.platform === "linux") {
      // Inspect only this fixture's CLI child, never unrelated process credentials.
      const { stdout } = await promisify(execFile)("ps", ["-ww", "-o", "args=", "--ppid", String(providerPid)]);
      expect(stdout).toContain("--mcp-config");
      expect(stdout.includes(bridge.secret)).toBe(false);
    }

    const turnTwo = await runTurn("turn-2", "TURN-TWO: do not call tools.", async () => {
      const sameArguments = await replay(900, first!, first!);
      expect(sameArguments.result.isError).not.toBe(true);
      const changedArguments = await replay(901, first!, "replayed");
      expect(changedArguments.result).toMatchObject({ isError: true, content: [{ text: "Duplicate call identity conflict." }] });
      await expect(admission.admit("turn-2", first, new AbortController().signal)).rejects.toThrow("reused a provider tool-use identity");
      releaseTurnTwo();
    });
    expect(turnTwo).toMatchObject({ status: "completed" });
    expect(dispatched).toHaveLength(2);
    if (process.platform === "linux") {
      expect(await runTurn("turn-3", "TURN-DIAGNOSTICS: inspect this fixture's CLI process.")).toMatchObject({ status: "completed" });
      expect(diagnosticResult).toContain("--mcp-config");
      expect(diagnosticResult.includes(bridge.secret)).toBe(false);
      await port.close({ reason: "flush diagnostic telemetry" });
      port = undefined;
      // Read the CLI's own persisted transcript independently of the ACP stream.
      const transcripts = (await readdir(config, { recursive: true })).filter(path => path.endsWith(".jsonl"));
      const retained = (await Promise.all(transcripts.map(path => readFile(join(config, path), "utf8")))).join("\n");
      expect(retained.includes("toolu_Diagnostics")).toBe(true);
      expect(retained.includes("--mcp-config")).toBe(true);
      expect(retained.includes(bridge.secret)).toBe(false);
      // This CLI version exports tool-result metadata, but omits raw output.
      // Do not mistake absent output for a passing output-redaction check.
      const telemetry = exportedLogs.join("\n");
      expect(telemetry.includes("claude_code.tool_result")).toBe(true);
      expect(telemetry.includes("toolu_Diagnostics")).toBe(true);
      expect(telemetry.includes(bridge.secret)).toBe(false);
    }
  } finally {
    releaseTurnTwo();
    try { await port?.close({ reason: "tool-use admission verified" }); }
    finally {
      await bridge.close();
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 60_000);
