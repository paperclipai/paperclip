import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const addDirIndex = argv.indexOf("--add-dir");
const addDir = addDirIndex >= 0 ? argv[addDirIndex + 1] : null;
const instructionsIndex = argv.indexOf("--append-system-prompt-file");
const instructionsFilePath = instructionsIndex >= 0 ? argv[instructionsIndex + 1] : null;
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const promptFileFlagIndex = process.argv.indexOf("--append-system-prompt-file");
const appendedSystemPromptFilePath = promptFileFlagIndex >= 0 ? process.argv[promptFileFlagIndex + 1] : null;
const payload = {
  argv,
  prompt: fs.readFileSync(0, "utf8"),
  addDir,
  instructionsFilePath,
  instructionsContents: instructionsFilePath ? fs.readFileSync(instructionsFilePath, "utf8") : null,
  skillEntries: addDir ? fs.readdirSync(path.join(addDir, ".claude", "skills")).sort() : [],
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
  appendedSystemPromptFilePath,
  appendedSystemPromptFileContents: appendedSystemPromptFilePath ? fs.readFileSync(appendedSystemPromptFilePath, "utf8") : null,
  agentHome: process.env.AGENT_HOME || null,
  nodeLlamaCppGpu: process.env.NODE_LLAMA_CPP_GPU || null,
  qmdConfigDir: process.env.QMD_CONFIG_DIR || null,
  xdgCacheHome: process.env.XDG_CACHE_HOME || null,
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
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
  appendedSystemPromptFilePath?: string | null;
  appendedSystemPromptFileContents?: string | null;
  agentHome?: string | null;
  qmdConfigDir?: string | null;
  xdgCacheHome?: string | null;
};

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
    session_id: "claude-session-1",
    result: "No conversation found with session id claude-session-1",
    errors: ["No conversation found with session id claude-session-1"],
  }));
  process.exit(1);
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-2", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "assistant", session_id: "claude-session-2", message: { content: [{ type: "text", text: "hello" }] } }));
console.log(JSON.stringify({ type: "result", session_id: "claude-session-2", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeQmdCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.PAPERCLIP_QMD_STATE_PATH;
const args = process.argv.slice(2);
const readState = () => {
  if (!statePath || !fs.existsSync(statePath)) {
    return { path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
};
const writeState = (state) => {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
};

const state = readState();
if (args[0] === "collection" && args[1] === "show") {
  if (state.path && state.collectionName === args[2]) {
    writeState(state);
    process.stdout.write("Collection: " + args[2] + "\\n");
    process.stdout.write("  Path:     " + state.path + "\\n");
    process.exit(0);
  }
  writeState(state);
  process.exit(1);
}
if (args[0] === "collection" && args[1] === "remove") {
  state.path = null;
  state.collectionName = null;
  state.removeCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "collection" && args[1] === "add") {
  const nameIndex = args.indexOf("--name");
  state.path = args[2] || null;
  state.collectionName = nameIndex >= 0 ? args[nameIndex + 1] || null : null;
  state.addCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "update") {
  state.updateCount += 1;
  writeState(state);
  process.exit(0);
}
process.exit(0);
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

describe("claude execute", () => {
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
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
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
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: "claude-session-1", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
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
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
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
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: "claude-session-1", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
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
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: "claude-session-1", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
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
      expect(result.sessionId).toBe("claude-session-2");
      expect(result.clearSession).toBe(false);
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs HOME, CLAUDE_CONFIG_DIR, and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const agentHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const capturePath = path.join(root, "capture.json");
    const claudeConfigDir = path.join(root, "claude-config");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
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
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          paperclipWorkspace: {
            agentHome,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        claudeConfigDir: string | null;
        agentHome: string | null;
        nodeLlamaCppGpu: string | null;
        qmdConfigDir: string | null;
        xdgCacheHome: string | null;
      };
      expect(loggedCommand).toBe(commandPath);
      expect(loggedEnv.HOME).toBe(root);
      expect(loggedEnv.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(loggedEnv.AGENT_HOME).toBe(agentHome);
      expect(loggedEnv.NODE_LLAMA_CPP_GPU).toBe("false");
      expect(loggedEnv.QMD_CONFIG_DIR).toBe(path.join(agentHome, ".config", "qmd"));
      expect(loggedEnv.XDG_CACHE_HOME).toBe(path.join(agentHome, ".cache"));
      expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
      expect(capture.claudeConfigDir).toBe(claudeConfigDir);
      expect(capture.agentHome).toBe(agentHome);
      expect(capture.nodeLlamaCppGpu).toBe("false");
      expect(capture.qmdConfigDir).toBe(path.join(agentHome, ".config", "qmd"));
      expect(capture.xdgCacheHome).toBe(path.join(agentHome, ".cache"));
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

  it("forwards qmd bootstrap logs and keeps prepared qmd paths authoritative", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-qmd-"));
    const workspace = path.join(root, "workspace");
    const agentHome = path.join(root, "agent-home");
    const sharedHome = path.join(root, "shared-home");
    const manualQmdConfig = path.join(root, "manual-qmd-config");
    const manualQmdCache = path.join(root, "manual-qmd-cache");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "claude");
    const qmdPath = path.join(binDir, "qmd");
    const capturePath = path.join(root, "capture.json");
    const qmdStatePath = path.join(root, "qmd-state.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(path.join(manualQmdCache, "qmd", "models"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeClaudeCommand(commandPath);
    await writeFakeQmdCommand(qmdPath);
    await fs.writeFile(
      qmdStatePath,
      JSON.stringify({ path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 }),
      "utf8",
    );

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousQmdStatePath = process.env.PAPERCLIP_QMD_STATE_PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.PAPERCLIP_QMD_STATE_PATH = qmdStatePath;

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    try {
      const result = await execute({
        runId: "run-qmd-logs",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "claude",
          cwd: workspace,
          env: {
            HOME: sharedHome,
            QMD_CONFIG_DIR: manualQmdConfig,
            XDG_CACHE_HOME: manualQmdCache,
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          paperclipWorkspace: {
            agentHome,
          },
        },
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        agentHome: string | null;
        qmdConfigDir: string | null;
        xdgCacheHome: string | null;
      };
      expect(capture.agentHome).toBe(agentHome);
      expect(capture.qmdConfigDir).toBe(path.join(agentHome, ".config", "qmd"));
      expect(capture.xdgCacheHome).toBe(path.join(agentHome, ".cache"));
      expect(await fs.realpath(path.join(agentHome, ".cache", "qmd", "models"))).toBe(
        await fs.realpath(path.join(manualQmdCache, "qmd", "models")),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Linked shared qmd models"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousQmdStatePath === undefined) delete process.env.PAPERCLIP_QMD_STATE_PATH;
      else process.env.PAPERCLIP_QMD_STATE_PATH = previousQmdStatePath;
      await fs.rm(root, { recursive: true, force: true });
    }
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
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;

    try {
      const first = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
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

      expect(first.exitCode).toBe(0);
      expect(first.errorMessage).toBeNull();
      expect(first.sessionParams).toMatchObject({
        sessionId: "claude-session-1",
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
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath2,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
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
      expect(capture2.argv).toContain("claude-session-1");
      expect(capture2.prompt).toContain("## Paperclip Resume Delta");
      expect(capture2.prompt).not.toContain("Follow the paperclip heartbeat.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
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
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;

    try {
      const first = await execute({
        runId: "run-before",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
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
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
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
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
