import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  claudeCommandSupportsEffortFlag,
  claudeSessionCwdMatchesExecutionTarget,
  execute,
  resetClaudeCliCapabilitiesCacheForTests,
} from "@paperclipai/adapter-claude-local/server";

async function writeFailingClaudeCommand(
  commandPath: string,
  options: { resultEvent: Record<string, unknown>; exitCode?: number },
): Promise<void> {
  const payload = JSON.stringify(options.resultEvent);
  const exit = options.exitCode ?? 1;
  const script = `#!/usr/bin/env node
console.log(${JSON.stringify(payload)});
process.exit(${exit});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeTextFailingClaudeCommand(
  commandPath: string,
  options: { stdout?: string; stderr?: string; exitCode?: number },
): Promise<void> {
  const exit = options.exitCode ?? 1;
  const script = `#!/usr/bin/env node
if (${JSON.stringify(options.stdout ?? "")}) {
  process.stdout.write(${JSON.stringify(options.stdout ?? "")});
}
if (${JSON.stringify(options.stderr ?? "")}) {
  process.stderr.write(${JSON.stringify(options.stderr ?? "")});
}
process.exit(${exit});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const addDirIndex = argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? argv[addDirIndex + 1] : null;
const instructionsIndex = argv.indexOf("--append-system-prompt-file");
const instructionsFilePath = instructionsIndex >= 0 ? argv[instructionsIndex + 1] : null;
const mcpConfigIndex = argv.indexOf("--mcp-config");
const mcpConfigPath = mcpConfigIndex >= 0 ? argv[mcpConfigIndex + 1] : null;
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv,
  prompt: fs.readFileSync(0, "utf8"),
  addDir,
  instructionsFilePath,
  instructionsContents: instructionsFilePath ? fs.readFileSync(instructionsFilePath, "utf8") : null,
  mcpConfigPath,
  mcpConfigContents: mcpConfigPath ? fs.readFileSync(mcpConfigPath, "utf8") : null,
  skillEntries: addDir ? fs.readdirSync(path.join(addDir, ".claude", "skills")).sort() : [],
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
  claudeConfigEntries: process.env.CLAUDE_CONFIG_DIR && fs.existsSync(process.env.CLAUDE_CONFIG_DIR)
    ? fs.readdirSync(process.env.CLAUDE_CONFIG_DIR).sort()
    : [],
  paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
  paperclipApiKey: process.env.PAPERCLIP_API_KEY || null,
  paperclipApiBridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE || null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "11111111-1111-4111-8111-111111111111", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "11111111-1111-4111-8111-111111111111", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeHelpWithoutEffortClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write("Usage: claude [options]\\n  --print\\n  --model <id>\\n");
  process.exit(0);
}
if (argv.includes("--effort")) {
  process.stderr.write("error: unknown option '--effort'\\n");
  process.exit(1);
}
const addDirIndex = argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? argv[addDirIndex + 1] : null;
const instructionsIndex = argv.indexOf("--append-system-prompt-file");
const instructionsFilePath = instructionsIndex >= 0 ? argv[instructionsIndex + 1] : null;
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv,
  prompt: fs.readFileSync(0, "utf8"),
  addDir,
  instructionsFilePath,
  instructionsContents: instructionsFilePath ? fs.readFileSync(instructionsFilePath, "utf8") : null,
  skillEntries: addDir ? fs.readdirSync(path.join(addDir, ".claude", "skills")).sort() : [],
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "33333333-3333-4333-8333-333333333333", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "33333333-3333-4333-8333-333333333333", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeHelpWithEffortClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  const helpCountPath = process.env.PAPERCLIP_TEST_HELP_COUNT_PATH;
  if (helpCountPath) {
    const current = fs.existsSync(helpCountPath) ? Number(fs.readFileSync(helpCountPath, "utf8")) || 0 : 0;
    fs.writeFileSync(helpCountPath, String(current + 1), "utf8");
  }
  process.stdout.write("Usage: claude [options]\\n  --print\\n  --effort <level>\\n  --model <id>\\n");
  process.exit(0);
}
const addDirIndex = argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? argv[addDirIndex + 1] : null;
const instructionsIndex = argv.indexOf("--append-system-prompt-file");
const instructionsFilePath = instructionsIndex >= 0 ? argv[instructionsIndex + 1] : null;
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv,
  prompt: fs.readFileSync(0, "utf8"),
  addDir,
  instructionsFilePath,
  instructionsContents: instructionsFilePath ? fs.readFileSync(instructionsFilePath, "utf8") : null,
  skillEntries: addDir ? fs.readdirSync(path.join(addDir, ".claude", "skills")).sort() : [],
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "44444444-4444-4444-8444-444444444444", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "44444444-4444-4444-8444-444444444444", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "44444444-4444-4444-8444-444444444444", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  addDir: string | null;
  instructionsFilePath: string | null;
  instructionsContents: string | null;
  skillEntries: string[];
  claudeConfigDir: string | null;
  claudeConfigEntries?: string[];
  paperclipApiUrl?: string | null;
  paperclipApiKey?: string | null;
  paperclipApiBridgeMode?: string | null;
  appendedSystemPromptFilePath?: string | null;
  appendedSystemPromptFileContents?: string | null;
};

