import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpRuntime } from "acpx/runtime";
import { expect, it, vi } from "vitest";

import { openCodexAcpxRuntime } from "./acpx-runtime-adapter.js";
import type { ClaudeBackgroundTaskState } from "./claude-background-tasks.js";
import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

type Block = { type: string; text?: string };
type Message = { role: string; content: string | Block[] };

const textOf = (content: string | Block[] | undefined): string => typeof content === "string" ? content
  : (content ?? []).map(block => block.text ?? "").join("\n");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

it("is unknown after a cycle whose first update came after a second shell finished, through the real Claude ACP stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-overlapping-shells-"));
  const home = join(root, "home"), cwd = join(root, "workspace"), config = join(home, ".claude");
  await Promise.all([mkdir(config, { recursive: true }), mkdir(cwd)]);
  const finishedTasks = new Set<string>();
  let releaseFirstCycle!: () => void;
  const secondFinished = new Promise<void>((resolve) => { releaseFirstCycle = resolve; });
  let notifications = 0;
  let sequence = 0;
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (body: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET") return json({ data: [], has_more: false });
    if (request.url?.includes("count_tokens")) return json({ input_tokens: 1 });
    const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean; messages?: Message[]; tools?: Array<{ name: string }> };
    const model = body.model ?? "claude-sonnet-5";
    if (body.stream !== true) {
      return json({ id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const last = (body.messages ?? []).filter(message => message.role === "user" || message.role === "assistant").at(-1)?.content;
    const frames: Array<Record<string, unknown>> = [{ type: "message_start", message: { id: `msg_${++sequence}`, type: "message",
      role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
    const text = (value: string) => frames.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    const bash = (index: number, command: string) => frames.push(
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_01Shell${index}`, name: "Bash", input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: `shell ${index}`, run_in_background: true }) } },
      { type: "content_block_stop", index });
    if (/<task-notification>/.test(textOf(last))) {
      notifications += 1;
      if (notifications === 1) await secondFinished;
      text("Handled a notification.");
    } else if (Array.isArray(last) && last.some(block => block.type === "tool_result")) {
      text("Started.");
    } else if ((body.tools ?? []).some(tool => tool.name === "Bash") && /BACKGROUND-TURN/.test(textOf(last))) {
      bash(0, "sleep 2; echo first");
      bash(1, "sleep 3; echo second");
      frames.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } });
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
  const command: VerifiedAcpxCommandLease = {
    spawn: (args, input) => spawn(process.execPath, [entry, ...(args ?? [])], { ...input, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
    close: async () => undefined,
  };
  const options = {
    command,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    cwd,
    stateDirectory: join(root, "state"),
    providerSessionKey: "claude-overlapping-shells",
    permissionMode: "approve-all",
    permissionPolicy: { autoApprove: ["read", "write", "execute", "other"], defaultAction: "approve" },
    launchEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin", TMPDIR: root,
      ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", ENABLE_TOOL_SEARCH: "false" },
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Run the requested commands.",
    mcpServers: [],
    retainFailedAdmissionCleanup: vi.fn(),
  } as AcpxRuntimePortOpenOptions;
  let port: Awaited<ReturnType<typeof openCodexAcpxRuntime>> | undefined;
  try {
    port = await openCodexAcpxRuntime(options, {
      awaitProviderOwnership: async () => undefined,
      awaitProviderExit: child => new Promise<void>(resolve => child.once("exit", () => resolve())),
      createRuntime: (created) => {
        const observe = created.onAcpMessage;
        created.onAcpMessage = (direction, message) => {
          observe?.(direction, message);
          const update = record(record(record(message).params).update);
          if (update.sessionUpdate === "async_task_state_update" && update.state === "completed") {
            finishedTasks.add(String(update.asyncTaskId));
            if (finishedTasks.size === 2) releaseFirstCycle();
          }
        };
        return createAcpRuntime(created);
      },
    });
    const cycles = port.providerCycles!()!;
    let started = 0;
    const ended: Array<ClaudeBackgroundTaskState | null> = [];
    void (async () => {
      for (let item = await cycles.next(); item !== null; item = await cycles.next()) {
        if (item.type === "started") {
          started += 1;
          cycles.adopt({ onPermissionRequest: async () => ({ outcome: "allow_once" }), busy: () => false });
        }
        if (item.type === "ended") ended.push(port!.backgroundTaskState?.() ?? null);
      }
    })();
    const turn = port.startTurn({ text: "BACKGROUND-TURN: start both commands in the background.", requestId: "turn-1",
      onPermissionRequest: async () => ({ outcome: "allow_once" }) });
    for await (const _event of turn.events) void _event;
    expect(await turn.result).toMatchObject({ status: "completed" });
    expect(port.backgroundTaskState?.()).toEqual({ live: 2 });
    await vi.waitFor(() => expect(ended.length).toBeGreaterThanOrEqual(1), { timeout: 20_000, interval: 50 });
    expect(ended[0]).toBeNull();
    await vi.waitFor(() => expect(notifications).toBe(2), { timeout: 20_000, interval: 50 });
    await vi.waitFor(() => expect(ended).toHaveLength(2), { timeout: 20_000, interval: 50 });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect({ started, ended }).toEqual({ started: 2, ended: [null, null] });
  } finally {
    try { await port?.close({ reason: "overlapping shells verified" }); }
    finally {
      api.closeAllConnections();
      await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}, 60_000);
