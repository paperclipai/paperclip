import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute, hydrateHermesExecutionConfig } from "../adapters/hermes-local.js";

async function writeFakeHermesCommand(commandPath: string, source: string) {
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env node
${source}
`,
    "utf8",
  );
  await fs.chmod(commandPath, 0o755);
}

describe("hermes-local adapter", () => {
  it("maps wake context into the Hermes config shape and injects auth", () => {
    const hydrated = hydrateHermesExecutionConfig(
      {
        promptTemplate: "Continue your Paperclip work.",
        env: {
          PAPERCLIP_API_URL: "http://127.0.0.1:3100/api",
          EXTRA_FLAG: "1",
        },
      },
      {
        issueId: "issue-123",
        taskTitle: "Synthetic Canary",
        wakeCommentId: "comment-456",
        wakeReason: "issue_checked_out",
        projectName: "Blueprint Executive Ops",
      },
      "run-jwt-token",
    );

    expect(hydrated).toMatchObject({
      taskId: "issue-123",
      taskTitle: "Synthetic Canary",
      commentId: "comment-456",
      wakeReason: "issue_checked_out",
      projectName: "Blueprint Executive Ops",
    });
    expect(hydrated.env).toMatchObject({
      PAPERCLIP_API_URL: "http://127.0.0.1:3100/api",
      PAPERCLIP_API_KEY: "run-jwt-token",
      EXTRA_FLAG: "1",
    });
  });

  it("does not overwrite an explicit Hermes API key override", () => {
    const hydrated = hydrateHermesExecutionConfig(
      {
        env: {
          PAPERCLIP_API_KEY: "explicit-token",
        },
      },
      {
        taskId: "issue-999",
      },
      "run-jwt-token",
    );

    expect(hydrated.taskId).toBe("issue-999");
    expect((hydrated.env as Record<string, unknown>).PAPERCLIP_API_KEY).toBe("explicit-token");
  });

  it("pins DeepSeek Anthropic-compatible runs to the DeepSeek key for Hermes children", () => {
    const originalDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";

    try {
      const hydrated = hydrateHermesExecutionConfig(
        {
          model: "deepseek-v4-pro[1m]",
          provider: "anthropic",
          env: {
            ANTHROPIC_TOKEN: "sk-ant-stale-token",
          },
        },
        {
          taskId: "issue-deepseek",
        },
        "run-jwt-token",
      );

      expect(hydrated.env).toMatchObject({
        ANTHROPIC_API_KEY: "sk-deepseek-test",
        ANTHROPIC_TOKEN: "sk-deepseek-test",
        DEEPSEEK_API_KEY: "sk-deepseek-test",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        PAPERCLIP_API_KEY: "run-jwt-token",
      });
    } finally {
      if (originalDeepseekApiKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalDeepseekApiKey;
      }
    }
  });

  it("passes hydrated run config through agent adapterConfig before spawning Hermes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-wrapper-"));
    const commandPath = path.join(root, "hermes");
    const observedPath = path.join(root, "observed.json");

    await writeFakeHermesCommand(
      commandPath,
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("hermes-test 0.0.0");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
  args,
  env: {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID,
    TEST_FLAG: process.env.TEST_FLAG
  }
}));
console.log("ok");
console.log("session_id: sess-wrapper");
`,
    );

    const result = await execute({
      runId: "run-wrapper",
      agent: {
        id: "agent-wrapper",
        companyId: "company-1",
        name: "Hermes Wrapper Agent",
        adapterConfig: {},
      },
      runtime: {},
      context: {
        taskId: "issue-wrapper",
      },
      config: {
        hermesCommand: commandPath,
        cwd: root,
        model: "deepseek-v4-flash",
        provider: "anthropic",
        persistSession: false,
        env: {
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          TEST_FLAG: "expected",
        },
      },
      authToken: "run-jwt-token",
      onLog: async () => {},
    } as never);

    const observed = JSON.parse(await fs.readFile(observedPath, "utf8")) as {
      args: string[];
      env: Record<string, string | undefined>;
    };

    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ session_id: "sess-wrapper" });
    expect(observed.args).toContain("-m");
    expect(observed.args).toContain("deepseek-v4-flash");
    expect(observed.args).toContain("--provider");
    expect(observed.args).toContain("anthropic");
    expect(observed.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      PAPERCLIP_API_KEY: "run-jwt-token",
      PAPERCLIP_TASK_ID: "issue-wrapper",
      TEST_FLAG: "expected",
    });
  });

  it("prepends the bound-task guard into the task body for scoped wakes", () => {
    const hydrated = hydrateHermesExecutionConfig(
      {
        taskBody: "Resolve the assigned Paperclip issue.",
      },
      {
        taskId: "issue-321",
      },
      undefined,
    );

    expect(hydrated.taskBody).toContain("This heartbeat is bound to issue issue-321");
    expect(hydrated.taskBody).toContain("Resolve the assigned Paperclip issue.");
    expect(hydrated.taskBody).toContain("PATCH /api/issues/{id}");
  });
});
