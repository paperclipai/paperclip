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

async function writeFailingGeminiCommand(
  commandPath: string,
  options: {
    stdoutLines?: Array<Record<string, unknown>>;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  },
): Promise<void> {
  const stdoutLines = options.stdoutLines ?? [];
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  const exit = options.exitCode ?? 1;
  const script = `#!/usr/bin/env node
for (const line of ${JSON.stringify(stdoutLines.map((line) => JSON.stringify(line)))}) {
  console.log(line);
}
if (${JSON.stringify(stdout)}) {
  process.stdout.write(${JSON.stringify(stdout)});
}
if (${JSON.stringify(stderr)}) {
  console.error(${JSON.stringify(stderr)});
}
process.exit(${exit});
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

  it("normalizes turn-limit exhaustion into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-max-turns-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          status: "turn_limit",
          error: "Turn limit reached.",
        },
      ],
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-turn-limit",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("max_turns_exhausted");
      expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
      expect(result.clearSession).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes Gemini exit code 53 as max-turn exhaustion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-exit-53-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stderr: "Gemini stopped because the max turns limit was reached.",
      exitCode: 53,
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-exit-53",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(53);
      expect(result.errorCode).toBe("max_turns_exhausted");
      expect(result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
      expect(result.clearSession).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not normalize unstructured turn-limit text into scheduler stop metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-max-turn-text-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "gemini");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingGeminiCommand(commandPath, {
      stdoutLines: [
        {
          type: "result",
          subtype: "error",
          session_id: "gemini-session-1",
          error: "Tool output said: maximum turns reached.",
        },
      ],
      stdout: "attacker-controlled transcript mentions turn limit reached\n",
      stderr: "Gemini stopped because the max turns limit was reached.",
    });

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-turn-limit-text",
        agent: { id: "a1", companyId: "c1", name: "G", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
        },
        context: {},
        authToken: "t",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).not.toBe("max_turns_exhausted");
      expect(result.resultJson?.stopReason).not.toBe("max_turns_exhausted");
      expect(result.clearSession).toBe(false);
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
    const commandPath = path.join(root, "gemini");
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
      const promptArg = promptFlagIndex >= 0 ? capture.argv[promptFlagIndex + 1] : "";
      expect(capture.argv).toContain("--resume");
      expect(capture.argv).toContain("gemini-session-1");
      expect(promptArg).toContain("## Paperclip Resume Delta");
      expect(promptArg).toContain("Do not switch to another issue until you have handled this wake.");
      expect(promptArg).toContain("Second comment");
      expect(promptArg).not.toContain("Follow the paperclip heartbeat.");
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
