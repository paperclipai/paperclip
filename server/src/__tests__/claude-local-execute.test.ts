import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
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

async function setupExecuteEnv(root: string) {
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const commandPath = path.join(binDir, "claude");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeFakeClaudeCommand(commandPath);
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    workspace, commandPath, capturePath,
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

  /**
   * Regression test for unnecessary file I/O on resumed sessions (Greptile P2).
   *
   * The combined agent-instructions.md temp file must NOT be written when
   * resuming, since the instructions are already baked into the session cache.
   */
  it("does not write agent-instructions temp file on a resumed session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exec-io-resume-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    const instructionsFile = path.join(root, "instructions.md");
    await fs.writeFile(instructionsFile, "# Agent instructions", "utf-8");
    try {
      await execute({
        runId: "run-io-resume",
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
        onMeta: async () => {},
      });
      // The skills dir lives under HOME/.paperclip/skills — verify no combined
      // agent-instructions.md was written anywhere under root on a resume.
      const allFiles = await fs.readdir(root, { recursive: true });
      const tempInstructionsWritten = (allFiles as string[]).some((f) =>
        f.includes("agent-instructions.md"),
      );
      expect(tempInstructionsWritten).toBe(false);
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
});
