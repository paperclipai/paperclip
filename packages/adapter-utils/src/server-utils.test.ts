import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipWorkspaceEnv,
  appendWithByteCap,
  buildInvocationEnvForLogs,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensurePathInEnv,
  materializePaperclipSkillCopy,
  pickAllowlistedInheritedEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  runningProcesses,
  runChildProcess,
  sanitizeSshRemoteEnv,
  shapePaperclipWorkspaceEnvForExecution,
  shouldMinimizeAdapterRuntimeSkillNotes,
  capPaperclipInjectedAgentInstructions,
  MAX_ADAPTER_AGENT_INSTRUCTIONS_CHARS_COMMENT_WAKE,
  extractMarkdownH2Headings,
  excerptPaperclipSkillMarkdownBody,
  rewriteWorkspaceCwdEnvVarsForExecution,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForTextMatch(read: () => string, pattern: RegExp, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    const match = value.match(pattern);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read().match(pattern);
}

describe("buildInvocationEnvForLogs", () => {
  it("redacts inline secrets from resolved command metadata", () => {
    const loggedEnv = buildInvocationEnvForLogs(
      { SAFE_VALUE: "visible" },
      {
        resolvedCommand: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
      },
    );

    expect(loggedEnv.SAFE_VALUE).toBe("visible");
    expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(
      "env OPENAI_API_KEY=***REDACTED*** custom-acp --token ***REDACTED***",
    );
  });
});

describe("sanitizeSshRemoteEnv", () => {
  it("drops inherited host shell identity variables for SSH remote execution", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          NVM_DIR: "/Users/local/.nvm",
          TMPDIR: "/var/folders/local/T",
          XDG_CONFIG_HOME: "/Users/local/.config",
        },
      ),
    ).toEqual({
      SAFE_VALUE: "visible",
    });
  });

  it("preserves explicit remote overrides even for filtered key names", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/custom/remote/bin:/usr/bin",
          HOME: "/home/agent",
          TMPDIR: "/tmp",
          SAFE_VALUE: "visible",
        },
        {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          TMPDIR: "/var/folders/local/T",
        },
      ),
    ).toEqual({
      PATH: "/custom/remote/bin:/usr/bin",
      HOME: "/home/agent",
      TMPDIR: "/tmp",
      SAFE_VALUE: "visible",
    });
  });

  it("filters identity keys via case-insensitive match against the inherited env", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          // Caller passed PATH in upper case while the inherited (Windows-style)
          // host env exposes it as Path. The lookup must still treat them as
          // equal so the leaked host PATH gets stripped.
          PATH: "/host/bin:/usr/bin",
          HOME: "/host/home",
        },
        {
          Path: "/host/bin:/usr/bin",
          home: "/host/home",
        },
      ),
    ).toEqual({});
  });

  it("preserves explicitly-set identity keys when the inherited env disagrees in case but not in value", () => {
    expect(
      sanitizeSshRemoteEnv(
        {
          PATH: "/explicit/remote/bin",
        },
        {
          Path: "/host/bin:/usr/bin",
        },
      ),
    ).toEqual({ PATH: "/explicit/remote/bin" });
  });
});

