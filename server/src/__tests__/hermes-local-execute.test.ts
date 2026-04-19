import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "hermes-paperclip-adapter/server";

async function writeFakeHermesCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  argv: process.argv.slice(2),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log("hello from hermes");
console.log("session_id: hermes-session-1");
console.log("tokens: 12 input 3 output");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
};

// Preserved from the detached inference-lab worktree.
// Enable once the Hermes adapter exposes prompt metrics and prompt-budget rebuilding
// behavior comparable to the other local adapters.
describe.skip("hermes execute", () => {
  it("emits prompt token telemetry in adapter meta", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "hermes");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeHermesCommand(commandPath);

    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-hermes-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes Agent",
          adapterType: "hermes_local",
          adapterConfig: {
            hermesCommand: commandPath,
            cwd: workspace,
            promptTemplate: "Follow the paperclip heartbeat.",
          },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {},
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage ?? null).toBeNull();
      expect(promptMetrics.promptChars).toBeGreaterThan(0);
      expect(promptMetrics.estimatedInputTokens).toBeGreaterThan(0);
      expect(promptMetrics.promptBudgetTokens).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds an oversized resumed wake prompt before spawning Hermes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-resume-budget-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "hermes");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeHermesCommand(commandPath);

    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-hermes-budget",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes Agent",
          adapterType: "hermes_local",
          adapterConfig: {
            hermesCommand: commandPath,
            cwd: workspace,
            env: {
              PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Follow the paperclip heartbeat.\n\n" + "x".repeat(220000),
          },
        },
        runtime: {
          sessionId: null,
          sessionParams: {
            sessionId: "hermes-session-previous",
          },
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {},
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
        onMeta: async (meta) => {
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage ?? null).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toContain("--resume");
      expect(capture.argv).toContain("hermes-session-previous");
      expect(capture.argv.some((value) => value.includes("Follow the paperclip heartbeat."))).toBe(false);
      expect(capture.argv.some((value) => value.includes("Second comment"))).toBe(true);
      expect(promptMetrics.promptBudgetTriggered).toBe(1);
      expect(promptMetrics.rebuiltPromptChars).toBeGreaterThan(0);
      expect(promptMetrics.rebuiltPromptChars).toBeLessThan(promptMetrics.promptChars ?? 0);
      expect(promptMetrics.estimatedInputTokens).toBeLessThanOrEqual(promptMetrics.promptBudgetTokens ?? 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
