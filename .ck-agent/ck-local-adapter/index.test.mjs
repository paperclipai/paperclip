import test from "node:test";
import assert from "node:assert/strict";
import { createServerAdapter, resolveCommandArgs } from "./index.js";

test("uses the CK runner when an agent omits command arguments", () => {
  assert.deepEqual(resolveCommandArgs({}), ["/work/.ck-agent/runner.mjs"]);
  assert.deepEqual(resolveCommandArgs({ args: [] }), ["/work/.ck-agent/runner.mjs"]);
  assert.deepEqual(resolveCommandArgs({ args: ["custom.mjs"] }), ["custom.mjs"]);
});

test("returns metered DeepSeek usage and exact cost from the runner summary", async () => {
  const adapter = createServerAdapter();
  const summary = {
    ck_runner: true,
    action: "delivered",
    tokens: 1_100,
    usage: { inputTokens: 700, cachedInputTokens: 300, outputTokens: 100 },
    costUsd: 0.0003920875,
  };
  const result = await adapter.execute({
    runId: "test-run",
    agent: { id: "test-agent", companyId: "test-company" },
    config: {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(summary))})`],
      cwd: process.cwd(),
      env: { CK_MODEL: "deepseek-v4-pro" },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.biller, "deepseek");
  assert.equal(result.billingType, "metered_api");
  assert.equal(result.model, "deepseek-v4-pro");
  assert.deepEqual(result.usage, {
    inputTokens: 700,
    cachedInputTokens: 300,
    outputTokens: 100,
  });
  assert.equal(result.costUsd, 0.0003920875);
});

test("preserves per-model cost attribution for mixed Pro and Flash runs", async () => {
  const adapter = createServerAdapter();
  const summary = {
    ck_runner: true,
    action: "delivered",
    usage: { inputTokens: 1_000, cachedInputTokens: 300, outputTokens: 150 },
    costUsd: 0.0005,
    costBreakdown: [
      {
        provider: "deepseek",
        biller: "deepseek",
        billingType: "metered_api",
        model: "deepseek-v4-pro",
        usage: { inputTokens: 700, cachedInputTokens: 200, outputTokens: 100 },
        costUsd: 0.0004,
      },
      {
        provider: "deepseek",
        biller: "deepseek",
        billingType: "metered_api",
        model: "deepseek-v4-flash",
        usage: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 },
        costUsd: 0.0001,
      },
    ],
  };
  const result = await adapter.execute({
    runId: "mixed-model-run",
    agent: { id: "test-agent", companyId: "test-company" },
    config: {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(summary))})`],
      cwd: process.cwd(),
      model: "deepseek-v4-pro",
      env: {},
    },
  });

  assert.equal(result.model, "deepseek-v4-pro");
  assert.deepEqual(result.costBreakdown, summary.costBreakdown);
  assert.equal(
    result.costBreakdown.reduce((sum, entry) => sum + entry.costUsd, 0),
    result.costUsd,
  );
});

test("native model selection reaches the CK runner environment", async () => {
  const adapter = createServerAdapter();
  const result = await adapter.execute({
    runId: "flash-model-run",
    agent: { id: "test-agent", companyId: "test-company" },
    config: {
      command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({ck_runner:true,model:process.env.CK_MODEL,tokens:1}))'],
      cwd: process.cwd(),
      model: "deepseek-v4-flash",
      env: { CK_MODEL: "deepseek-v4-pro" },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.resultJson.stdout, /"model":"deepseek-v4-flash"/);
  assert.equal(result.model, "deepseek-v4-flash");
});

test("native wake context reaches the CK runner environment", async () => {
  const adapter = createServerAdapter();
  const result = await adapter.execute({
    runId: "feedback-run",
    agent: { id: "test-agent", companyId: "test-company" },
    context: {
      taskId: "issue-feedback",
      wakeReason: "issue_blockers_resolved",
      wakeCommentId: "comment-1",
      resolvedBlockerIssueId: "research-issue-1",
    },
    config: {
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ck_runner:true,tokens:1,task:process.env.PAPERCLIP_TASK_ID,reason:process.env.PAPERCLIP_WAKE_REASON,comment:process.env.PAPERCLIP_WAKE_COMMENT_ID,blocker:process.env.PAPERCLIP_RESOLVED_BLOCKER_ISSUE_ID}))",
      ],
      cwd: process.cwd(),
      env: {},
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.resultJson.stdout, /"task":"issue-feedback"/);
  assert.match(result.resultJson.stdout, /"reason":"issue_blockers_resolved"/);
  assert.match(result.resultJson.stdout, /"comment":"comment-1"/);
  assert.match(result.resultJson.stdout, /"blocker":"research-issue-1"/);
});

test("keeps backward compatibility with total-token-only summaries", async () => {
  const adapter = createServerAdapter();
  const result = await adapter.execute({
    runId: "legacy-run",
    agent: { id: "test-agent", companyId: "test-company" },
    config: {
      command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({ck_runner:true,tokens:42}))'],
      cwd: process.cwd(),
      env: {},
    },
  });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 42 });
  assert.equal(result.costUsd, undefined);
});

test("preserves billed usage when the runner fails after inference", async () => {
  const adapter = createServerAdapter();
  const summary = {
    ck_runner: true,
    action: "failed",
    usage: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50 },
    costUsd: 0.0004356125,
  };
  const result = await adapter.execute({
    runId: "failed-run",
    agent: { id: "test-agent", companyId: "test-company" },
    config: {
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(summary))});process.exit(1)`],
      cwd: process.cwd(),
      env: { CK_MODEL: "deepseek-v4-pro" },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.usage, { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50 });
  assert.equal(result.costUsd, 0.0004356125);
});
