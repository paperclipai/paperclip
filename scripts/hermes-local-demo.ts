#!/usr/bin/env -S node --import tsx
import process from "node:process";
import {
  API_BASE,
  createAgent,
  createCompany,
  createIssue,
  formatJson,
  getAgents,
  getCompanies,
  getHeartbeatRun,
  getHeartbeatRunEvents,
  getHeartbeatRunLog,
  getHeartbeatRuns,
  getIssue,
  getIssueComments,
  makeTimestampSlug,
  section,
  sleep,
  step,
  success,
  truncate,
  warn,
  fail,
} from "./hermes-local-common.ts";

interface DemoOptions {
  companyName: string;
  issueTitle: string;
  timeoutMs: number;
  pollIntervalMs: number;
  companyId: string | null;
  agentId: string | null;
  agentName: string;
}

interface ResolvedCompany {
  id: string;
  name: string;
  mode: "created" | "reused";
}

interface ResolvedAgent {
  id: string;
  name: string;
  mode: "created" | "reused";
}

function parseArgs(argv: string[]): DemoOptions {
  const timestamp = makeTimestampSlug();
  const options: DemoOptions = {
    companyName: `Hermes Paperclip Demo ${timestamp}`,
    issueTitle: `Paperclip Hermes demo issue ${timestamp}`,
    timeoutMs: 180_000,
    pollIntervalMs: 5_000,
    companyId: null,
    agentId: null,
    agentName: "Hermes Worker",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--company-name" && next) {
      options.companyName = next;
      index += 1;
      continue;
    }
    if (arg === "--issue-title" && next) {
      options.issueTitle = next;
      index += 1;
      continue;
    }
    if (arg === "--company-id" && next) {
      options.companyId = next;
      index += 1;
      continue;
    }
    if (arg === "--agent-id" && next) {
      options.agentId = next;
      index += 1;
      continue;
    }
    if (arg === "--agent-name" && next) {
      options.agentName = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-sec" && next) {
      options.timeoutMs = Number(next) * 1000;
      index += 1;
      continue;
    }
    if (arg === "--poll-sec" && next) {
      options.pollIntervalMs = Number(next) * 1000;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (options.agentId && !options.companyId) {
    fail("使用 --agent-id 时必须同时提供 --company-id。");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    fail("--timeout-sec 必须是正数。");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    fail("--poll-sec 必须是正数。");
  }
  return options;
}

function printHelp(): void {
  console.log(`Paperclip + Hermes 一键 demo

默认模式：创建临时 company + agent，再创建 demo issue。
回归模式：传入既有 company/agent，复用既有环境只创建 demo issue。

Options:
  --company-id <id>       复用已有 company
  --agent-id <id>         复用已有 agent（需与 --company-id 一起使用）
  --company-name <name>   临时创建 company 时使用的名称
  --agent-name <name>     创建新 agent 时使用的名称，默认 Hermes Worker
  --issue-title <title>   指定 demo issue 标题
  --timeout-sec <sec>     最大等待秒数，默认 180
  --poll-sec <sec>        轮询间隔秒数，默认 5
`);
}

async function resolveCompany(options: DemoOptions): Promise<ResolvedCompany> {
  if (!options.companyId) {
    step("创建临时 demo company");
    const company = await createCompany({
      name: options.companyName,
      description: "Temporary local company for Paperclip + Hermes one-click demo",
      budgetMonthlyCents: 0,
    });
    success(`company 已创建：${company.name} (${company.id})`);
    return { id: company.id, name: company.name, mode: "created" };
  }

  step(`复用已有 company：${options.companyId}`);
  const companies = await getCompanies();
  const company = companies.find((item) => item.id === options.companyId);
  if (!company) {
    fail(`未找到 company：${options.companyId}`);
  }
  success(`company 已复用：${company.name} (${company.id})`);
  return { id: company.id, name: company.name, mode: "reused" };
}

async function resolveAgent(companyId: string, options: DemoOptions): Promise<ResolvedAgent> {
  if (!options.agentId) {
    step("创建 hermes_local demo agent");
    const agent = await createAgent(companyId, {
      name: options.agentName,
      role: "general",
      title: "One-click local Paperclip/Hermes demo agent",
      adapterType: "hermes_local",
      adapterConfig: {
        paperclipApiUrl: API_BASE,
        toolsets: "terminal,file",
        timeoutSec: 120,
        graceSec: 10,
        persistSession: false,
        verbose: false,
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
    });
    success(`agent 已创建：${agent.name} (${agent.id})`);
    return { id: agent.id, name: agent.name, mode: "created" };
  }

  step(`复用已有 agent：${options.agentId}`);
  const agents = await getAgents(companyId);
  const agent = agents.find((item) => item.id === options.agentId);
  if (!agent) {
    fail(`在 company ${companyId} 下未找到 agent：${options.agentId}`);
  }
  if (agent.adapterType !== "hermes_local") {
    fail(`agent ${agent.id} 的 adapterType 不是 hermes_local，而是 ${agent.adapterType}`);
  }
  success(`agent 已复用：${agent.name} (${agent.id})`);
  return { id: agent.id, name: agent.name, mode: "reused" };
}

async function waitForExecutionRun(companyId: string, agentId: string, issueId: string, timeoutMs: number, pollMs: number) {
  const start = Date.now();
  let lastSeenRunId: string | null = null;

  while (Date.now() - start < timeoutMs) {
    const issue = await getIssue(issueId);
    if (issue.executionRunId) {
      return { issue, runId: issue.executionRunId };
    }

    const runs = await getHeartbeatRuns(companyId, agentId, 20);
    const matchingRun = runs.find((run) => {
      const contextIssueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
      return contextIssueId === issueId;
    });
    if (matchingRun) {
      return { issue, runId: matchingRun.id };
    }

    if (runs.length > 0 && runs[0]?.id !== lastSeenRunId) {
      lastSeenRunId = runs[0]?.id ?? null;
      step(`已观察到最近 heartbeat run：${lastSeenRunId}，继续等待其与 issue 绑定...`);
    }
    await sleep(pollMs);
  }

  fail(`在 ${Math.round(timeoutMs / 1000)} 秒内未等到 issue 绑定 execution run。`);
}

async function waitForRunCompletion(runId: string, timeoutMs: number, pollMs: number) {
  const start = Date.now();
  let previousStatus: string | null = null;

  while (Date.now() - start < timeoutMs) {
    const run = await getHeartbeatRun(runId);
    if (run.status !== previousStatus) {
      previousStatus = run.status;
      step(`run ${runId} 当前状态：${run.status}`);
    }
    if (!["queued", "running"].includes(run.status)) {
      return run;
    }
    await sleep(pollMs);
  }

  fail(`在 ${Math.round(timeoutMs / 1000)} 秒内 run 仍未结束：${runId}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  section("Paperclip + Hermes 一键 demo");
  step(`API base: ${API_BASE}`);
  step(`Demo issue title: ${options.issueTitle}`);
  if (options.companyId) {
    step(`回归模式：复用 company ${options.companyId}${options.agentId ? ` / agent ${options.agentId}` : ""}`);
  } else {
    step(`临时模式：将创建 company ${options.companyName}`);
  }

  const company = await resolveCompany(options);
  const agent = await resolveAgent(company.id, options);

  step("创建并分配 demo issue（将自动触发 assignment wakeup）");
  const issue = await createIssue(company.id, {
    title: options.issueTitle,
    description:
      "这是一个本地一键演示/回归任务。请完成以下动作：\n1. 在此 issue 下发表评论，正文里必须包含 `DEMO_DONE`\n2. 然后把这个 issue 标记为 done\n3. 评论里用中文简要说明你完成了什么\n",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agent.id,
  });
  success(`issue 已创建：${issue.identifier ?? issue.id} (${issue.id})`);

  step("等待 Paperclip 为该 issue 建立 execution run");
  const runBinding = await waitForExecutionRun(company.id, agent.id, issue.id, options.timeoutMs, options.pollIntervalMs);
  success(`已绑定 execution run：${runBinding.runId}`);

  step("等待 run 执行完成");
  const finalRun = await waitForRunCompletion(runBinding.runId, options.timeoutMs, options.pollIntervalMs);
  const finalIssue = await getIssue(issue.id);
  const comments = await getIssueComments(issue.id);
  const log = await getHeartbeatRunLog(finalRun.id, 20000);
  const events = await getHeartbeatRunEvents(finalRun.id);

  const demoComment = comments.find((comment) => comment.body.includes("DEMO_DONE"));

  section("Demo 结果摘要");
  console.log(
    formatJson({
      mode: {
        company: company.mode,
        agent: agent.mode,
      },
      company: { id: company.id, name: company.name },
      agent: { id: agent.id, name: agent.name },
      issue: {
        id: finalIssue.id,
        identifier: finalIssue.identifier,
        status: finalIssue.status,
        executionRunId: finalIssue.executionRunId,
      },
      run: {
        id: finalRun.id,
        status: finalRun.status,
        triggerDetail: finalRun.triggerDetail,
        invocationSource: finalRun.invocationSource,
      },
      commentFound: Boolean(demoComment),
      commentId: demoComment?.id ?? null,
      commentsCount: comments.length,
      eventsCount: events.length,
    }),
  );

  section("Issue comments");
  for (const comment of comments) {
    console.log(`- ${comment.id}: ${truncate(comment.body, 400)}`);
  }

  section("Run log（截断预览）");
  console.log(truncate(log.content, 4000));

  if (finalRun.status !== "succeeded") {
    warn(`run 未成功结束：${finalRun.status}`);
    fail("一键 demo 失败：heartbeat run 未达到 succeeded。");
  }
  if (finalIssue.status !== "done") {
    fail(`一键 demo 失败：issue 最终状态不是 done，而是 ${finalIssue.status}`);
  }
  if (!demoComment) {
    fail("一键 demo 失败：未发现包含 DEMO_DONE 的评论。");
  }

  success("一键 demo 成功：Hermes 已在 Paperclip 中完成 issue 评论并标记 done。");
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  fail(detail);
});
