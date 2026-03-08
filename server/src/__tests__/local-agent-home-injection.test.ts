import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { execute as executeCursor } from "@paperclipai/adapter-cursor-local/server";
import { execute as executeOpenCode } from "@paperclipai/adapter-opencode-local/server";

type CapturePayload = {
  argv: string[];
  env: {
    AGENT_HOME?: string;
  };
};

type TestExecute = typeof executeClaude;

async function writeExecutable(commandPath: string, script: string): Promise<void> {
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function readCapture(capturePath: string): Promise<CapturePayload> {
  return JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
}

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  await writeExecutable(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    env: { AGENT_HOME: process.env.AGENT_HOME },
  }), "utf8");
}
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "codex ok" },
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 7 },
}));
`,
  );
}

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  await writeExecutable(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    env: { AGENT_HOME: process.env.AGENT_HOME },
  }), "utf8");
}
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "sonnet",
}));
console.log(JSON.stringify({
  type: "assistant",
  session_id: "claude-session-1",
  message: { content: [{ type: "text", text: "claude ok" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  usage: {
    input_tokens: 13,
    cache_read_input_tokens: 3,
    output_tokens: 5,
  },
  total_cost_usd: 0.01,
  result: "claude ok",
}));
`,
  );
}

async function writeFakeCursorCommand(commandPath: string): Promise<void> {
  await writeExecutable(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    argv: process.argv.slice(2),
    env: { AGENT_HOME: process.env.AGENT_HOME },
  }), "utf8");
}
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "cursor-session-1",
  model: "auto",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "cursor ok" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "cursor-session-1",
  result: "cursor ok",
}));
`,
  );
}

async function writeFakeOpenCodeCommand(commandPath: string): Promise<void> {
  await writeExecutable(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log("openai/gpt-5.4 ready");
  process.exit(0);
}
if (args[0] === "run") {
  const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
  if (capturePath) {
    fs.writeFileSync(capturePath, JSON.stringify({
      argv: args,
      env: { AGENT_HOME: process.env.AGENT_HOME },
    }), "utf8");
  }
  fs.readFileSync(0, "utf8");
  console.log(JSON.stringify({ type: "step_start", sessionID: "opencode-session-1" }));
  console.log(JSON.stringify({ type: "text", part: { type: "text", text: "opencode ok" } }));
  console.log(JSON.stringify({
    type: "step_finish",
    part: {
      reason: "stop",
      cost: 0.00042,
      tokens: { input: 10, output: 5, cache: { read: 2, write: 0 } },
    },
  }));
  process.exit(0);
}
console.error("unexpected command", args.join(" "));
process.exit(1);
`,
  );
}

async function expectAgentHomeInjected(input: {
  execute: TestExecute;
  commandPath: string;
  cwd: string;
  instructionsFilePath: string;
  capturePath: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
}) {
  const result = await input.execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: input.commandPath,
      cwd: input.cwd,
      instructionsFilePath: input.instructionsFilePath,
      promptTemplate: "Continue your Paperclip work.",
      env: {
        PAPERCLIP_TEST_CAPTURE_PATH: input.capturePath,
      },
      ...input.config,
    },
    context: {
      paperclipWorkspace: {
        source: "agent_home",
      },
      ...input.context,
    },
    authToken: "run-jwt-token",
    onLog: async () => {},
    onMeta: async () => {},
  });

  expect(result.exitCode).toBe(0);
  expect(result.errorMessage).toBeNull();

  const capture = await readCapture(input.capturePath);
  expect(capture.env.AGENT_HOME).toBe(path.dirname(input.instructionsFilePath));
}

describe("local adapter AGENT_HOME injection", () => {
  it("injects AGENT_HOME for codex runs from instructionsFilePath", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-agent-home-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const instructionsDir = path.join(root, "agents", "ceo");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    const previousCodexHome = process.env.CODEX_HOME;

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "# Instructions\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    process.env.CODEX_HOME = path.join(root, ".codex");

    try {
      await expectAgentHomeInjected({
        execute: executeCodex,
        commandPath,
        cwd: workspace,
        instructionsFilePath,
        capturePath,
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects AGENT_HOME for claude runs from instructionsFilePath", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    const instructionsDir = path.join(root, "agents", "ceo");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "# Instructions\n", "utf8");
    await writeFakeClaudeCommand(commandPath);

    try {
      await expectAgentHomeInjected({
        execute: executeClaude,
        commandPath,
        cwd: workspace,
        instructionsFilePath,
        capturePath,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects AGENT_HOME for cursor runs from instructionsFilePath", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-agent-home-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    const instructionsDir = path.join(root, "agents", "ceo");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    const previousHome = process.env.HOME;

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "# Instructions\n", "utf8");
    await writeFakeCursorCommand(commandPath);

    process.env.HOME = root;

    try {
      await expectAgentHomeInjected({
        execute: executeCursor,
        commandPath,
        cwd: workspace,
        instructionsFilePath,
        capturePath,
        config: {
          model: "auto",
        },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects AGENT_HOME for opencode runs from instructionsFilePath", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-agent-home-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const capturePath = path.join(root, "capture.json");
    const instructionsDir = path.join(root, "agents", "ceo");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    const previousHome = process.env.HOME;

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "# Instructions\n", "utf8");
    await writeFakeOpenCodeCommand(commandPath);

    process.env.HOME = root;

    try {
      await expectAgentHomeInjected({
        execute: executeOpenCode,
        commandPath,
        cwd: workspace,
        instructionsFilePath,
        capturePath,
        config: {
          model: "openai/gpt-5.4",
        },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