describe("materializePaperclipSkillCopy", () => {
  it("refuses to materialize into an ancestor of the source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "parent", "skill");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");

      await expect(materializePaperclipSkillCopy(source, path.join(root, "parent"))).rejects.toThrow(
        /ancestor/,
      );
      await expect(fs.readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe("# skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete and recopy an unchanged materialized skill target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");

      const first = await materializePaperclipSkillCopy(source, target);
      expect(first.copiedFiles).toBe(1);
      await fs.writeFile(path.join(target, "local-marker.txt"), "keep\n", "utf8");

      const second = await materializePaperclipSkillCopy(source, target);
      expect(second.copiedFiles).toBe(0);
      await expect(fs.readFile(path.join(target, "local-marker.txt"), "utf8")).resolves.toBe("keep\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("breaks stale materialization locks left by dead processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-copy-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      const lock = `${target}.lock`;
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");
      await fs.mkdir(lock, { recursive: true });
      await fs.writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" }),
        "utf8",
      );

      await expect(materializePaperclipSkillCopy(source, target)).resolves.toMatchObject({ copiedFiles: 1 });
      await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe("# skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("pickAllowlistedInheritedEnv", () => {
  it("keeps allowlisted keys and drops unrelated host secrets", () => {
    const base = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-test",
      MY_OTHER_PROJECT_SECRET: "nope",
      CODEBUDDY_BASE_URL: "https://example",
      UNRELATED: "x",
    } as NodeJS.ProcessEnv;
    const picked = pickAllowlistedInheritedEnv(base);
    expect(picked.PATH).toBe("/usr/bin");
    expect(picked.OPENAI_API_KEY).toBe("sk-test");
    expect(picked.CODEBUDDY_BASE_URL).toBe("https://example");
    expect(picked.MY_OTHER_PROJECT_SECRET).toBeUndefined();
    expect(picked.UNRELATED).toBeUndefined();
  });

  it("ignores empty strings", () => {
    const base = { PATH: "", OPENAI_API_KEY: "ok" } as NodeJS.ProcessEnv;
    const picked = pickAllowlistedInheritedEnv(base);
    expect(picked.PATH).toBeUndefined();
    expect(picked.OPENAI_API_KEY).toBe("ok");
  });
});

describe("runChildProcess inherited env allowlist", () => {
  it("does not forward arbitrary host env; adapter opts.env still passes through", async () => {
    const leakKey = `PAPERCLIP_TEST_HOST_LEAK_${randomUUID().replace(/-/g, "")}`;
    const explicitKey = `PAPERCLIP_TEST_EXPLICIT_${randomUUID().replace(/-/g, "")}`;
    const prevLeak = process.env[leakKey];
    process.env[leakKey] = "should-not-appear-in-child";
    try {
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify({ leak: process.env[${JSON.stringify(leakKey)}] ?? null, ex: process.env[${JSON.stringify(explicitKey)}] ?? null }))`,
        ],
        {
          cwd: process.cwd(),
          env: { [explicitKey]: "from-adapter" },
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { leak: string | null; ex: string | null };
      expect(parsed.leak).toBeNull();
      expect(parsed.ex).toBe("from-adapter");
    } finally {
      if (prevLeak === undefined) delete process.env[leakKey];
      else process.env[leakKey] = prevLeak;
    }
  });
});

describe("runChildProcess", () => {
  it("does not arm a timeout when timeoutSec is 0", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 150);"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done");
  });

  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });

  it.skipIf(process.platform === "win32")("kills descendant processes on timeout via the process group", async () => {
    let descendantPid: number | null = null;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 1,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {},
      },
    );

    descendantPid = Number.parseInt(result.stdout.trim(), 10);
    expect(result.timedOut).toBe(true);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    expect(await waitForPidExit(descendantPid!, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cleans up a lingering process group after terminal output and child exit", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const descendantPid = Number.parseInt(result.stdout.match(/descendant:(\d+)/)?.[1] ?? "", 10);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await waitForPidExit(descendantPid, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cleans up a still-running child after terminal output", async () => {
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\\n`);",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout).toContain('"type":"result"');
  });

  it.skipIf(process.platform === "win32")("does not clean up noisy runs that have no terminal output", async () => {
    const runId = randomUUID();
    let observed = "";
    const resultPromise = runChildProcess(
      runId,
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', \"setInterval(() => process.stdout.write('noise\\\\n'), 50)\"], { stdio: ['ignore', 'inherit', 'ignore'] });",
          "process.stdout.write(`descendant:${child.pid}\\n`);",
          "setTimeout(() => process.exit(0), 25);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        onLog: async (_stream, chunk) => {
          observed += chunk;
        },
        terminalResultCleanup: {
          graceMs: 50,
          hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"'),
        },
      },
    );

    const pidMatch = await waitForTextMatch(() => observed, /descendant:(\d+)/);
    const descendantPid = Number.parseInt(pidMatch?.[1] ?? "", 10);
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);

    const race = await Promise.race([
      resultPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(race).toBe("pending");
    expect(isPidAlive(descendantPid)).toBe(true);

    const running = runningProcesses.get(runId) as
      | { child: { kill(signal: NodeJS.Signals): boolean }; processGroupId: number | null }
      | undefined;
    try {
      if (running?.processGroupId) {
        process.kill(-running.processGroupId, "SIGKILL");
      } else {
        running?.child.kill("SIGKILL");
      }
      await resultPromise;
    } finally {
      runningProcesses.delete(runId);
      if (isPidAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Ignore cleanup races.
        }
      }
    }
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("keeps the default local-agent prompt action-oriented", () => {
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("在本次心跳里开始可交付工作");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("不要停在「只出计划、不落地」");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("明确的最终状态");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("liveness");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("`in_progress`");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("优先最小的命令或单测证明改动成立");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("用子事务拆出去");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("不要靠轮询别的智能体、会话或进程来代替推进");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("直接建子事务");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/interactions");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("`suggest_tasks`");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("confirmation:{issueId}:plan:{revisionId}");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("未被接受前不要批量建实现性子事务");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(
      "遵守预算、暂停 / 取消、审批门与公司边界",
    );
  });

  it("adds the execution contract to scoped wake prompts", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-1580",
        title: "Update prompts",
        status: "in_progress",
      },
      commentWindow: {
        requestedCount: 0,
        includedCount: 0,
        missingCount: 0,
      },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("## Paperclip 唤醒负载");
    expect(prompt).toContain("执行契约（唤醒摘要）");
    expect(prompt).toContain("留下可核验进展；结束本心跳前状态明确");
    expect(prompt).toContain("不能单凭它们充当 liveness");
    expect(prompt).toContain("勿轮询会话/进程顶替推进");
  });

  it("renders planning-mode directives for assignment and comment wakes", () => {
    const assignmentPrompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(assignmentPrompt).toContain("- 事务工作模式: planning");
    expect(assignmentPrompt).toContain("只做规划，不要写代码或做实现性工作。");

    const commentPrompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{ id: "comment-1", body: "Revise the plan" }],
      fallbackFetchNeeded: false,
    });

    expect(commentPrompt).toContain("只更新规划，不要写代码或做实现性工作。");
  });

  it("does not render stale accepted-plan continuation guidance for later planning comment wakes", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{ id: "comment-1", body: "Revise the plan" }],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("只更新规划，不要写代码或做实现性工作。");
    expect(prompt).not.toContain("已通过规划后续");
    expect(prompt).not.toContain("仅从已通过的规划中拆分子事务");
  });

  it("renders accepted-plan continuation guidance for planning issues", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("已通过规划后续");
    expect(prompt).toContain("可从已通过规划中创建实现性子事务");
    expect(prompt).toContain("不得在规划事务本体上开始实现性工作");
  });

  it("keeps accepted-plan guidance when stale comment ids have no loaded comments", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        status: "in_progress",
        workMode: "planning",
      },
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      commentIds: ["stale-comment-1"],
      latestCommentId: "stale-comment-1",
      commentWindow: { requestedCount: 1, includedCount: 0, missingCount: 1 },
      comments: [],
      fallbackFetchNeeded: true,
    });

    expect(prompt).toContain("已通过规划后续");
    expect(prompt).toContain("仅从已通过的规划中拆分子事务");
    expect(prompt).not.toContain("只更新规划");
  });

  it("renders dependency-blocked interaction guidance", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "issue-1",
        identifier: "PAP-1703",
        title: "Blocked parent",
        status: "todo",
      },
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: ["blocker-1"],
      unresolvedBlockerSummaries: [
        {
          id: "blocker-1",
          identifier: "PAP-1723",
          title: "Finish blocker",
          status: "todo",
          priority: "medium",
        },
      ],
      commentWindow: {
        requestedCount: 1,
        includedCount: 1,
        missingCount: 0,
      },
      commentIds: ["comment-1"],
      latestCommentId: "comment-1",
      comments: [{ id: "comment-1", body: "hello" }],
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("依赖阻塞交互：是");
    expect(prompt).toContain("回复或分流人类评论");
    expect(prompt).toContain("PAP-1723 Finish blocker (todo)");
  });

  it("renders loose review request instructions for execution handoffs", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "execution_review_requested",
      issue: {
        id: "issue-1",
        identifier: "PAP-2011",
        title: "Review request handoff",
        status: "in_review",
      },
      executionStage: {
        wakeRole: "reviewer",
        stageId: "stage-1",
        stageType: "review",
        currentParticipant: { type: "agent", agentId: "agent-1" },
        returnAssignee: { type: "agent", agentId: "agent-2" },
        reviewRequest: {
          instructions: "Please focus on edge cases and leave a short risk summary.",
        },
        allowedActions: ["approve", "request_changes"],
      },
      fallbackFetchNeeded: false,
    });

    expect(prompt).toContain("评审请求说明:");
    expect(prompt).toContain("Please focus on edge cases and leave a short risk summary.");
    expect(prompt).toContain("你正以本事务活跃 评审者 身份被唤醒。");
  });

  it("includes continuation and child issue summaries in structured wake context", () => {
    const payload = {
      reason: "issue_children_completed",
      issue: {
        id: "parent-1",
        identifier: "PAP-100",
        title: "Integrate child work",
        status: "in_progress",
        priority: "medium",
      },
      continuationSummary: {
        key: "continuation-summary",
        title: "Continuation Summary",
        body: "# Continuation Summary\n\n## Next Action\n\n- Integrate child outputs.",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        reason: "Run described future work without concrete action evidence",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Implement helper",
          status: "done",
          priority: "medium",
          summary: "Added the helper route and tests.",
        },
      ],
    };

    expect(JSON.parse(stringifyPaperclipWakePayload(payload) ?? "{}")).toMatchObject({
      continuationSummary: {
        body: expect.stringContaining("Continuation Summary"),
      },
      livenessContinuation: {
        attempt: 2,
        maxAttempts: 2,
        sourceRunId: "run-1",
        state: "plan_only",
        instruction: "Take the first concrete action now.",
      },
      childIssueSummaries: [
        {
          identifier: "PAP-101",
          summary: "Added the helper route and tests.",
        },
      ],
    });

    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("事务延续摘要:");
    expect(prompt).toContain("Integrate child outputs.");
    expect(prompt).toContain("存活延续：");
    expect(prompt).toContain("- 尝试: 2/2");
    expect(prompt).toContain("- 来源运行: run-1");
    expect(prompt).toContain("- 存活状态: plan_only");
    expect(prompt).toContain("- 原因: Run described future work without concrete action evidence");
    expect(prompt).toContain("- 指示: Take the first concrete action now.");
    expect(prompt).toContain("直接子事务摘要:");
    expect(prompt).toContain("PAP-101 Implement helper (done)");
    expect(prompt).toContain("Added the helper route and tests.");
  });
});

