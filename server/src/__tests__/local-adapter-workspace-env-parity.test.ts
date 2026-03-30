import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { execute as executeCursor } from "@paperclipai/adapter-cursor-local/server";
import { execute as executeGemini } from "@paperclipai/adapter-gemini-local/server";
import { execute as executeOpenCode } from "@paperclipai/adapter-opencode-local/server";
import { execute as executePi } from "@paperclipai/adapter-pi-local/server";

const CAPTURE_KEYS = [
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_BRANCH",
  "PAPERCLIP_WORKSPACE_OBSERVED_HEAD",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
] as const;

type CaptureKey = (typeof CAPTURE_KEYS)[number];

type CapturePayload = {
  cwd: string;
  env: Partial<Record<CaptureKey, string>>;
};

type TestExecute = typeof executeClaude;

type AdapterCase = {
  name: string;
  adapterType: string;
  commandName: string;
  execute: TestExecute;
  commandMode: "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";
  config?: Record<string, unknown>;
  setupEnv?: (root: string) => Promise<() => void>;
};

async function writeExecutable(commandPath: string, script: string): Promise<void> {
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeCaptureCommand(
  commandPath: string,
  mode: AdapterCase["commandMode"],
): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const capture = () => {
  if (!capturePath) return;
  fs.writeFileSync(
    capturePath,
    JSON.stringify({
      cwd: process.cwd(),
      env: Object.fromEntries(
        ${JSON.stringify([...CAPTURE_KEYS])}
          .filter((key) => typeof process.env[key] === "string" && process.env[key].length > 0)
          .map((key) => [key, process.env[key]]),
      ),
    }),
    "utf8",
  );
};

if (${JSON.stringify(mode)} === "opencode") {
  if (args[0] === "models") {
    console.log("openai/gpt-5.4 ready");
    process.exit(0);
  }
  if (args[0] === "run") {
    capture();
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
  console.error("unexpected opencode args", args.join(" "));
  process.exit(1);
}

if (${JSON.stringify(mode)} === "pi") {
  if (args.includes("--list-models")) {
    console.log("provider  model");
    console.log("openai    gpt-4.1-mini");
    process.exit(0);
  }
  capture();
  console.log(JSON.stringify({
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "turn_start" }));
  console.log(JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "pi ok" }],
      usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } },
    },
    toolResults: [],
  }));
  process.exit(0);
}

capture();

if (${JSON.stringify(mode)} === "codex") {
  fs.readFileSync(0, "utf8");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex ok" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
  process.exit(0);
}

if (${JSON.stringify(mode)} === "claude") {
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
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0.01,
    result: "claude ok",
  }));
  process.exit(0);
}

if (${JSON.stringify(mode)} === "cursor") {
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
  process.exit(0);
}

if (${JSON.stringify(mode)} === "gemini") {
  console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "gemini-session-1",
    model: "gemini-2.5-pro",
  }));
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "output_text", text: "gemini ok" }] },
  }));
  console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "gemini-session-1",
    result: "gemini ok",
  }));
  process.exit(0);
}

