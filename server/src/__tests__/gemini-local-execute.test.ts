import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";

async function writeFakeGeminiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
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
  session_id: "gemini-session-1",
  model: "gemini-2.5-pro",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "gemini-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeCustomCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello from custom command" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "custom-session-1",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFakeResumeFallbackCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.PAPERCLIP_TEST_STATE_PATH;
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
let state = { attempts: [] };
if (statePath && fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
}
const argv = process.argv.slice(2);
state.attempts.push(argv);
if (statePath) {
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
}
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(state), "utf8");
}

const resumeIndex = argv.indexOf("--resume");
const resumeValue = resumeIndex >= 0 ? argv[resumeIndex + 1] : null;
if (resumeValue) {
  console.error("YOLO mode is enabled. All tool calls will be automatically approved.");
  console.error(\`Error resuming session: Invalid session identifier "\${resumeValue}".\`);
  process.exit(42);
}

console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "gemini-session-fresh",
  model: "gemini-2.5-pro",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "fresh session ok" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "gemini-session-fresh",
  result: "ok",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
};

describe("gemini execute", () => {
  it("passes prompt via --prompt and injects paperclip env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
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
          model: "gemini-2.5-pro",
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
      expect(capture.argv).toContain("--output-format");
      expect(capture.argv).toContain("stream-json");
      expect(capture.argv).toContain("--prompt");
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(promptArg).toContain("Follow the paperclip heartbeat.");
      expect(promptArg).toContain("Paperclip runtime note:");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(invocationPrompt).toContain("Paperclip runtime note:");
      expect(invocationPrompt).toContain("PAPERCLIP_API_URL");
      expect(invocationPrompt).toContain("Paperclip API access note:");
      expect(invocationPrompt).toContain("run_shell_command");
      expect(result.question).toBeNull();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("always passes --approval-mode yolo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-yolo-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-yolo",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(capture.argv).not.toContain("--policy");
      expect(capture.argv).not.toContain("--allow-all");
      expect(capture.argv).not.toContain("--allow-read");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips Gemini-only flags when configured command is not the Gemini CLI", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-custom-command-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCustomCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-custom-command",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).not.toContain("--approval-mode");
      expect(capture.argv).not.toContain("yolo");
      expect(capture.argv).not.toContain("--sandbox");
      expect(capture.argv).not.toContain("--sandbox=none");
      expect(capture.argv.at(-1)).toContain("Paperclip runtime note:");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries with a fresh session when Gemini rejects the saved resume identifier", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-resume-fallback-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    const capturePath = path.join(root, "capture.json");
    const statePath = path.join(root, "state.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeResumeFallbackCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-resume-fallback",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: {
          sessionId: "stale-session-uuid",
          sessionParams: { sessionId: "stale-session-uuid", cwd: workspace },
          sessionDisplayId: "stale-session-uuid",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_TEST_STATE_PATH: statePath,
          },
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.sessionId).toBe("gemini-session-fresh");

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { attempts: string[][] };
      expect(capture.attempts).toHaveLength(2);
      expect(capture.attempts[0]).toContain("--resume");
      expect(capture.attempts[0]).toContain("stale-session-uuid");
      expect(capture.attempts[1]).not.toContain("--resume");
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