describe("applyPaperclipWorkspaceEnv", () => {
  it("adds shared workspace env vars including AGENT_HOME", () => {
    const env = applyPaperclipWorkspaceEnv(
      {},
      {
        workspaceCwd: "/tmp/workspace",
        workspaceSource: "project_primary",
        workspaceStrategy: "git_worktree",
        workspaceId: "workspace-1",
        workspaceRepoUrl: "https://github.com/paperclipai/paperclip.git",
        workspaceRepoRef: "main",
        workspaceBranch: "feature/test",
        workspaceWorktreePath: "/tmp/worktree",
        agentHome: "/tmp/agent-home",
      },
    );

    expect(env).toEqual({
      PAPERCLIP_WORKSPACE_CWD: "/tmp/workspace",
      PAPERCLIP_WORKSPACE_SOURCE: "project_primary",
      PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
      PAPERCLIP_WORKSPACE_ID: "workspace-1",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/paperclipai/paperclip.git",
      PAPERCLIP_WORKSPACE_REPO_REF: "main",
      PAPERCLIP_WORKSPACE_BRANCH: "feature/test",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/tmp/worktree",
      AGENT_HOME: "/tmp/agent-home",
    });
  });

  it("skips empty workspace env values", () => {
    const env = applyPaperclipWorkspaceEnv(
      {},
      {
        workspaceCwd: "",
        workspaceSource: null,
        agentHome: "",
      },
    );

    expect(env).toEqual({});
  });
});

