import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-codex-local/server";

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "hello" },
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
};

describe("codex execute", () => {
  it("keeps --resume while appending the wake comment body to stdin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.CODEX_HOME = path.join(root, ".codex-home");

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Agent",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "thread-existing",
          sessionParams: {
            sessionId: "thread-existing",
            cwd: workspace,
          },
          sessionDisplayId: null,
          taskKey: "issue-1",
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Continue the task.",
        },
        context: {
          issueId: "issue-1",
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          wakeCommentBody: "This is the fresh issue comment that woke the agent.",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("resume");
      expect(capture.argv).toContain("thread-existing");
      expect(capture.prompt).toContain("Continue the task.");
      expect(capture.prompt).toContain("<user_comment>");
      expect(capture.prompt).toContain("This is the fresh issue comment that woke the agent.");
      expect(invocationPrompt).toContain("latest user comment that triggered this wake");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
