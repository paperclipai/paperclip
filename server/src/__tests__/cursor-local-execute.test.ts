import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type CapturePayload = {
  argv: string[];
  prompt: string;
  paperclipEnvKeys: string[];
};

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

  it("injects PAPERCLIP_FOCUSED_TASK_MODE when context includes issueId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-focused-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await execute({
        runId: "run-focused-1",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace, model: "auto", env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath }, promptTemplate: "heartbeat" },
        context: { issueId: "issue-abc-123" },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_TASK_ID");
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_FOCUSED_TASK_MODE");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT inject PAPERCLIP_FOCUSED_TASK_MODE when context has no taskId or issueId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-no-focused-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await execute({
        runId: "run-no-focused-1",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace, model: "auto", env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath }, promptTemplate: "heartbeat" },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_TASK_ID");
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_FOCUSED_TASK_MODE");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT inject PAPERCLIP_FOCUSED_TASK_MODE when context.focusedTaskMode is false", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-optout-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await execute({
        runId: "run-optout-1",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace, model: "auto", env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath }, promptTemplate: "heartbeat" },
        context: { issueId: "issue-abc-123", focusedTaskMode: false },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_TASK_ID");
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_FOCUSED_TASK_MODE");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does NOT inject PAPERCLIP_FOCUSED_TASK_MODE when woken by a comment mention (focusedTaskMode disabled by server)", async () => {
    // The heartbeat server sets context.focusedTaskMode = false for issue_comment_mentioned wakes.
    // This test verifies the adapter honours that signal.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-mention-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCursorCommand(commandPath);
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await execute({
        runId: "run-mention-1",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace, model: "auto", env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath }, promptTemplate: "heartbeat" },
        context: { issueId: "issue-abc-123", wakeReason: "issue_comment_mentioned", focusedTaskMode: false },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_TASK_ID");
      expect(capture.paperclipEnvKeys).not.toContain("PAPERCLIP_FOCUSED_TASK_MODE");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
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
});
