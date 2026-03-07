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
  env: {
    AGENT_HOME: process.env.AGENT_HOME || "",
    PAPERCLIP_AGENT_HOME: process.env.PAPERCLIP_AGENT_HOME || "",
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID || "",
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY || "",
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID || "",
    PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID || "",
    PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID || "",
    PAPERCLIP_WAKE_REASON: process.env.PAPERCLIP_WAKE_REASON || "",
    PAPERCLIP_WAKE_COMMENT_ID: process.env.PAPERCLIP_WAKE_COMMENT_ID || "",
    PAPERCLIP_LINKED_ISSUE_IDS: process.env.PAPERCLIP_LINKED_ISSUE_IDS || "",
    PAPERCLIP_WORKSPACE_CWD: process.env.PAPERCLIP_WORKSPACE_CWD || "",
    PAPERCLIP_WORKSPACE_REPO_URL: process.env.PAPERCLIP_WORKSPACE_REPO_URL || "",
    PAPERCLIP_WORKSPACE_REPO_REF: process.env.PAPERCLIP_WORKSPACE_REPO_REF || "",
  },
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "executed" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeAgentHome(agentHome: string, agentName: string): Promise<string> {
  await fs.mkdir(agentHome, { recursive: true });
  await fs.writeFile(
    path.join(agentHome, "AGENTS.md"),
    `You are ${agentName}. Read HEARTBEAT.md, SOUL.md, and TOOLS.md.`,
    "utf8",
  );
  await fs.writeFile(path.join(agentHome, "HEARTBEAT.md"), "# HEARTBEAT\nUse Paperclip.", "utf8");
  await fs.writeFile(path.join(agentHome, "SOUL.md"), "# SOUL\nDeliver work.", "utf8");
  await fs.writeFile(path.join(agentHome, "TOOLS.md"), "# TOOLS\nUse Paperclip APIs.", "utf8");
  return path.join(agentHome, "AGENTS.md");
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  env: Record<string, string>;
};

describe("codex_local execute", () => {
  it("prepends an execution-first heartbeat brief for assigned issue wakes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const agentHome = path.join(root, "agents", "nick-sde-3");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);
    const instructionsFilePath = await writeAgentHome(agentHome, "Nick (SDE-3)");

    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.CODEX_HOME = path.join(root, ".codex");

    let invocationPrompt = "";
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Nick (SDE-3)",
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
          command: commandPath,
          cwd: workspace,
          model: "gpt-5.3-codex",
          instructionsFilePath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          taskId: "issue-123",
          wakeReason: "issue_assigned",
          wakeCommentId: "comment-456",
          issueIds: ["issue-123", "issue-999"],
          paperclipWorkspace: {
            cwd: workspace,
            source: "project_workspace",
            workspaceId: "workspace-1",
            repoUrl: "https://example.com/repo.git",
            repoRef: "main",
          },
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
      expect(capture.prompt).toContain("Paperclip heartbeat directive:");
      expect(capture.prompt).toContain(`Effective agent home: ${agentHome}`);
      expect(capture.prompt).toContain("Wake reason: issue_assigned");
      expect(capture.prompt).toContain("Task / issue ID: issue-123");
      expect(capture.prompt).toContain("Wake comment ID: comment-456");
      expect(capture.prompt).toContain("Linked issue IDs: issue-123, issue-999");
      expect(capture.prompt).toContain("Workspace repo URL: https://example.com/repo.git");
      expect(capture.prompt).toContain("Because wake reason is issue_assigned, this run must not end as bootstrap-only output.");
      expect(capture.prompt).toContain("Never end with phrases such as 'ready for the concrete assignment'");
      expect(capture.prompt).toContain("Do not ask the user for the task again when the task is already present in Paperclip issue/context.");
      expect(capture.prompt).toContain(`Use PAPERCLIP_AGENT_HOME=${agentHome} as the effective agent home for this run.`);
      expect(capture.prompt).toContain("The above agent instructions were loaded from");
      expect(capture.prompt).toContain("Resolve any relative file references from");
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(invocationPrompt).toContain("Paperclip heartbeat directive:");
      expect(capture.env.PAPERCLIP_AGENT_HOME).toBe(agentHome);
      expect(capture.env.PAPERCLIP_TASK_ID).toBe("issue-123");
      expect(capture.env.PAPERCLIP_WAKE_REASON).toBe("issue_assigned");
      expect(capture.env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-456");
      expect(capture.env.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-123,issue-999");
      expect(capture.env.PAPERCLIP_WORKSPACE_CWD).toBe(workspace);
      expect(capture.env.PAPERCLIP_WORKSPACE_REPO_URL).toBe("https://example.com/repo.git");
      expect(capture.env.PAPERCLIP_WORKSPACE_REPO_REF).toBe("main");
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

  it("exports AGENT_HOME from instructions file context and preserves the instructions prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-agent-home-"));
    const workspace = path.join(root, "workspace");
    const agentHome = path.join(root, "agents", "cto");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);
    const instructionsFilePath = await writeAgentHome(agentHome, "CTO");

    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAgentHome = process.env.AGENT_HOME;
    process.env.HOME = root;
    process.env.CODEX_HOME = path.join(root, ".codex");
    process.env.AGENT_HOME = path.join(root, "inherited-parent-agent-home");

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-2",
          companyId: "company-1",
          name: "CTO",
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
          command: commandPath,
          cwd: workspace,
          instructionsFilePath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Coordinate the current Paperclip heartbeat.",
        },
        context: {
          wakeReason: "heartbeat_timer",
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.env.AGENT_HOME).toBe(agentHome);
      expect(capture.env.PAPERCLIP_AGENT_HOME).toBe(agentHome);
      expect(capture.prompt).toContain("Paperclip heartbeat directive:");
      expect(capture.prompt).toContain(`Effective agent home: ${agentHome}`);
      expect(capture.prompt).toContain("Wake reason: heartbeat_timer");
      expect(capture.prompt).toContain("If no direct task context is provided, run the normal heartbeat workflow");
      expect(capture.prompt).toContain(`Use PAPERCLIP_AGENT_HOME=${agentHome} as the effective agent home for this run.`);
      expect(capture.prompt).toContain("You are CTO. Read HEARTBEAT.md, SOUL.md, and TOOLS.md.");
      expect(capture.prompt).toContain(`The above agent instructions were loaded from ${instructionsFilePath}.`);
      expect(capture.prompt).toContain(`Resolve any relative file references from ${agentHome}/.`);
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
      if (previousAgentHome === undefined) {
        delete process.env.AGENT_HOME;
      } else {
        process.env.AGENT_HOME = previousAgentHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
