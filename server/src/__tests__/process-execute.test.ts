import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

/**
 * The `process` adapter injects PAPERCLIP_RUN_ID and (guarded) PAPERCLIP_API_KEY
 * already, but it did not forward PAPERCLIP_TASK_ID or the wake-context, so a
 * process agent could not tell which task woke it. These tests pin the adapter
 * to the same wake-context contract the rich `claude-local` adapter provides,
 * and pin the runtime-owned precedence (a static config value must never shadow
 * or leave stale wake context).
 */

// A node script that dumps every PAPERCLIP_* env var the child actually received
// to PAPERCLIP_TEST_CAPTURE_PATH. Launched via process.execPath (node) so the
// harness is portable (no POSIX shebang / executable bit — works on Windows CI).
async function writeEnvCaptureScript(scriptPath: string): Promise<void> {
  const script = `const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const seen = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("PAPERCLIP_")) seen[k] = v;
}
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(seen), "utf8");
process.exit(0);
`;
  await fs.writeFile(scriptPath, script, "utf8");
}

async function setup(): Promise<{
  root: string;
  workspace: string;
  command: string;
  args: string[];
  capturePath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-exec-"));
  const workspace = path.join(root, "workspace");
  const scriptPath = path.join(root, "capture.js");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(workspace, { recursive: true });
  await writeEnvCaptureScript(scriptPath);
  // Launch node explicitly with the script as an argument — portable across OSes.
  return { root, workspace, command: process.execPath, args: [scriptPath], capturePath };
}

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Probe",
  adapterType: "process",
  adapterConfig: {},
};

describe("process execute — wake-context forwarding", () => {
  it("forwards task id and the full wake-context to the child", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      const result = await execute({
        runId: "run-123",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {
          issueId: "issue-123",
          taskId: "task-123",
          wakeReason: "assignment",
          wakeCommentId: "comment-9",
          approvalId: "approval-7",
          approvalStatus: "approved",
          issueIds: ["issue-123", "issue-456"],
          paperclipIssue: { workMode: "standard" },
          paperclipWake: {
            reason: "assignment",
            issue: {
              id: "issue-123",
              identifier: "PAP-1",
              title: "task",
              status: "in_progress",
              priority: "medium",
              workMode: "standard",
            },
            commentIds: [],
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      // the wake-context this change adds
      expect(seen.PAPERCLIP_TASK_ID).toBe("task-123");
      expect(seen.PAPERCLIP_WAKE_REASON).toBe("assignment");
      expect(seen.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-9");
      expect(seen.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-123,issue-456");
      expect(seen.PAPERCLIP_APPROVAL_ID).toBe("approval-7");
      expect(seen.PAPERCLIP_APPROVAL_STATUS).toBe("approved");
      expect(seen.PAPERCLIP_ISSUE_WORK_MODE).toBe("standard");
      expect(seen.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeDefined();
      expect(seen.PAPERCLIP_WAKE_PAYLOAD_JSON).toContain("issue-123");
      // identity already injected before this change, kept as a sanity check
      expect(seen.PAPERCLIP_RUN_ID).toBe("run-123");
      expect(seen.PAPERCLIP_API_KEY).toBe("run-jwt-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives PAPERCLIP_TASK_ID from issueId when taskId is absent", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "run-xyz",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: { issueId: "issue-only" },
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_TASK_ID).toBe("issue-only");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives PAPERCLIP_WAKE_COMMENT_ID from commentId when wakeCommentId is absent", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "run-fallback",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: { taskId: "task-1", commentId: "comment-from-fallback" },
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-from-fallback");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("clean absence — no task id and no empty wake vars when context is empty", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      const result = await execute({
        runId: "run-empty",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_RUN_ID).toBe("run-empty");
      // task id and wake vars must be ABSENT, not empty strings
      expect("PAPERCLIP_TASK_ID" in seen).toBe(false);
      expect("PAPERCLIP_WAKE_REASON" in seen).toBe(false);
      expect("PAPERCLIP_WAKE_COMMENT_ID" in seen).toBe(false);
      expect("PAPERCLIP_LINKED_ISSUE_IDS" in seen).toBe(false);
      expect("PAPERCLIP_APPROVAL_ID" in seen).toBe(false);
      expect("PAPERCLIP_APPROVAL_STATUS" in seen).toBe(false);
      expect("PAPERCLIP_ISSUE_WORK_MODE" in seen).toBe(false);
      expect("PAPERCLIP_WAKE_PAYLOAD_JSON" in seen).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runtime task id / run id win over config-supplied values (identity is runtime-owned)", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "real-run",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            // a static adapter config must NOT be able to shadow the wake identity
            PAPERCLIP_TASK_ID: "config-spoofed-task",
            PAPERCLIP_RUN_ID: "config-spoofed-run",
          },
        },
        context: { taskId: "real-task" },
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_TASK_ID).toBe("real-task");
      expect(seen.PAPERCLIP_RUN_ID).toBe("real-run");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a stale config-supplied wake key when the current wake has no value for it", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "run-stale",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            // static/generic config values that do NOT belong to this wake
            PAPERCLIP_TASK_ID: "stale-config-task",
            PAPERCLIP_WAKE_REASON: "stale-config-reason",
          },
        },
        // the current wake carries no task/reason — the child must not see stale ones
        context: {},
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect("PAPERCLIP_TASK_ID" in seen).toBe(false);
      expect("PAPERCLIP_WAKE_REASON" in seen).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives PAPERCLIP_ISSUE_WORK_MODE from the wake payload issue when paperclipIssue is absent", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "run-wm",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {
          taskId: "task-1",
          paperclipWake: {
            reason: "assignment",
            issue: {
              id: "issue-1",
              identifier: "PAP-2",
              title: "wm",
              status: "in_progress",
              priority: "medium",
              workMode: "plan",
            },
            commentIds: [],
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "tok",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_ISSUE_WORK_MODE).toBe("plan");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("redacts PAPERCLIP_API_KEY in invocation log metadata", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    let loggedEnv: Record<string, string> = {};
    try {
      await execute({
        runId: "run-mask",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: { taskId: "task-1" },
        authToken: "super-secret-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedEnv = (meta.env ?? {}) as Record<string, string>;
        },
      });
      // the credential is never logged in the clear (redaction is by key name)
      expect(loggedEnv.PAPERCLIP_API_KEY).not.toBe("super-secret-token");
      expect(loggedEnv.PAPERCLIP_API_KEY).toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an explicit PAPERCLIP_API_KEY from config", async () => {
    const { root, workspace, command, args, capturePath } = await setup();
    try {
      await execute({
        runId: "run-key",
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command,
          args,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_API_KEY: "explicit-config-key",
          },
        },
        context: { taskId: "task-1" },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async () => {},
      });
      const seen = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
      expect(seen.PAPERCLIP_API_KEY).toBe("explicit-config-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
