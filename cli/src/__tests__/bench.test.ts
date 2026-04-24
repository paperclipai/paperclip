import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadBenchTasks,
  normalizeBenchRunner,
  normalizeBenchTask,
  renderBenchIssueMarkdown,
  runPaperclipBench,
} from "../commands/bench.js";

describe("normalizeBenchTask", () => {
  it("accepts MissionBench-style snake_case fields", () => {
    const task = normalizeBenchTask(
      {
        id: "missionbench-001",
        title: "Add audit logs",
        repo: "github.com/paperclipai/missionbench-saas",
        starting_commit: "abc123",
        problem_statement: "Add organization-level audit logs.",
        time_budget_minutes: 180,
        token_budget_usd: 20,
        success_checks: ["npm test", "npm run typecheck"],
        human_rubric: { architecture: 5, test_quality: 5 },
        required_artifacts: ["implementation patch", "risk notes"],
      },
      { lineLabel: "tasks.jsonl:1" },
    );

    expect(task).toMatchObject({
      id: "missionbench-001",
      title: "Add audit logs",
      problemStatement: "Add organization-level audit logs.",
      repo: {
        url: "github.com/paperclipai/missionbench-saas",
        baseCommit: "abc123",
      },
      maxWallClockMinutes: 180,
      maxCostUsd: 20,
      successChecks: ["npm test", "npm run typecheck"],
      requiredArtifacts: ["implementation patch", "risk notes"],
    });
    expect(task.humanRubric).toEqual([
      { name: "architecture", maxScore: 5 },
      { name: "test_quality", maxScore: 5 },
    ]);
  });

  it("rejects tasks without a problem statement", () => {
    expect(() =>
      normalizeBenchTask(
        {
          id: "missing-problem",
          title: "Missing problem",
        },
        { lineLabel: "tasks.jsonl:2" },
      ),
    ).toThrow(/requires problemStatement/i);
  });

  it("keeps an explicit issue reference for reuse", () => {
    const task = normalizeBenchTask(
      {
        id: "missionbench-002",
        title: "Reuse benchmark issue",
        problem_statement: "Continue work in an existing benchmark issue.",
        paperclip_issue_id: "PAP-42",
      },
      { lineLabel: "tasks.jsonl:3" },
    );

    expect(task.paperclipIssueRef).toBe("PAP-42");
  });
});

describe("normalizeBenchRunner", () => {
  it("accepts prepare and paperclip", () => {
    expect(normalizeBenchRunner(undefined)).toBe("prepare");
    expect(normalizeBenchRunner("prepare")).toBe("prepare");
    expect(normalizeBenchRunner("paperclip")).toBe("paperclip");
  });

  it("rejects unsupported runners", () => {
    expect(() => normalizeBenchRunner("live")).toThrow(/Unsupported bench runner/i);
  });
});

describe("renderBenchIssueMarkdown", () => {
  it("renders a Paperclip-ready task prompt", () => {
    const markdown = renderBenchIssueMarkdown(
      {
        id: "missionbench-001",
        title: "Add audit logs",
        problemStatement: "Add organization-level audit logs.",
        repo: { url: "https://example.com/repo.git", baseCommit: "abc123" },
        maxWallClockMinutes: 120,
        maxCostUsd: 10,
        successChecks: ["npm test"],
        humanRubric: [{ name: "architecture", maxScore: 5 }],
        requiredArtifacts: ["final PR summary"],
      },
      {
        benchmark: "missionbench",
        runId: "run-1",
        model: "anthropic/claude-sonnet-4.5",
        paperclipVersion: "current",
      },
    );

    expect(markdown).toContain("# Add audit logs");
    expect(markdown).toContain("- Task ID: `missionbench-001`");
    expect(markdown).toContain("- URL: https://example.com/repo.git");
    expect(markdown).toContain("- npm test");
    expect(markdown).toContain("- architecture (5 pts)");
  });
});