afterEach(() => {
  resetClaudeCliCapabilitiesCacheForTests();
});

async function writePoisonedMessageIdClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const statePath = process.env.PAPERCLIP_TEST_STATE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
};
if (capturePath) {
  const entries = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : [];
  entries.push(payload);
  fs.writeFileSync(capturePath, JSON.stringify(entries), "utf8");
}
const resumed = process.argv.includes("--resume");
const shouldFailResume = resumed && statePath && !fs.existsSync(statePath);
if (shouldFailResume) {
  fs.writeFileSync(statePath, "retried", "utf8");
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    is_error: true,
    result: "API Error: 400 diagnostics.previous_message_id: must be the \`id\` from a prior /v1/messages response (starts with \`msg_\`)",
  }));
  process.exit(1);
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeAlwaysPoisonedMessageIdClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
};
if (capturePath) {
  const entries = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : [];
  entries.push(payload);
  fs.writeFileSync(capturePath, JSON.stringify(entries), "utf8");
}
// Both --resume and fresh attempts emit the poisoned previous_message_id result.
// The fresh attempt still carries a session_id in the result; the adapter must
// NOT persist it, otherwise the next continuation re-resumes a known-bad transcript.
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "fffff111-0000-4000-8000-000000000003",
  is_error: true,
  result: "API Error: 400 diagnostics.previous_message_id: must be the \`id\` from a prior /v1/messages response (starts with \`msg_\`)",
}));
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeRetryThenSucceedClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const statePath = process.env.PAPERCLIP_TEST_STATE_PATH;
const promptFileFlagIndex = process.argv.indexOf("--append-system-prompt-file");
const appendedSystemPromptFilePath = promptFileFlagIndex >= 0 ? process.argv[promptFileFlagIndex + 1] : null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
  appendedSystemPromptFilePath,
  appendedSystemPromptFileContents: appendedSystemPromptFilePath ? fs.readFileSync(appendedSystemPromptFilePath, "utf8") : null,
};
if (capturePath) {
  const entries = fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : [];
  entries.push(payload);
  fs.writeFileSync(capturePath, JSON.stringify(entries), "utf8");
}
const resumed = process.argv.includes("--resume");
const shouldFailResume = resumed && statePath && !fs.existsSync(statePath);
if (shouldFailResume) {
  fs.writeFileSync(statePath, "retried", "utf8");
  console.log(JSON.stringify({
    type: "result",
    subtype: "error",
    session_id: "11111111-1111-4111-8111-111111111111",
    result: "No conversation found with session id 11111111-1111-4111-8111-111111111111",
    errors: ["No conversation found with session id 11111111-1111-4111-8111-111111111111"],
  }));
  process.exit(1);
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "22222222-2222-4222-8222-222222222222", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "22222222-2222-4222-8222-222222222222", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function setupExecuteEnv(
  root: string,
  options?: { commandWriter?: (commandPath: string) => Promise<void> },
) {
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const commandPath = path.join(binDir, "claude");
  const capturePath = path.join(root, "capture.json");
  const statePath = path.join(root, "state.txt");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await (options?.commandWriter ?? writeFakeClaudeCommand)(commandPath);
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    workspace, commandPath, capturePath, statePath,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      return runChildProcess(
        `sandbox-run-${counter}`,
        input.command,
        input.args ?? [],
        {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        },
      );
    },
  };
}

