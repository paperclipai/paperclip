import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "@paperclipai/adapter-cursor-local/server";

async function writeFakeCursorCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "cursor-session-1",
  model: "auto",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "cursor-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeSandboxCursorAgent(commandPath: string, capturePath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const payload = {
  command: process.argv[1],
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  path: process.env.PATH || "",
};
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload), "utf8");
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "cursor-session-remote-1",
  model: "auto",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "cursor-session-remote-1",
  result: "ok",
}));
`;
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
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
      return await runChildProcess(`cursor-sandbox-execute-${counter}`, input.command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  paperclipEnvKeys: string[];
};

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("cursor execute", () => {
  it("injects paperclip env vars and prompt note by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
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
          model: "auto",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).not.toContain("Follow the paperclip heartbeat.");
      expect(capture.argv).not.toContain("--mode");
      expect(capture.argv).not.toContain("ask");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(capture.prompt).toContain("Paperclip runtime note:");
      expect(capture.prompt).toContain("PAPERCLIP_API_KEY");
      expect(invocationPrompt).toContain("Paperclip runtime note:");
      expect(invocationPrompt).toContain("PAPERCLIP_API_URL");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes --mode when explicitly configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-execute-mode-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
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
          model: "auto",
          mode: "ask",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--mode");
      expect(capture.argv).toContain("ask");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects company-library runtime skills into the Cursor skills home before execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-execute-runtime-skill-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const runtimeSkillsRoot = path.join(root, "runtime-skills");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);

    const paperclipDir = await createSkillDir(runtimeSkillsRoot, "paperclip");
    const asciiHeartDir = await createSkillDir(runtimeSkillsRoot, "ascii-heart");

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-3",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
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
          model: "auto",
          paperclipRuntimeSkills: [
            {
              name: "paperclip",
              source: paperclipDir,
              required: true,
              requiredReason: "Bundled Paperclip skills are always available for local adapters.",
            },
            {
              name: "ascii-heart",
              source: asciiHeartDir,
            },
          ],
          paperclipSkillSync: {
            desiredSkills: ["ascii-heart"],
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect((await fs.lstat(path.join(root, ".cursor", "skills", "ascii-heart"))).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(path.join(root, ".cursor", "skills", "ascii-heart"))).toBe(
        await fs.realpath(asciiHeartDir),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers ~/.local/bin/cursor-agent for remote sandbox execution when using the default command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-sandbox-execute-"));
    const homeDir = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "remote-workspace");
    const capturePath = path.join(root, "capture.json");
    const cursorAgentPath = path.join(homeDir, ".local", "bin", "cursor-agent");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await writeFakeSandboxCursorAgent(cursorAgentPath, capturePath);

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const result = await execute({
        runId: "run-sandbox-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: remoteWorkspace,
          runner: createLocalSandboxRunner(),
          timeoutMs: 30_000,
        },
        config: {
          command: "agent",
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as {
        command: string;
        argv: string[];
        prompt: string;
        path: string;
      };
      expect(capture.command).toBe(cursorAgentPath);
      expect(capture.path.split(":")[0]).toBe(path.join(homeDir, ".local", "bin"));
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit command overrides for remote sandbox execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-sandbox-explicit-"));
    const homeDir = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "remote-workspace");
    const capturePath = path.join(root, "capture.json");
    const cursorAgentPath = path.join(homeDir, ".local", "bin", "cursor-agent");
    const customCommandPath = path.join(root, "bin", "custom-cursor");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await writeFakeSandboxCursorAgent(cursorAgentPath, path.join(root, "unused.json"));
    await writeFakeSandboxCursorAgent(customCommandPath, capturePath);

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const result = await execute({
        runId: "run-sandbox-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor Coder",
          adapterType: "cursor",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: remoteWorkspace,
          runner: createLocalSandboxRunner(),
          timeoutMs: 30_000,
        },
        config: {
          command: customCommandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { command: string };
      expect(capture.command).toBe(customCommandPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