describe("shapePaperclipWorkspaceEnvForExecution", () => {
  it("rewrites workspace env paths for remote execution", () => {
    const shaped = shapePaperclipWorkspaceEnvForExecution({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/tmp/workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-2",
          cwd: "/tmp/other-workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-3",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
      ],
      executionTargetIsRemote: true,
      executionCwd: "/remote/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/remote/workspace",
      workspaceWorktreePath: null,
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/remote/workspace",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-2",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
        {
          workspaceId: "workspace-3",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
        },
      ],
    });
  });

  it("leaves local execution workspace paths unchanged", () => {
    const workspaceHints = [{ workspaceId: "workspace-1", cwd: "/tmp/workspace" }];
    const shaped = shapePaperclipWorkspaceEnvForExecution({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints,
      executionTargetIsRemote: false,
      executionCwd: "/remote/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/tmp/workspace",
      workspaceWorktreePath: "/tmp/worktree",
      workspaceHints,
    });
  });
});

describe("rewriteWorkspaceCwdEnvVarsForExecution", () => {
  it("rewrites custom *_WORKSPACE_CWD env vars for remote execution", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: true,
      env: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
        RANDOM_WORKSPACE_CWD: "/host/workspace",
        OTHER_ENV: "/host/workspace",
      },
    });

    expect(env).toEqual({
      QA_PROJECT_WORKSPACE_CWD: "/remote/workspace",
      RANDOM_WORKSPACE_CWD: "/remote/workspace",
      OTHER_ENV: "/host/workspace",
    });
  });

  it("does not rewrite matching values for local execution", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: false,
      env: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
        RANDOM_WORKSPACE_CWD_TOKEN: "/host/workspace",
      },
    });

    expect(env).toEqual({
      QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
      RANDOM_WORKSPACE_CWD_TOKEN: "/host/workspace",
    });
  });

  it("only rewrites matching *_WORKSPACE_CWD string values", () => {
    const env = rewriteWorkspaceCwdEnvVarsForExecution({
      workspaceCwd: "/host/workspace",
      executionCwd: "/remote/workspace",
      executionTargetIsRemote: true,
      env: {
        MATCHING_WORKSPACE_CWD: "/host/workspace/.",
        DIFFERENT_WORKSPACE_CWD: "/host/other-workspace",
        BLANK_WORKSPACE_CWD: "   ",
        NON_STRING_WORKSPACE_CWD: 42,
      },
    });

    expect(env).toEqual({
      MATCHING_WORKSPACE_CWD: "/remote/workspace",
      DIFFERENT_WORKSPACE_CWD: "/host/other-workspace",
      BLANK_WORKSPACE_CWD: "   ",
    });
  });
});

