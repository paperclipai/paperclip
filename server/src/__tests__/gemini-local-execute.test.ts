import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-gemini-local/server";

async function writeFakeGeminiCommand(commandPath: string): Promise<void> {
  const binDir = path.dirname(commandPath);
  const baseName = path.basename(commandPath, path.extname(commandPath));
  const scriptName = process.platform !== "win32" ? baseName : `${baseName}.js`;
  const scriptPath = path.join(binDir, scriptName);
  const cmdPath = path.join(binDir, `${baseName}.cmd`);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

if (process.argv.includes("--help")) {
  console.log("Usage: gemini [options]");
  console.log("Options: --model, --approval-mode, --prompt, --output-format, --resume, --sandbox, stdin");
  process.exit(0);
}

async function run() {
  let stdinContent = "";
  try {
    // Read from stdin if provided (non-blocking enough for small test payloads)
    if (process.stdin.readable) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      stdinContent = Buffer.concat(chunks).toString("utf8");
    }
  } catch (err) {
    // ignore stdin read errors
  }

  const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
  const payload = {
    argv: process.argv.slice(2),
    stdin: stdinContent,
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
}
run();
`;
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
  const cmd = `@"${process.execPath.replace(/\\/g, "\\\\")}" "%~dp0${path.basename(scriptPath)}" %*\r\n`;
  await fs.writeFile(cmdPath, cmd, "utf8");
  await fs.chmod(cmdPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  paperclipEnvKeys: string[];
};

describe("gemini execute", () => {
  it("passes prompt via --prompt and injects paperclip env vars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini.cmd");
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
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptText = promptFlagIndex >= 0 ? capture.argv.slice(promptFlagIndex + 1).join(" ") : (capture.stdin ?? "");
      
      if (promptFlagIndex >= 0) {
        expect(capture.argv).toContain("--prompt");
      }
      expect(capture.argv).toContain("--approval-mode");
      expect(capture.argv).toContain("yolo");
      expect(promptText).toContain("Follow the paperclip heartbeat.");
      expect(promptText).toContain("Paperclip runtime note:");
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
    const commandPath = path.join(root, "gemini.cmd");
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

  it("uses a compact wake delta instead of the full heartbeat prompt when resuming a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-resume-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini.cmd");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeGeminiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-resume",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Gemini Coder",
          adapterType: "gemini_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "gemini-session-1",
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

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const promptFlagIndex = capture.argv.indexOf("--prompt");
      const promptArgFromArgv = promptFlagIndex >= 0 ? capture.argv.slice(promptFlagIndex + 1).join(" ") : "";
      const promptText = promptArgFromArgv || (capture.stdin ?? "");

      expect(capture.argv).toContain("--resume");
      expect(capture.argv).toContain("gemini-session-1");
      expect(promptText).toContain("## Paperclip Resume Delta");
      expect(promptText).toContain("Do not switch to another issue until you have handled this wake.");
      expect(promptText).toContain("Second comment");
      expect(promptText).not.toContain("Follow the paperclip heartbeat.");
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
