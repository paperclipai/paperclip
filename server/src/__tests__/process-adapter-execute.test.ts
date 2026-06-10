import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

async function writeFakeProcessCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  paperclipRunId: process.env.PAPERCLIP_RUN_ID || null,
  paperclipTaskId: process.env.PAPERCLIP_TASK_ID || null,
  paperclipWakeReason: process.env.PAPERCLIP_WAKE_REASON || null,
  paperclipWakeCommentId: process.env.PAPERCLIP_WAKE_COMMENT_ID || null,
  paperclipApprovalId: process.env.PAPERCLIP_APPROVAL_ID || null,
  paperclipApprovalStatus: process.env.PAPERCLIP_APPROVAL_STATUS || null,
  staticEnvValue: process.env.STATIC_ADAPTER_ENV || null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log("ok");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  paperclipRunId: string | null;
  paperclipTaskId: string | null;
  paperclipWakeReason: string | null;
  paperclipWakeCommentId: string | null;
  paperclipApprovalId: string | null;
  paperclipApprovalStatus: string | null;
  staticEnvValue: string | null;
  paperclipEnvKeys: string[];
};

describe("process adapter execute", () => {
  it("injects per-run PAPERCLIP_* env vars alongside static adapterConfig.env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-env-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "fake-process");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeProcessCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-process-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Process Runner",
          adapterType: "process",
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
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            STATIC_ADAPTER_ENV: "static-value",
          },
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          approvalId: "approval-1",
          approvalStatus: "approved",
        },
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipRunId).toBe("run-process-1");
      expect(capture.paperclipTaskId).toBe("issue-1");
      expect(capture.paperclipWakeReason).toBe("issue_commented");
      expect(capture.paperclipWakeCommentId).toBe("comment-2");
      expect(capture.paperclipApprovalId).toBe("approval-1");
      expect(capture.paperclipApprovalStatus).toBe("approved");
      expect(capture.staticEnvValue).toBe("static-value");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
          "PAPERCLIP_TASK_ID",
          "PAPERCLIP_WAKE_REASON",
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets static adapterConfig.env override per-run vars, matching local adapter precedence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-precedence-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "fake-process");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeProcessCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-process-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Process Runner",
          adapterType: "process",
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
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_WAKE_REASON: "config-override",
          },
        },
        context: {
          taskId: "issue-2",
          wakeReason: "issue_assigned",
        },
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipTaskId).toBe("issue-2");
      expect(capture.paperclipWakeReason).toBe("config-override");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
