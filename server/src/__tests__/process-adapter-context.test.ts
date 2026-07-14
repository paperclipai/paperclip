import { describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  name: "deterministic-controller",
  adapterType: "process",
  adapterConfig: {},
};

function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "33333333-3333-4333-8333-333333333333",
    agent: AGENT,
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PAPERCLIP_')))))",
      ],
      cwd: process.cwd(),
      timeoutSec: 10,
      graceSec: 1,
    },
    context: {},
    onLog: async () => undefined,
    ...overrides,
  };
}

function output(result: Awaited<ReturnType<typeof execute>>): Record<string, string> {
  expect(result.exitCode).toBe(0);
  const stdout = result.resultJson?.stdout;
  expect(typeof stdout).toBe("string");
  return JSON.parse(String(stdout)) as Record<string, string>;
}

describe("process adapter Paperclip context", () => {
  it("injects runtime-owned run and task identity after configured env", async () => {
    const result = await execute(context({
      context: { taskId: " 44444444-4444-4444-8444-444444444444 " },
      config: {
        ...context().config,
        env: {
          PAPERCLIP_AGENT_ID: "spoofed-agent",
          PAPERCLIP_COMPANY_ID: "spoofed-company",
          PAPERCLIP_RUN_ID: "spoofed-run",
          PAPERCLIP_TASK_ID: "spoofed-task",
          PAPERCLIP_API_URL: "http://127.0.0.1:19001",
        },
      },
    }));

    expect(output(result)).toMatchObject({
      PAPERCLIP_AGENT_ID: AGENT.id,
      PAPERCLIP_COMPANY_ID: AGENT.companyId,
      PAPERCLIP_RUN_ID: "33333333-3333-4333-8333-333333333333",
      PAPERCLIP_TASK_ID: "44444444-4444-4444-8444-444444444444",
      PAPERCLIP_API_URL: "http://127.0.0.1:19001",
    });
  });

  it("falls back to issueId and removes an untrusted task id when no wake task exists", async () => {
    const withIssue = output(await execute(context({
      context: { issueId: "55555555-5555-4555-8555-555555555555" },
    })));
    expect(withIssue.PAPERCLIP_TASK_ID).toBe("55555555-5555-4555-8555-555555555555");

    const withoutIssue = output(await execute(context({
      config: {
        ...context().config,
        env: { PAPERCLIP_TASK_ID: "spoofed-task" },
      },
    })));
    expect(withoutIssue).not.toHaveProperty("PAPERCLIP_TASK_ID");
    expect(withoutIssue.PAPERCLIP_RUN_ID).toBe("33333333-3333-4333-8333-333333333333");
  });
});
