// Execution tests for Antigravity local adapter verifying CLI arguments and session management
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-antigravity-local/server";

// Writes a fake agy CLI script that records its invocation arguments and emits valid stream-json events
async function writeFakeAgyCommand(commandPath: string): Promise<string> {
  const isWindows = process.platform === "win32";
  const jsPath = isWindows ? commandPath + ".js" : commandPath;
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
  event: "init",
  conversation_id: "agy-session-100",
}));
console.log(JSON.stringify({
  event: "step_update",
  step: {
    index: 0,
    type: "PLANNER_RESPONSE",
    content: "hello from agy",
  },
}));
console.log(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: "ok",
    usage: { input_tokens: 10, output_tokens: 5 },
    cost_usd: 0.0001,
  },
}));
`;
  await fs.writeFile(jsPath, script, "utf8");
  if (isWindows) {
    const cmdPath = commandPath + ".cmd";
    const cmdScript = `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`;
    await fs.writeFile(cmdPath, cmdScript, "utf8");
    return cmdPath;
  }
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

// Writes a fake agy CLI script that simulates an unrecoverable conversation warning
async function writeStaleSessionAgyCommand(commandPath: string): Promise<string> {
  const isWindows = process.platform === "win32";
  const jsPath = isWindows ? commandPath + ".js" : commandPath;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  const payload = { argv: process.argv.slice(2) };
  fs.appendFileSync(capturePath, JSON.stringify(payload) + "\\n", "utf8");
}

const args = process.argv.slice(2);
const convIndex = args.indexOf("--conversation");
if (convIndex >= 0 && args[convIndex + 1] === "stale-session-id") {
  console.log('warning: conversation "stale-session-id" not found, starting a new one');
  process.stderr.write('Error: conversation "stale-session-id" not found\\n');
  process.exit(1);
}

console.log(JSON.stringify({
  event: "init",
  conversation_id: "fresh-session-after-retry",
}));
console.log(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: "recovered",
  },
}));
`;
  await fs.writeFile(jsPath, script, "utf8");
  if (isWindows) {
    const cmdPath = commandPath + ".cmd";
    const cmdScript = `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`;
    await fs.writeFile(cmdPath, cmdScript, "utf8");
    return cmdPath;
  }
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
};

describe("antigravity execute", () => {
  it.skipIf(process.platform === "win32")("passes Antigravity-native CLI arguments and never injects Gemini-specific flags", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agy");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const binPath = await writeFakeAgyCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-agy-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Agent",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: binPath,
          cwd: workspace,
          model: "gemini-3.8-flash-high",
          effort: "high",
          agent: "code-reviewer",
          sandbox: true,
          printTimeout: "15m",
          dangerouslySkipPermissions: true,
          extraArgs: ["--custom-flag", "value"],
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Do the heartbeat task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("agy-session-100");
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.costUsd).toBeCloseTo(0.0001, 6);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;

      // Positive assertions for Antigravity-native flags
      expect(capture.argv).toContain("--print");
      expect(capture.argv).toContain("--output-format");
      expect(capture.argv).toContain("stream-json");
      expect(capture.argv).toContain("--dangerously-skip-permissions");
      expect(capture.argv).toContain("--model");
      expect(capture.argv).toContain("gemini-3.8-flash-high");
      expect(capture.argv).toContain("--effort");
      expect(capture.argv).toContain("high");
      expect(capture.argv).toContain("--agent");
      expect(capture.argv).toContain("code-reviewer");
      expect(capture.argv).toContain("--sandbox");
      expect(capture.argv).toContain("--print-timeout");
      expect(capture.argv).toContain("15m");
      expect(capture.argv).toContain("--custom-flag");
      expect(capture.argv).toContain("value");

      // Critical negative assertions: Gemini flags MUST NOT be present
      expect(capture.argv).not.toContain("--approval-mode");
      expect(capture.argv).not.toContain("yolo");
      expect(capture.argv).not.toContain("--sandbox=none");
      // Verify prompt security: model prompt must NOT leak secret keys, tokens, or curl instructions
      const printIndex = capture.argv.indexOf("--print");
      const passedPrompt = capture.argv[printIndex + 1];
      expect(passedPrompt).not.toContain("PAPERCLIP_API_KEY");
      expect(passedPrompt).not.toContain("run-jwt-token");
      expect(passedPrompt).not.toContain("Bearer");
      expect(passedPrompt).not.toContain("curl");

      // Verify Paperclip environment injection
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("resumes sessions using --conversation flag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-resume-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agy");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const binPath = await writeFakeAgyCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-agy-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Agent",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "existing-conv-456",
          sessionParams: { sessionId: "existing-conv-456", cwd: workspace },
          sessionDisplayId: "existing-conv-456",
          taskKey: null,
        },
        config: {
          command: binPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Continue work.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--conversation");
      expect(capture.argv).toContain("existing-conv-456");
      expect(capture.argv).not.toContain("--resume");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("recovers automatically from stale or missing conversations by starting a fresh session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-recovery-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agy");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    const binPath = await writeStaleSessionAgyCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-agy-retry",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Antigravity Agent",
          adapterType: "antigravity_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "stale-session-id",
          sessionParams: { sessionId: "stale-session-id", cwd: workspace },
          sessionDisplayId: "stale-session-id",
          taskKey: null,
        },
        config: {
          command: binPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Retry task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("fresh-session-after-retry");

      const captureLines = (await fs.readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      expect(captureLines).toHaveLength(2);
      // First attempt included stale conversation
      expect(captureLines[0].argv).toContain("--conversation");
      expect(captureLines[0].argv).toContain("stale-session-id");
      // Second attempt retried cleanly without conversation
      expect(captureLines[1].argv).not.toContain("--conversation");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
