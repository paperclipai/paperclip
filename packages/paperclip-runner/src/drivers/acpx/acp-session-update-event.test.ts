import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAcpRuntime, createAgentRegistry, createFileSessionStore, type AcpRuntimeEvent } from "acpx/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ACP_SESSION_UPDATE_EVENT_KINDS, acpRuntimeEventFromValidatedSessionUpdate, createAcpSessionUpdateEventConverter } from "./acp-session-update-event.js";

const FIXTURES: Array<Record<string, unknown>> = [
  { sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "Terminal", kind: "execute", status: "pending", rawInput: { command: "ls", args: ["-la", 3] }, _meta: { claudeCode: { toolName: "Bash" } } },
  { sessionUpdate: "tool_call", toolCallId: "toolu_2", title: "  ", kind: "not-a-kind", rawInput: "plain input", locations: [{ path: "/w/a.ts", line: 3 }] },
  { sessionUpdate: "tool_call", toolCallId: "toolu_3", title: "Read", rawInput: { file_path: "/w/x" }, content: [{ type: "content", content: { type: "text", text: "body" } }] },
  { sessionUpdate: "tool_call", toolCallId: "toolu_4", rawInput: { path: "/w/p", pattern: "q" }, rawOutput: 7 },
  { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "completed", rawOutput: { stdout: "x".repeat(700) } },
  { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", content: [{ type: "content", content: { type: "text", text: "dup" } }, { type: "content", content: { type: "text", text: "dup" } }, { type: "diff", path: "/w/d" }, { type: "terminal", terminalId: "t1" }, { type: "resource_link", name: "n", uri: "u" }, { type: "resource", resource: { uri: "file:///r" } }, { type: "audio", mimeType: "audio/wav" }, { type: "unknown" }] },
  { sessionUpdate: "tool_call_update", toolCallId: "toolu_2", rawOutput: { error: "boom" }, rawInput: { cmd: "make" } },
  { sessionUpdate: "tool_call_update", toolCallId: "toolu_3", status: "failed", _meta: { claudeCode: { nonExecutionKind: "permission-rule" } } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
  { sessionUpdate: "agent_message_chunk", messageId: " m-1 ", content: { type: "text", text: "" }, _meta: { origin: " a ", kind: 3, source: "s", secret: "x" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "", mimeType: "image/png" } },
  { sessionUpdate: "agent_message_chunk", text: "legacy text" },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
  { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } },
  { sessionUpdate: "usage_update", used: 10, _meta: { "_claude/origin": { kind: "task-notification" }, usage: { input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 1 } } },
  { sessionUpdate: "usage_update", cost: { currency: " " }, _meta: { usage: { inputTokens: "1" } } },
  { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "Init", input: { hint: "x" } }, { name: " " }, "bad", { name: "plain" }] },
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  { sessionUpdate: "current_mode_update" },
  { sessionUpdate: "config_option_update", id: "effort", currentValue: "high" },
  { sessionUpdate: "config_option_update", configOptionId: "model" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "session_info_update", title: "A title" },
  { sessionUpdate: "session_info_update", summary: "summary text", _meta: { claudeCode: { hook: { phase: "started" } } } },
  { sessionUpdate: "plan", entries: [{ content: "step one", status: "in_progress", priority: "high" }, { content: "bad", status: "nope" }, { content: "two", status: "pending", priority: "urgent" }] },
  { sessionUpdate: "plan", entries: [] },
  { sessionUpdate: "plan", entries: [{ content: " ", status: "pending" }, { content: "later", status: "completed" }] },
  { sessionUpdate: "plan", entries: [{ status: "pending" }] },
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
  { sessionUpdate: "async_task_spawned", asyncTaskId: "b1", taskType: "shell" },
  { sessionUpdate: "async_task_state_update", asyncTaskId: "b1", state: "completed" },
  { sessionUpdate: "not_a_kind" },
];