describe("refreshPaperclipWorkspaceEnvForExecution", () => {
  it("rewrites Paperclip workspace env to the prepared remote runtime cwd", () => {
    const env: Record<string, string> = {
      PAPERCLIP_WORKSPACE_CWD: "/remote/workspace",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/host/worktree",
      PAPERCLIP_WORKSPACES_JSON: JSON.stringify([
        { workspaceId: "workspace-1", cwd: "/remote/workspace" },
        { workspaceId: "workspace-2", cwd: "/tmp/other" },
      ]),
      QA_PROJECT_WORKSPACE_CWD: "/remote/workspace",
    };

    const shaped = refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: {
        QA_PROJECT_WORKSPACE_CWD: "/host/workspace",
      },
      workspaceCwd: "/host/workspace",
      workspaceWorktreePath: "/host/worktree",
      workspaceHints: [
        { workspaceId: "workspace-1", cwd: "/host/workspace" },
        { workspaceId: "workspace-2", cwd: "/tmp/other" },
      ],
      executionTargetIsRemote: true,
      executionCwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
    });

    expect(shaped).toEqual({
      workspaceCwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      workspaceWorktreePath: null,
      workspaceHints: [
        {
          workspaceId: "workspace-1",
          cwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
        },
        {
          workspaceId: "workspace-2",
        },
      ],
    });
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe("/remote/workspace/.paperclip-runtime/runs/run-1/workspace");
    expect(env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(env.QA_PROJECT_WORKSPACE_CWD).toBe("/remote/workspace/.paperclip-runtime/runs/run-1/workspace");
    expect(JSON.parse(env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      },
      {
        workspaceId: "workspace-2",
      },
    ]);
  });
});