describe("runPaperclipBench", () => {
  it("writes manifest, per-task prompts, traces, and results", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bench-test-"));
    try {
      const tasksPath = path.join(tmpDir, "tasks.jsonl");
      const outputDir = path.join(tmpDir, "out");
      await writeFile(
        tasksPath,
        `${JSON.stringify({
          id: "task-1",
          title: "Fix checkout",
          problemStatement: "Make checkout idempotent.",
          successChecks: ["pnpm test"],
        })}\n`,
        "utf8",
      );

      const manifest = await runPaperclipBench({
        tasksPath,
        benchmark: "paperclip_native",
        outputDir,
        runId: "test-run",
        paperclipVersion: "current",
        model: "noop",
        runner: "prepare",
        clean: true,
      });

      expect(manifest.taskCount).toBe(1);
      expect(manifest.tasks[0]?.issuePath).toBe("tasks/task-1/issue.md");

      const issueMarkdown = await readFile(path.join(outputDir, "tasks/task-1/issue.md"), "utf8");
      expect(issueMarkdown).toContain("Make checkout idempotent.");

      const results = await readFile(path.join(outputDir, "results.jsonl"), "utf8");
      expect(results).toContain('"status":"prepared"');

      const reloadedTasks = await loadBenchTasks(tasksPath);
      expect(reloadedTasks.map((task) => task.id)).toEqual(["task-1"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("records live Paperclip runner outputs", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bench-live-test-"));
    try {
      const tasksPath = path.join(tmpDir, "tasks.jsonl");
      const outputDir = path.join(tmpDir, "out");
      await writeFile(
        tasksPath,
        `${JSON.stringify({
          id: "task-live-1",
          title: "Ship audit logs",
          problemStatement: "Add audit log support.",
          successChecks: ["pnpm test"],
        })}\n`,
        "utf8",
      );

      const manifest = await runPaperclipBench({
        tasksPath,
        benchmark: "paperclip_native",
        outputDir,
        runId: "live-run",
        paperclipVersion: "current",
        model: "noop",
        runner: "paperclip",
        clean: true,
        issueProvisioner: async () => ({
          source: "created",
          issue: {
            id: "issue-1",
            companyId: "company-1",
            projectId: null,
            projectWorkspaceId: null,
            goalId: null,
            parentId: null,
            title: "Ship audit logs",
            description: null,
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            createdByAgentId: null,
            createdByUserId: null,
            issueNumber: 1,
            identifier: "PAP-1",
            requestDepth: 0,
            billingCode: null,
            assigneeAdapterOverrides: null,
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
            startedAt: null,
            completedAt: null,
            cancelledAt: null,
            hiddenAt: null,
            createdAt: new Date("2026-04-24T12:00:00Z"),
            updatedAt: new Date("2026-04-24T12:00:00Z"),
          },
        }),
        runLiveTask: async ({ taskDir, issue }) => {
          await writeFile(path.join(taskDir, "patch.diff"), "diff --git a/file b/file\n", "utf8");
          return {
            issue: {
              ...issue,
              status: "done",
              executionRunId: "run-2",
              updatedAt: new Date("2026-04-24T12:02:00Z"),
            },
            runIds: ["run-1", "run-2"],
            status: "done",
            patchPath: "tasks/task-live-1/patch.diff",
          };
        },
      });

      expect(manifest.runner).toBe("paperclip");
      expect(manifest.tasks[0]).toMatchObject({
        status: "done",
        patchPath: "tasks/task-live-1/patch.diff",
        paperclipRunIds: ["run-1", "run-2"],
        paperclipIssue: {
          id: "issue-1",
          identifier: "PAP-1",
          status: "done",
          source: "created",
        },
      });

      const trace = await readFile(path.join(outputDir, "tasks/task-live-1/trace.json"), "utf8");
      expect(trace).toContain('"paperclipRunIds": [');
      expect(trace).toContain('"patchPath": "tasks/task-live-1/patch.diff"');

      const results = await readFile(path.join(outputDir, "results.jsonl"), "utf8");
      expect(results).toContain('"status":"done"');
      expect(results).toContain('"paperclipRunIds":["run-1","run-2"]');
      expect(results).toContain('"patchPath":"tasks/task-live-1/patch.diff"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes failed live-run results when the Paperclip runner errors", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bench-live-fail-test-"));
    try {
      const tasksPath = path.join(tmpDir, "tasks.jsonl");
      const outputDir = path.join(tmpDir, "out");
      await writeFile(
        tasksPath,
        `${JSON.stringify({
          id: "task-live-2",
          title: "Fail audit logs",
          problemStatement: "Add audit log support.",
          successChecks: ["pnpm test"],
        })}\n`,
        "utf8",
      );

      const manifest = await runPaperclipBench({
        tasksPath,
        benchmark: "paperclip_native",
        outputDir,
        runId: "live-fail-run",
        paperclipVersion: "current",
        model: "noop",
        runner: "paperclip",
        clean: true,
        continueOnError: true,
        issueProvisioner: async () => ({
          source: "reused",
          issue: {
            id: "issue-2",
            companyId: "company-1",
            projectId: null,
            projectWorkspaceId: null,
            goalId: null,
            parentId: null,
            title: "Fail audit logs",
            description: null,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            createdByAgentId: null,
            createdByUserId: null,
            issueNumber: 2,
            identifier: "PAP-2",
            requestDepth: 0,
            billingCode: null,
            assigneeAdapterOverrides: null,
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
            startedAt: null,
            completedAt: null,
            cancelledAt: null,
            hiddenAt: null,
            createdAt: new Date("2026-04-24T12:00:00Z"),
            updatedAt: new Date("2026-04-24T12:00:00Z"),
          },
        }),
        runLiveTask: async () => {
          throw new Error("heartbeat invoke failed");
        },
      });

      expect(manifest.tasks[0]?.status).toBe("failed");

      const results = await readFile(path.join(outputDir, "results.jsonl"), "utf8");
      expect(results).toContain('"status":"failed"');
      expect(results).toContain('"failureStage":"paperclip_runner"');
      expect(results).toContain('"notes":"heartbeat invoke failed"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