const FAKE_AGENT = `
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const updates = JSON.parse(readFileSync(process.argv[2], "utf8"));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session" } });
  if (message.method === "session/prompt") {
    for (const update of updates) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update } });
    return setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), 50);
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

describe("Paperclip's copy of the ACPX session update converter", () => {
  let root = "";
  const raw: unknown[] = [];
  const acpxEvents: AcpRuntimeEvent[] = [];
  const converted: Array<AcpRuntimeEvent | null> = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "acp-session-update-event-"));
    const agentPath = join(root, "fake-agent.mjs");
    const fixturePath = join(root, "updates.json");
    await writeFile(agentPath, FAKE_AGENT);
    await writeFile(fixturePath, JSON.stringify(FIXTURES));
    const runtime = createAcpRuntime({
      cwd: root,
      sessionStore: createFileSessionStore({ stateDir: join(root, "state") }),
      agentRegistry: createAgentRegistry({ overrides: { fake: [process.execPath, agentPath, fixturePath] } }),
      permissionMode: "deny-all",
      onAcpMessage: (direction, message) => {
        if (direction === "inbound" && (message as { method?: unknown }).method === "session/update") raw.push(structuredClone(message));
      },
    });
    try {
      const handle = await runtime.ensureSession({ sessionKey: "fake", agent: "fake", mode: "persistent", cwd: root });
      const turn = runtime.startTurn({ handle, text: "emit", mode: "prompt", requestId: "fixture-turn" });
      for await (const event of turn.events) acpxEvents.push(event);
      await turn.result;
    } finally {
      await runtime.shutdown?.();
    }
    const converter = createAcpSessionUpdateEventConverter();
    try {
      for (const message of raw) converted.push(await converter.convert(message));
    } finally {
      converter.close();
    }
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces exactly the events ACPX yields for every fixture update, in order", () => {
    expect(raw).toHaveLength(FIXTURES.length);
    expect(converted.filter((event) => event !== null)).toEqual(acpxEvents);
  });

  it("covers every kind ACPX parses and returns null for every kind it ignores", () => {
    const byKind = new Map<string, number>();
    raw.forEach((message, index) => {
      const kind = String((message as { params: { update: { sessionUpdate: string } } }).params.update.sessionUpdate);
      if (converted[index] !== null) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    });
    expect([...byKind.keys()].sort()).toEqual([...ACP_SESSION_UPDATE_EVENT_KINDS].sort());
    for (const ignored of ["user_message_chunk", "async_task_spawned", "async_task_state_update", "not_a_kind"]) {
      expect(byKind.has(ignored)).toBe(false);
    }
  });

  it("ignores messages that are not session updates", () => {
    expect(acpRuntimeEventFromValidatedSessionUpdate({ method: "session/request_permission", params: { update: {} } })).toBeNull();
    expect(acpRuntimeEventFromValidatedSessionUpdate({ method: "session/update", params: {} })).toBeNull();
    expect(acpRuntimeEventFromValidatedSessionUpdate(null)).toBeNull();
  });
});

describe("the ACP SDK the converter validates with", () => {
  it("is the exact package instance acpx resolves", () => {
    const runner = createRequire(import.meta.url);
    const acpx = createRequire(runner.resolve("acpx/runtime"));
    const packageRoot = (entry: string) => {
      let directory = dirname(realpathSync(entry));
      while (!existsSync(join(directory, "package.json")) || !JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name) {
        directory = dirname(directory);
      }
      return directory;
    };
    const ours = packageRoot(runner.resolve("@agentclientprotocol/sdk"));
    const theirs = packageRoot(acpx.resolve("@agentclientprotocol/sdk"));
    expect(ours).toBe(theirs);
    const manifest = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
    expect(manifest(ours)).toMatchObject({ name: "@agentclientprotocol/sdk", version: manifest(theirs).version });
    const declared = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> })
      .dependencies["@agentclientprotocol/sdk"];
    expect(declared).toBe(manifest(theirs).version);
  });
});
