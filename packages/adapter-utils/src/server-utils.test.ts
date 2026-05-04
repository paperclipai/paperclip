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
  filterPreparedAgentQmdEnvOverrides,
  materializePaperclipSkillCopy,
  prepareAgentQmdEnvironment,
  renderPaperclipWakePrompt,
  runningProcesses,
  runChildProcess,
  sanitizeSshRemoteEnv,
  shapePaperclipWorkspaceEnvForExecution,
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

async function writeFakeQmdCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.PAPERCLIP_QMD_STATE_PATH;
const args = process.argv.slice(2);
const readState = () => {
  if (!statePath || !fs.existsSync(statePath)) {
    return { path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0, homes: [], sentinels: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
};
const writeState = (state) => {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
};

const state = readState();
state.homes = Array.isArray(state.homes) ? state.homes : [];
state.sentinels = Array.isArray(state.sentinels) ? state.sentinels : [];
state.homes.push(process.env.HOME || null);
state.sentinels.push(process.env.PAPERCLIP_QMD_TEST_SENTINEL || null);
if (args[0] === "collection" && args[1] === "show") {
  if (state.path && state.collectionName === args[2]) {
    writeState(state);
    process.stdout.write("Collection: " + args[2] + "\\n");
    process.stdout.write("  Path:     " + state.path + "\\n");
    process.exit(0);
  }
  writeState(state);
  process.exit(1);
}
if (args[0] === "collection" && args[1] === "remove") {
  state.path = null;
  state.collectionName = null;
  state.removeCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "collection" && args[1] === "add") {
  const nameIndex = args.indexOf("--name");
  state.path = args[2] || null;
  state.collectionName = nameIndex >= 0 ? args[nameIndex + 1] || null : null;
  state.addCount += 1;
  writeState(state);
  process.exit(0);
}
if (args[0] === "update") {
  state.updateCount += 1;
  writeState(state);
  process.exit(0);
}
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("buildInvocationEnvForLogs", () => {
  it("redacts inline secrets from resolved command metadata", () => {
    const loggedEnv = buildInvocationEnvForLogs(
      { SAFE_VALUE: "visible" },
      {
        resolvedCommand: "env OPENAI_API_KEY=*** custom-acp --token ghp_exampleSecret1234567890",
      },
    );

    expect(loggedEnv.SAFE_VALUE).toBe("visible");
    expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toContain("custom-acp --token ***REDACTED***");
    expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).not.toContain("ghp_exampleSecret1234567890");
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
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Start actionable work in this heartbeat");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("do not stop at a plan");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Prefer the smallest verification that proves the change");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Use child issues");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("instead of polling agents, sessions, or processes");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Create child issues directly when you know what needs to be done");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("POST /api/issues/{issueId}/interactions");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("kind suggest_tasks, ask_user_questions, or request_confirmation");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("confirmation:{issueId}:plan:{revisionId}");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain("Wait for acceptance before creating implementation subtasks");
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(
      "Respect budget, pause/cancel, approval gates, and company boundaries",
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

    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("Execution contract: take concrete action in this heartbeat");
    expect(prompt).toContain("use child issues instead of polling");
    expect(prompt).toContain("mark blocked work with the unblock owner/action");
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

    expect(prompt).toContain("dependency-blocked interaction: yes");
    expect(prompt).toContain("respond or triage the human comment");
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

    expect(prompt).toContain("Review request instructions:");
    expect(prompt).toContain("Please focus on edge cases and leave a short risk summary.");
    expect(prompt).toContain("You are waking as the active reviewer for this issue.");
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
    expect(prompt).toContain("Issue continuation summary:");
    expect(prompt).toContain("Integrate child outputs.");
    expect(prompt).toContain("Run liveness continuation:");
    expect(prompt).toContain("- attempt: 2/2");
    expect(prompt).toContain("- source run: run-1");
    expect(prompt).toContain("- liveness state: plan_only");
    expect(prompt).toContain("- reason: Run described future work without concrete action evidence");
    expect(prompt).toContain("- instruction: Take the first concrete action now.");
    expect(prompt).toContain("Direct child issue summaries:");
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

describe("appendWithByteCap", () => {
  it("keeps valid UTF-8 when trimming through multibyte text", () => {
    const output = appendWithByteCap("prefix ", "hello — world", 7);

    expect(output).not.toContain("\uFFFD");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(7);
  });
});

describe("prepareAgentQmdEnvironment", () => {
  it("prefers baseEnv.HOME when resolving the shared qmd cache home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-utils-qmd-home-"));
    const agentHome = path.join(root, "agent-home");
    const sharedHome = path.join(root, "shared-home");
    const binDir = path.join(root, "bin");
    const qmdPath = path.join(binDir, "qmd");
    const qmdStatePath = path.join(root, "qmd-state.json");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(path.join(sharedHome, ".cache", "qmd", "models"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeQmdCommand(qmdPath);
    await fs.writeFile(
      qmdStatePath,
      JSON.stringify({ path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 }),
      "utf8",
    );

    const previousStatePath = process.env.PAPERCLIP_QMD_STATE_PATH;
    process.env.PAPERCLIP_QMD_STATE_PATH = qmdStatePath;
    try {
      const prepared = await prepareAgentQmdEnvironment(agentHome, {
        baseEnv: { HOME: sharedHome },
        qmdCommand: qmdPath,
      });

      expect(prepared.cacheHome).toBe(path.join(agentHome, ".cache"));
      expect(await fs.realpath(path.join(agentHome, ".cache", "qmd", "models"))).toBe(
        await fs.realpath(path.join(sharedHome, ".cache", "qmd", "models")),
      );

      const qmdState = JSON.parse(await fs.readFile(qmdStatePath, "utf8")) as {
        homes: Array<string | null>;
      };
      expect(qmdState.homes).toEqual([sharedHome, sharedHome]);
    } finally {
      if (previousStatePath === undefined) delete process.env.PAPERCLIP_QMD_STATE_PATH;
      else process.env.PAPERCLIP_QMD_STATE_PATH = previousStatePath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps process env available to qmd bootstrap when baseEnv is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-utils-qmd-env-"));
    const agentHome = path.join(root, "agent-home");
    const binDir = path.join(root, "bin");
    const qmdPath = path.join(binDir, "qmd");
    const qmdStatePath = path.join(root, "qmd-state.json");
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeQmdCommand(qmdPath);
    await fs.writeFile(
      qmdStatePath,
      JSON.stringify({ path: null, collectionName: null, addCount: 0, removeCount: 0, updateCount: 0 }),
      "utf8",
    );

    const previousStatePath = process.env.PAPERCLIP_QMD_STATE_PATH;
    const previousSentinel = process.env.PAPERCLIP_QMD_TEST_SENTINEL;
    process.env.PAPERCLIP_QMD_STATE_PATH = qmdStatePath;
    process.env.PAPERCLIP_QMD_TEST_SENTINEL = "sentinel-from-process-env";
    try {
      await prepareAgentQmdEnvironment(agentHome, {
        qmdCommand: qmdPath,
      });

      const qmdState = JSON.parse(await fs.readFile(qmdStatePath, "utf8")) as {
        sentinels: Array<string | null>;
      };
      expect(qmdState.sentinels).toEqual([
        "sentinel-from-process-env",
        "sentinel-from-process-env",
      ]);
    } finally {
      if (previousStatePath === undefined) delete process.env.PAPERCLIP_QMD_STATE_PATH;
      else process.env.PAPERCLIP_QMD_STATE_PATH = previousStatePath;
      if (previousSentinel === undefined) delete process.env.PAPERCLIP_QMD_TEST_SENTINEL;
      else process.env.PAPERCLIP_QMD_TEST_SENTINEL = previousSentinel;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("filterPreparedAgentQmdEnvOverrides", () => {
  it("preserves prepared qmd paths while leaving unrelated overrides intact", () => {
    expect(
      filterPreparedAgentQmdEnvOverrides(
        {
          HOME: "/tmp/shared-home",
          QMD_CONFIG_DIR: "/tmp/manual-config",
          XDG_CACHE_HOME: "/tmp/manual-cache",
          NODE_LLAMA_CPP_GPU: "true",
        },
        true,
      ),
    ).toEqual({
      HOME: "/tmp/shared-home",
      NODE_LLAMA_CPP_GPU: "true",
    });
  });

  it("leaves overrides untouched when no prepared qmd env exists", () => {
    expect(
      filterPreparedAgentQmdEnvOverrides(
        {
          QMD_CONFIG_DIR: "/tmp/manual-config",
          XDG_CACHE_HOME: "/tmp/manual-cache",
        },
        false,
      ),
    ).toEqual({
      QMD_CONFIG_DIR: "/tmp/manual-config",
      XDG_CACHE_HOME: "/tmp/manual-cache",
    });
  });
});