describe("claude execute", () => {
  it("uses a strict per-agent MCP config only when managed servers are present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-mcp-config-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root);
    try {
      const run = async (runId: string, agentId: string, servers: AdapterRuntimeMcpServer[]) => {
        await execute({
          runId,
          agent: { id: agentId, companyId: "co-1", name: agentId, adapterType: "claude_local", adapterConfig: { engine: "cli" } },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            engine: "cli",
            command: commandPath,
            cwd: workspace,
            env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
            promptTemplate: "Do work.",
          },
          runtimeMcp: { getServers: () => servers },
          context: {},
          authToken: "tok",
          onLog: async () => {},
        });
        return JSON.parse(await fs.readFile(capturePath, "utf8"));
      };

      const alpha = await run("run-alpha", "agent-alpha", [{
        name: "alpha",
        url: "https://paperclip.example/api/tool-gateway/gateways/alpha/mcp",
        token: "alpha-token",
        connectionId: "connection-alpha",
      }]);
      const zero = await run("run-zero", "agent-zero", []);

      expect(alpha.argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config"]));
      expect(JSON.parse(alpha.mcpConfigContents)).toEqual({
        mcpServers: {
          alpha: {
            type: "http",
            url: "https://paperclip.example/api/tool-gateway/gateways/alpha/mcp",
            headers: { Authorization: "Bearer alpha-token" },
          },
        },
      });
      expect(zero.argv).not.toContain("--mcp-config");
      expect(zero.argv).not.toContain("--strict-mcp-config");
      expect(zero.mcpConfigPath).toBeNull();
      expect(zero.mcpConfigContents).toBeNull();
      expect(alpha.mcpConfigPath).toContain("/agents/agent-alpha/");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Regression tests for https://github.com/paperclipai/paperclip/issues/2848
   *
   * --append-system-prompt-file should only be passed on fresh sessions.
   * On resumed sessions the instructions are already in the session cache;
   * re-injecting them wastes tokens and may be rejected by the CLI.
   */
  it("passes --append-system-prompt-file on a fresh session when instructionsFile is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-fresh-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root);
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    try {
      await execute({
        runId: "run-fresh",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Do work.",
          instructionsFilePath: instructionsFile,
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const captured = JSON.parse(await fs.readFile(capturePath, "utf-8"));
      expect(captured.argv).toContain("--append-system-prompt-file");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits --append-system-prompt-file on a resumed session even when instructionsFile is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-resume-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root);
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    try {
      await execute({
        runId: "run-resume",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: "11111111-1111-4111-8111-111111111111", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Do work.",
          instructionsFilePath: instructionsFile,
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const captured = JSON.parse(await fs.readFile(capturePath, "utf-8"));
      expect(captured.argv).not.toContain("--append-system-prompt-file");
      expect(captured.argv).toContain("--resume");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Regression tests for commandNotes accuracy (Greptile P2).
   *
   * commandNotes should only claim instructions were injected when the flag
   * was actually passed — i.e. on fresh sessions, not resumed ones.
   */
  it("commandNotes reports injection on a fresh session with instructionsFile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-notes-fresh-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    let capturedNotes: string[] = [];
    try {
      await execute({
        runId: "run-notes-fresh",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {},
          promptTemplate: "Do work.",
          instructionsFilePath: instructionsFile,
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async (meta) => { capturedNotes = (meta.commandNotes as string[]) ?? []; },
      });
      expect(capturedNotes.some((n) => n.includes("--append-system-prompt-file"))).toBe(true);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("commandNotes is empty on a resumed session even when instructionsFile is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-notes-resume-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    let capturedNotes: string[] = ["sentinel"];
    try {
      await execute({
        runId: "run-notes-resume",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: "11111111-1111-4111-8111-111111111111", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {},
          promptTemplate: "Do work.",
          instructionsFilePath: instructionsFile,
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async (meta) => { capturedNotes = (meta.commandNotes as string[]) ?? []; },
      });
      expect(capturedNotes).toHaveLength(0);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the combined instructions file when an unknown resumed session falls back to fresh", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-resume-fallback-"));
    const { workspace, commandPath, capturePath, statePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writeRetryThenSucceedClaudeCommand,
    });
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    const metaEvents: Array<{ commandArgs: string[]; commandNotes: string[] }> = [];
    try {
      const result = await execute({
        runId: "run-resume-fallback",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: "11111111-1111-4111-8111-111111111111", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_TEST_STATE_PATH: statePath,
          },
          promptTemplate: "Do work.",
          instructionsFilePath: instructionsFile,
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async (meta) => {
          metaEvents.push({
            commandArgs: ((meta.commandArgs as string[]) ?? []).slice(),
            commandNotes: ((meta.commandNotes as string[]) ?? []).slice(),
          });
        },
      });
      const captured = JSON.parse(await fs.readFile(capturePath, "utf-8")) as Array<{
        argv: string[];
        appendedSystemPromptFilePath: string | null;
        appendedSystemPromptFileContents: string | null;
      }>;
      expect(captured).toHaveLength(2);
      expect(captured[0]?.argv).toContain("--resume");
      expect(captured[0]?.argv).not.toContain("--append-system-prompt-file");
      expect(captured[1]?.argv).not.toContain("--resume");
      expect(captured[1]?.argv).toContain("--append-system-prompt-file");
      expect(captured[1]?.appendedSystemPromptFilePath).toContain("agent-instructions.md");
      expect(captured[1]?.appendedSystemPromptFilePath).not.toBe(instructionsFile);
      expect(captured[1]?.appendedSystemPromptFileContents).toContain("# Agent instructions");
      expect(captured[1]?.appendedSystemPromptFileContents).toContain(
        `The above agent instructions were loaded from ${instructionsFile}. ` +
        `Resolve any relative file references from ${path.dirname(instructionsFile)}/. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`,
      );
      expect(metaEvents).toHaveLength(2);
      expect(metaEvents[0]?.commandNotes).toHaveLength(0);
      expect(metaEvents[1]?.commandNotes.some((note) => note.includes("--append-system-prompt-file"))).toBe(true);
      expect(result.sessionId).toBe("22222222-2222-4222-8222-222222222222");
      expect(result.clearSession).toBe(false);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes max-turn exhaustion into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-max-turns-"));
    const resultEvent = {
      type: "result",
      subtype: "error_max_turns",
      session_id: "11111111-1111-4111-8111-111111111111",
      is_error: true,
      result: "Maximum turns reached.",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    };
    const { workspace, commandPath, restore } = await setupExecuteEnv(root, {
      commandWriter: (commandPath) => writeFailingClaudeCommand(commandPath, { resultEvent }),
    });

    try {
      const result = await execute({
        runId: "run-max-turns",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("max_turns_exhausted");
      expect(result.errorFamily).toBeNull();
      expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
      expect(result.clearSession).toBe(true);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not normalize unstructured max-turn text into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-max-turn-text-"));
    const resultEvent = {
      type: "result",
      subtype: "error",
      session_id: "11111111-1111-4111-8111-111111111111",
      is_error: true,
      result: "Tool output said: Maximum turns reached.",
    };
    const { workspace, commandPath, restore } = await setupExecuteEnv(root, {
      commandWriter: (commandPath) => writeFailingClaudeCommand(commandPath, { resultEvent }),
    });

    try {
      const result = await execute({
        runId: "run-max-turns-text",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).not.toBe("max_turns_exhausted");
      expect(result.resultJson?.stopReason).not.toBe("max_turns_exhausted");
      expect(result.clearSession).toBe(false);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not normalize fallback stdout/stderr max-turn text into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-max-turn-fallback-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root, {
      commandWriter: (commandPath) =>
        writeTextFailingClaudeCommand(commandPath, {
          stdout: "attacker-controlled tool output: max turns exhausted\n",
          stderr: "Maximum turns reached.\n",
        }),
    });

    try {
      const result = await execute({
        runId: "run-max-turns-fallback-text",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).not.toBe("max_turns_exhausted");
      expect(result.resultJson?.stopReason).not.toBe("max_turns_exhausted");
      expect(result.clearSession).toBe(false);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs HOME, CLAUDE_CONFIG_DIR, and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    const claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: "claude",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
      expect(result.usageBasis).toBe("per_run");
      expect(result.costUsd).toBeNull();
      expect(loggedCommand).toBe(commandPath);
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects bridge env into sandbox-managed remote runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-sandbox-"));
    const localWorkspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "sandbox-$HOME");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath1 = path.join(remoteWorkspace, "capture-1.json");
    const claudeRoot = path.join(root, ".claude");
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;

    await fs.mkdir(localWorkspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.writeFile(path.join(claudeRoot, "settings.json"), JSON.stringify({ theme: "test" }), "utf8");
    await writeFakeClaudeCommand(commandPath);

    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

    try {
      const result = await execute({
        runId: "run-sandbox-auth",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: localWorkspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath1,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "e2b",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: remoteWorkspace,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toMatchObject({
        cwd: localWorkspace,
        remoteExecution: {
          transport: "sandbox",
          providerKey: "e2b",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: remoteWorkspace,
        },
      });
      const capture = JSON.parse(await fs.readFile(capturePath1, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--allowedTools");
      expect(capture.argv).toContain(
        "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write",
      );
      expect(capture.argv).not.toContain("--dangerously-skip-permissions");
      expect(capture.claudeConfigDir).toBe(path.join(remoteWorkspace, ".paperclip-runtime", "claude", "config"));
      expect(capture.claudeConfigEntries).toContain("settings.json");
      expect(capture.paperclipApiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(capture.paperclipApiKey).not.toBe("run-jwt-token");
      expect(capture.paperclipApiBridgeMode).toBe("queue_v1");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("omits --effort for sandbox-managed runs when the installed Claude CLI does not advertise it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-sandbox-effort-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writeHelpWithoutEffortClaudeCommand,
    });
    const remoteWorkspace = path.join(root, "sandbox-workspace");
    await fs.mkdir(remoteWorkspace, { recursive: true });

    try {
      const result = await execute({
        runId: "run-sandbox-effort-fallback",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          effort: "low",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Fallback cleanly if the sandbox CLI is old.",
        },
        context: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "daytona",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: remoteWorkspace,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).not.toContain("--effort");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("passes through --effort and reuses the sandbox capability probe across sandbox leases when the installed Claude CLI advertises it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-sandbox-effort-supported-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writeHelpWithEffortClaudeCommand,
    });
    const helpCountPath = path.join(root, "help-count.txt");
    const remoteWorkspace = path.join(root, "sandbox-workspace");
    await fs.mkdir(remoteWorkspace, { recursive: true });

    const baseInput = {
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: commandPath,
        cwd: workspace,
        effort: "low",
        env: {
          PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          PAPERCLIP_TEST_HELP_COUNT_PATH: helpCountPath,
        },
        promptTemplate: "Keep the requested effort when supported.",
      },
      context: {},
      executionTarget: {
        kind: "remote" as const,
        transport: "sandbox" as const,
        providerKey: "daytona",
        environmentId: "env-1",
        leaseId: "lease-1",
        remoteCwd: remoteWorkspace,
        timeoutMs: 30_000,
        runner: createLocalSandboxRunner(),
      },
      authToken: "run-jwt-token",
      onLog: async () => {},
    };

    try {
      const first = await execute({
        runId: "run-sandbox-effort-supported-1",
        ...baseInput,
      });
      const second = await execute({
        runId: "run-sandbox-effort-supported-2",
        ...baseInput,
        executionTarget: {
          ...baseInput.executionTarget,
          leaseId: "lease-2",
        },
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--effort");
      expect(capture.argv).toContain("low");
      expect(await fs.readFile(helpCountPath, "utf8")).toBe("1");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("degrades to the conservative fallback (returns null) when the sandbox probe throws, and retries on the next lease", async () => {
    let calls = 0;
    const throwingRunner = {
      execute: async () => {
        calls += 1;
        throw new Error("sandbox connection error");
      },
    };
    const target = {
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "daytona",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/remote/workspace",
      timeoutMs: 30_000,
      runner: throwingRunner,
    };
    const probeInput = {
      runId: "run-probe-throws",
      command: "/usr/local/bin/claude",
      cwd: "/host/workspace",
      env: {},
      timeoutSec: 20,
      graceSec: 5,
    };

    // A thrown probe must resolve to null (unknown) rather than reject and kill the run.
    await expect(
      claudeCommandSupportsEffortFlag({ ...probeInput, target }),
    ).resolves.toBeNull();

    // The failed result is not cached: a second lease re-probes instead of reusing the rejection.
    await expect(
      claudeCommandSupportsEffortFlag({
        ...probeInput,
        target: { ...target, leaseId: "lease-2" },
      }),
    ).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it("allows remote session resumes when saved cwd is the host workspace", () => {
    expect(claudeSessionCwdMatchesExecutionTarget({
      runtimeSessionCwd: "/host/workspace",
      effectiveExecutionCwd: "/remote/workspace",
      executionTargetIsRemote: true,
    })).toBe(true);
    expect(claudeSessionCwdMatchesExecutionTarget({
      runtimeSessionCwd: "/host/workspace",
      effectiveExecutionCwd: "/remote/workspace",
      executionTargetIsRemote: false,
    })).toBe(false);
  });

  it("reuses a stable Paperclip-managed Claude prompt bundle across equivalent runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-bundle-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath1 = path.join(root, "capture-1.json");
    const capturePath2 = path.join(root, "capture-2.json");
    const instructionsPath = path.join(root, "AGENTS.md");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "You are managed instructions.\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    try {
      const first = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath1,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
          paperclipSkillSync: {
            desiredSkills: ["paperclip"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(first.exitCode).toBe(0);
      expect(first.errorMessage).toBeNull();
      expect(first.sessionParams).toMatchObject({
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: workspace,
      });
      expect(typeof first.sessionParams?.promptBundleKey).toBe("string");

      const second = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath2,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
          paperclipSkillSync: {
            desiredSkills: ["paperclip"],
          },
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 1,
              includedCount: 1,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(second.exitCode).toBe(0);
      expect(second.errorMessage).toBeNull();

      const capture1 = JSON.parse(await fs.readFile(capturePath1, "utf8")) as CapturePayload;
      const capture2 = JSON.parse(await fs.readFile(capturePath2, "utf8")) as CapturePayload;
      const expectedRoot = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "claude-prompt-cache",
      );

      expect(capture1.addDir).toBeTruthy();
      expect(capture1.addDir).toBe(capture2.addDir);
      expect(capture1.instructionsFilePath).toBeTruthy();
      expect(capture2.instructionsFilePath ?? null).toBeNull();
      expect(capture1.addDir?.startsWith(expectedRoot)).toBe(true);
      expect(capture1.instructionsFilePath?.startsWith(expectedRoot)).toBe(true);
      expect(capture1.instructionsContents).toContain("You are managed instructions.");
      expect(capture1.instructionsContents).toContain(`The above agent instructions were loaded from ${instructionsPath}.`);
      expect(capture1.skillEntries).toContain("paperclip");
      expect(capture2.argv).toContain("--resume");
      expect(capture2.argv).toContain("11111111-1111-4111-8111-111111111111");
      expect(capture2.prompt).toContain("## Paperclip Resume Delta");
      expect(capture2.prompt).not.toContain("Follow the paperclip heartbeat.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("starts a fresh Claude session when the stable prompt bundle changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-reset-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath1 = path.join(root, "capture-before.json");
    const capturePath2 = path.join(root, "capture-after.json");
    const instructionsPath = path.join(root, "AGENTS.md");
    const paperclipHome = path.join(root, "paperclip-home");
    const logs: string[] = [];
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "Version one instructions.\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    try {
      const first = await execute({
        runId: "run-before",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath1,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      await fs.writeFile(instructionsPath, "Version two instructions.\n", "utf8");

      const second = await execute({
        runId: "run-after",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath2,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.errorMessage).toBeNull();

      const before = JSON.parse(await fs.readFile(capturePath1, "utf8")) as CapturePayload;
      const after = JSON.parse(await fs.readFile(capturePath2, "utf8")) as CapturePayload;

      expect(before.instructionsFilePath).not.toBe(after.instructionsFilePath);
      expect(after.argv).not.toContain("--resume");
      expect(after.prompt).toContain("Follow the paperclip heartbeat.");
      expect(logs.join("")).toContain("will not be resumed with");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("classifies Claude 'out of extra usage' failures as provider quota errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-transient-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingClaudeCommand(commandPath, {
      resultEvent: {
        type: "result",
        subtype: "error",
        session_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        is_error: true,
        result: "You're out of extra usage · resets 4pm (America/Chicago)",
        errors: [{ type: "rate_limit_error", message: "You're out of extra usage" }],
      },
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 22, 10, 15, 0));

    try {
      const result = await execute({
        runId: "run-claude-transient",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
      const expectedRetryNotBefore = "2026-04-22T21:00:00.000Z";
      expect(result.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.providerQuotaRetryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.errorMessage ?? "").toContain("extra usage");
      expect(new Date(String(result.resultJson?.transientRetryNotBefore)).getTime()).toBe(
        new Date("2026-04-22T21:00:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats subtype=success results as successful even when the process exits nonzero", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-success-subtype-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingClaudeCommand(commandPath, {
      exitCode: 1,
      resultEvent: {
        type: "result",
        subtype: "success",
        session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        is_error: false,
        result: "Implemented the requested change.",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-claude-success-subtype",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toBeNull();
      expect(result.errorCode).toBeNull();
      expect(result.summary).toBe("Implemented the requested change.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies rate-limit / overloaded failures without reset metadata as transient", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-rate-limit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingClaudeCommand(commandPath, {
      resultEvent: {
        type: "result",
        subtype: "error",
        session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        is_error: true,
        result: "Overloaded",
        errors: [{ type: "overloaded_error", message: "Overloaded_error: API is overloaded." }],
      },
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-claude-overloaded",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("claude_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.retryNotBefore ?? null).toBeNull();
      expect(result.resultJson?.retryNotBefore ?? null).toBeNull();
      expect(result.resultJson?.transientRetryNotBefore ?? null).toBeNull();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reclassify deterministic Claude failures (auth, max turns) as transient", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-max-turns-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingClaudeCommand(commandPath, {
      resultEvent: {
        type: "result",
        subtype: "error_max_turns",
        session_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        is_error: true,
        result: "Maximum turns reached.",
      },
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-claude-max-turns",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).not.toBe("claude_transient_upstream");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auto-rotates session on previous_message_id 400 (synthetic-msg poisoning) and succeeds on retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-poisoned-msgid-"));
    const { workspace, commandPath, capturePath, statePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writePoisonedMessageIdClaudeCommand,
    });
    const logs: string[] = [];
    try {
      const result = await execute({
        runId: "run-poisoned-msgid",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_TEST_STATE_PATH: statePath,
          },
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async (_stream, chunk) => { logs.push(chunk); },
      });

      const captured: Array<{ argv: string[] }> = JSON.parse(await fs.readFile(capturePath, "utf-8"));
      // First attempt resumes, second attempt starts fresh
      expect(captured).toHaveLength(2);
      expect(captured[0]?.argv).toContain("--resume");
      expect(captured[1]?.argv).not.toContain("--resume");
      // Result comes from the fresh retry
      expect(result.sessionId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(result.errorCode).toBeNull();
      // Adapter logged the fallback reason
      expect(logs.some((l) => l.includes("poisoned message-id"))).toBe(true);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Regression for RED-978: the adapter must not persist a sessionId from a
   * run that ended with a poisoned previous_message_id error. Otherwise the
   * next continuation auto-resumes a known-bad transcript and Anthropic
   * /v1/messages returns 400 again, permanently stranding the issue.
   */
  it("drops sessionId and forces clearSession when a fresh run reports a poisoned previous_message_id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-poisoned-fresh-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writeAlwaysPoisonedMessageIdClaudeCommand,
    });
    try {
      const result = await execute({
        runId: "run-poisoned-fresh",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
      });

      // The fake CLI emits a session_id in its poisoned result; the adapter
      // must not propagate it. The server uses clearSession=true to wipe
      // any previously-persisted session state for this issue/task.
      expect(result.sessionId).toBeNull();
      expect(result.sessionParams).toBeNull();
      expect(result.sessionDisplayId).toBeNull();
      expect(result.clearSession).toBe(true);
      expect(result.errorCode).toBe("claude_poisoned_previous_message_id");
      expect(result.errorMessage ?? "").toContain("previous_message_id");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Regression for RED-978: if the auto-retry after a poisoned resume *also*
   * fails with a poisoned previous_message_id, the adapter must still emit
   * clearSession=true so the next heartbeat starts from a clean transcript.
   * Before this fix, the retry result's session_id ("fffff111-0000-4000-8000-000000000003")
   * was persisted and every subsequent continuation hit the same 400 again.
   */
  it("forces clearSession when the recovery retry also reports a poisoned previous_message_id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-poisoned-retry-"));
    const { workspace, commandPath, capturePath, restore } = await setupExecuteEnv(root, {
      commandWriter: writeAlwaysPoisonedMessageIdClaudeCommand,
    });
    try {
      const result = await execute({
        runId: "run-poisoned-retry",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: { engine: "cli" } },
        runtime: {
          sessionId: "aaaaaaaa-0000-4000-8000-000000000004",
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
      });

      const captured: Array<{ argv: string[] }> = JSON.parse(await fs.readFile(capturePath, "utf-8"));
      // Resume attempt + fresh recovery attempt, both poisoned.
      expect(captured).toHaveLength(2);
      expect(captured[0]?.argv).toContain("--resume");
      expect(captured[1]?.argv).not.toContain("--resume");
      // Crucially: do NOT persist the retry's reported sessionId.
      expect(result.sessionId).toBeNull();
      expect(result.sessionParams).toBeNull();
      expect(result.clearSession).toBe(true);
      expect(result.errorCode).toBe("claude_poisoned_previous_message_id");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