console.error("unexpected mode");
process.exit(1);
`;
  await writeExecutable(commandPath, script);
}

async function setupHome(root: string): Promise<() => void> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  return async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  };
}

async function setupCodexEnv(root: string): Promise<() => void> {
  const restoreHome = await setupHome(root);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "codex-home");
  return async () => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await restoreHome();
  };
}

const ADAPTER_CASES: AdapterCase[] = [
  {
    name: "claude_local",
    adapterType: "claude_local",
    commandName: "claude",
    execute: executeClaude,
    commandMode: "claude",
    setupEnv: setupHome,
  },
  {
    name: "codex_local",
    adapterType: "codex_local",
    commandName: "codex",
    execute: executeCodex,
    commandMode: "codex",
    setupEnv: setupCodexEnv,
  },
  {
    name: "cursor",
    adapterType: "cursor",
    commandName: "agent",
    execute: executeCursor,
    commandMode: "cursor",
    config: { model: "auto" },
    setupEnv: setupHome,
  },
  {
    name: "gemini_local",
    adapterType: "gemini_local",
    commandName: "gemini",
    execute: executeGemini,
    commandMode: "gemini",
    config: { model: "gemini-2.5-pro" },
    setupEnv: setupHome,
  },
  {
    name: "opencode_local",
    adapterType: "opencode_local",
    commandName: "opencode",
    execute: executeOpenCode,
    commandMode: "opencode",
    config: { model: "openai/gpt-5.4" },
    setupEnv: setupHome,
  },
  {
    name: "pi_local",
    adapterType: "pi_local",
    commandName: "pi",
    execute: executePi,
    commandMode: "pi",
    config: { model: "openai/gpt-4.1-mini" },
    setupEnv: setupHome,
  },
];

describe("local adapter workspace env parity", () => {
  for (const adapter of ADAPTER_CASES) {
    it(`${adapter.name} injects the shared workspace env contract`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${adapter.name}-workspace-env-`));
      const workspaceCwd = path.join(root, "workspace");
      const worktreePath = path.join(root, ".paperclip", "worktrees", "GRA-1881-test-branch");
      const observedHead = "0123456789abcdef0123456789abcdef01234567";
      const commandPath = path.join(root, adapter.commandName);
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(workspaceCwd, { recursive: true });
      await writeCaptureCommand(commandPath, adapter.commandMode);

      const restoreEnv = adapter.setupEnv ? await adapter.setupEnv(root) : async () => {};
      try {
        const result = await adapter.execute({
          runId: "run-1",
          agent: {
            id: "agent-1",
            companyId: "company-1",
            name: `${adapter.name} agent`,
            adapterType: adapter.adapterType,
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
            cwd: workspaceCwd,
            env: {
              PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Continue your Paperclip work.",
            ...adapter.config,
          },
          context: {
            paperclipWorkspace: {
              cwd: workspaceCwd,
              source: "project_primary",
              strategy: "git_worktree",
              workspaceId: "workspace-1",
              repoUrl: "https://github.com/paperclipai/paperclip",
              repoRef: "main",
              branchName: "GRA-1881-test-branch",
              observedBranchName: "GRA-1881-test-branch",
              observedHeadSha: observedHead,
              worktreePath,
            },
          },
          authToken: "run-jwt-token",
          onLog: async () => {},
          onMeta: async () => {},
        });

        expect(result.exitCode).toBe(0);
        expect(result.errorMessage).toBeNull();

        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
        expect(capture.env).toEqual({
          PAPERCLIP_WORKSPACE_CWD: workspaceCwd,
          PAPERCLIP_WORKSPACE_SOURCE: "project_primary",
          PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
          PAPERCLIP_WORKSPACE_ID: "workspace-1",
          PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/paperclipai/paperclip",
          PAPERCLIP_WORKSPACE_REPO_REF: "main",
          PAPERCLIP_WORKSPACE_BRANCH: "GRA-1881-test-branch",
          PAPERCLIP_WORKSPACE_OBSERVED_BRANCH: "GRA-1881-test-branch",
          PAPERCLIP_WORKSPACE_OBSERVED_HEAD: observedHead,
          PAPERCLIP_WORKSPACE_WORKTREE_PATH: worktreePath,
        });
      } finally {
        await restoreEnv();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it(`${adapter.name} uses paperclipWorkspace.cwd for agent_home runs`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${adapter.name}-agent-home-cwd-`));
      const configuredCwd = path.join(root, "configured-workspace");
      const workspaceCwd = path.join(root, "agent-home-workspace");
      const commandPath = path.join(root, adapter.commandName);
      const capturePath = path.join(root, "capture.json");
      await fs.mkdir(configuredCwd, { recursive: true });
      await fs.mkdir(workspaceCwd, { recursive: true });
      await writeCaptureCommand(commandPath, adapter.commandMode);

      const restoreEnv = adapter.setupEnv ? await adapter.setupEnv(root) : async () => {};
      try {
        const result = await adapter.execute({
          runId: "run-1",
          agent: {
            id: "agent-1",
            companyId: "company-1",
            name: `${adapter.name} agent`,
            adapterType: adapter.adapterType,
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
            cwd: configuredCwd,
            env: {
              PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Continue your Paperclip work.",
            ...adapter.config,
          },
          context: {
            paperclipWorkspace: {
              cwd: workspaceCwd,
              source: "agent_home",
            },
          },
          authToken: "run-jwt-token",
          onLog: async () => {},
          onMeta: async () => {},
        });

        expect(result.exitCode).toBe(0);
        expect(result.errorMessage).toBeNull();

        const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
        expect(capture.cwd).toBe(workspaceCwd);
        expect(capture.env.PAPERCLIP_WORKSPACE_CWD).toBe(workspaceCwd);
        expect(capture.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("agent_home");
      } finally {
        await restoreEnv();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