describe("shouldMinimizeAdapterRuntimeSkillNotes", () => {
  it("minimizes when resuming a session", () => {
    expect(shouldMinimizeAdapterRuntimeSkillNotes({}, true)).toBe(true);
    expect(shouldMinimizeAdapterRuntimeSkillNotes({ commentWakeTier: "allow_repo_write" }, true)).toBe(true);
  });

  it("minimizes for low comment wake tiers", () => {
    expect(shouldMinimizeAdapterRuntimeSkillNotes({ commentWakeTier: "receipt_only" }, false)).toBe(true);
    expect(shouldMinimizeAdapterRuntimeSkillNotes({ commentWakeTier: "read_thread" }, false)).toBe(true);
    expect(shouldMinimizeAdapterRuntimeSkillNotes({ commentWakeTier: "allow_api_context" }, false)).toBe(true);
  });

  it("does not minimize for higher tiers when not resuming", () => {
    expect(shouldMinimizeAdapterRuntimeSkillNotes({ commentWakeTier: "allow_full_skills" }, false)).toBe(false);
  });

  it("does not minimize when tier is absent", () => {
    expect(shouldMinimizeAdapterRuntimeSkillNotes({}, false)).toBe(false);
  });

  it("minimizes for issue_commented when inline wake is complete (fallbackFetchNeeded false)", () => {
    expect(
      shouldMinimizeAdapterRuntimeSkillNotes(
        {
          wakeReason: "issue_commented",
          paperclipWake: {
            issue: { id: "issue-1", identifier: "PC-1" },
            fallbackFetchNeeded: false,
            comments: [{ id: "c1", body: "hi" }],
          },
        },
        false,
      ),
    ).toBe(true);
  });
});

describe("045 helpers: headings, excerpt, instructions cap", () => {
  it("extractMarkdownH2Headings collects ## lines only", () => {
    expect(extractMarkdownH2Headings("# T\n## A\n### B\n## C ")).toEqual(["A", "C"]);
  });

  it("excerptPaperclipSkillMarkdownBody strips frontmatter and flattens", () => {
    const md = "---\nx: 1\n---\n\n# Title\n\nPara one.\n\n## H\n\nMore.";
    const ex = excerptPaperclipSkillMarkdownBody(md, 200);
    expect(ex).toContain("Para one");
    expect(ex).not.toContain("---");
  });

  it("capPaperclipInjectedAgentInstructions truncates on minimize path", () => {
    const long = "x".repeat(MAX_ADAPTER_AGENT_INSTRUCTIONS_CHARS_COMMENT_WAKE + 500);
    const capped = capPaperclipInjectedAgentInstructions(
      long,
      { commentWakeTier: "receipt_only" },
      false,
    );
    expect(capped.length).toBe(MAX_ADAPTER_AGENT_INSTRUCTIONS_CHARS_COMMENT_WAKE);
    expect(capped).toContain("[Paperclip]");
  });
});

describe("appendWithByteCap", () => {
  it("keeps valid UTF-8 when trimming through multibyte text", () => {
    const output = appendWithByteCap("prefix ", "hello — world", 7);

    expect(output).not.toContain("\uFFFD");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(7);
  });
});

describe("ensurePathInEnv", () => {
  it.skipIf(process.platform !== "win32")("replaces empty PATHEXT so .cmd shims resolve on PATH", () => {
    const e = ensurePathInEnv({ PATH: "C:\\Windows", PATHEXT: "" });
    expect(e.PATHEXT?.toUpperCase()).toContain(".CMD");
  });
});
