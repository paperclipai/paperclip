import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFailingClaudeCommand(
  commandPath: string,
  options: { resultEvent: Record<string, unknown>; exitCode?: number },
): Promise<void> {
  const payload = JSON.stringify(options.resultEvent);
  const exit = options.exitCode ?? 1;
  const script = `#!/usr/bin/env node
console.log(${JSON.stringify(payload)});
process.exit(${exit});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function setupExecuteEnv(root: string) {
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const commandPath = path.join(binDir, "claude");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    workspace, commandPath,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

describe("claude_local transient-upstream terminal reporting", () => {
  it("classifies out-of-extra-usage results as provider quota with the parsed reset time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-report-transient-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    await writeFailingClaudeCommand(commandPath, {
      resultEvent: {
        type: "result",
        subtype: "error",
        session_id: "claude-session-1",
        is_error: true,
        result: "You're out of extra usage · resets 4pm (America/Chicago)",
        errors: [{ type: "rate_limit_error", message: "You're out of extra usage" }],
      },
    });

    const logs: string[] = [];
    const onLog = async (stream: string, chunk: string) => {
      logs.push(chunk);
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 22, 10, 15, 0));

    try {
      const result = await execute({
        runId: "run-claude-report",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          // These tests exercise the classic CLI result-event reporting path;
          // the default engine is now "auto" (ACP preferred), which the fake
          // print-JSON claude script cannot speak.
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog,
      });

      // Fork policy: "out of extra usage" is PROVIDER QUOTA (quota-wait
      // recovery, c65ab09d9), which outranks the old transient-upstream
      // classification this test used to assert. The reset time is still
      // parsed (4pm America/Chicago on the mocked date = 21:00 UTC).
      expect(result.errorCode).toBe("provider_quota");
      expect(result.retryNotBefore).toBe("2026-04-22T21:00:00.000Z");
    } finally {
      vi.useRealTimers();
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports rate-limit errors without reset metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-report-rate-limit-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    await writeFailingClaudeCommand(commandPath, {
      resultEvent: {
        type: "result",
        subtype: "error",
        session_id: "claude-session-1",
        is_error: true,
        result: "Overloaded",
        errors: [{ type: "overloaded_error", message: "Overloaded" }],
      },
    });

    const logs: string[] = [];
    const onLog = async (stream: string, chunk: string) => {
      logs.push(chunk);
    };

    try {
      await execute({
        runId: "run-claude-report-no-reset",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          // These tests exercise the classic CLI result-event reporting path;
          // the default engine is now "auto" (ACP preferred), which the fake
          // print-JSON claude script cannot speak.
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog,
      });

      const allLogs = logs.join("");
      expect(allLogs).toContain("[paperclip] Detected transient upstream error (e.g. rate limit).");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports transient upstream errors even when Claude process exits before result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-report-exit-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    const script = `#!/usr/bin/env node
process.stderr.write("Rate limit reached. Try again later.\\n");
process.exit(1);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);

    const logs: string[] = [];
    const onLog = async (stream: string, chunk: string) => {
      logs.push(chunk);
    };

    try {
      const result = await execute({
        runId: "run-claude-report-exit",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          // These tests exercise the classic CLI result-event reporting path;
          // the default engine is now "auto" (ACP preferred), which the fake
          // print-JSON claude script cannot speak.
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog,
      });

      expect(result.errorCode).toBe("claude_transient_upstream");
      const allLogs = logs.join("");
      expect(allLogs).toContain("[paperclip] Detected transient upstream error (e.g. rate limit).");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies session limit errors as provider quota", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-report-session-limit-"));
    const { workspace, commandPath, restore } = await setupExecuteEnv(root);
    const script = `#!/usr/bin/env node
process.stderr.write("You've hit your session limit.\\n");
process.exit(1);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);

    const logs: string[] = [];
    const onLog = async (stream: string, chunk: string) => {
      logs.push(chunk);
    };

    try {
      const result = await execute({
        runId: "run-claude-report-session-limit",
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          // These tests exercise the classic CLI result-event reporting path;
          // the default engine is now "auto" (ACP preferred), which the fake
          // print-JSON claude script cannot speak.
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Do work.",
        },
        context: {},
        authToken: "tok",
        onLog,
      });

      // Fork policy: session-limit errors are PROVIDER QUOTA (quota-wait
      // recovery). The old aspirational claude_session_limit code was never
      // implemented; the quota classifier owns this class now.
      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
