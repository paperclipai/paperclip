import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pc from "picocolors";
import { Command } from "commander";
import type { AgentWakeupResponse, HeartbeatRun, Issue } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";
import { ApiRequestError } from "../client/http.js";

export interface BenchRepoSpec {
  url?: string;
  path?: string;
  baseCommit?: string;
}

export interface BenchRubricItem {
  name: string;
  description?: string;
  maxScore?: number;
}

export interface BenchTask {
  id: string;
  title: string;
  problemStatement: string;
  repo?: BenchRepoSpec;
  paperclipIssueRef?: string;
  maxWallClockMinutes?: number;
  maxCostUsd?: number;
  successChecks: string[];
  humanRubric: BenchRubricItem[];
  requiredArtifacts: string[];
  metadata?: Record<string, unknown>;
}

export interface BenchManifestTask {
  id: string;
  title: string;
  issuePath: string;
  taskPath: string;
  tracePath: string;
  patchPath?: string;
  workspacePath?: string;
  repo?: BenchRepoSpec;
  successChecks: string[];
  requiredArtifacts: string[];
  paperclipRunIds?: string[];
  status?: BenchTaskStatus;
  paperclipIssue?: {
    id: string;
    identifier?: string;
    status?: string;
    source?: "created" | "reused";
  };
}

export type BenchRunner = "prepare" | "paperclip";
export type BenchTaskStatus = "prepared" | "issue_created" | "issue_reused" | Issue["status"] | "failed";

export interface BenchManifest {
  schemaVersion: 1;
  runId: string;
  benchmark: string;
  paperclipVersion: string;
  model: string;
  runner: BenchRunner;
  createdAt: string;
  outputDir: string;
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
  taskCount: number;
  tasks: BenchManifestTask[];
}

export interface BenchResult {
  runId: string;
  benchmark: string;
  taskId: string;
  status: BenchTaskStatus;
  issuePath: string;
  taskPath: string;
  tracePath: string;
  patchPath?: string;
  workspacePath?: string;
  paperclipIssueId?: string;
  paperclipIssueIdentifier?: string;
  paperclipRunIds?: string[];
  failureStage?: string | null;
  notes?: string;
}

interface BenchRunOptions extends BaseClientOptions {
  tasks: string;
  benchmark?: string;
  output?: string;
  runId?: string;
  paperclipVersion?: string;
  model?: string;
  runner?: string;
  maxCostUsd?: string;
  maxWallClockMinutes?: string;
  maxTasks?: string;
  clean?: boolean;
  checkout?: boolean;
  createIssues?: boolean;
  projectId?: string;
  goalId?: string;
  assigneeAgentId?: string;
  issueStatus?: string;
  billingCode?: string;
  continueOnError?: boolean;
}

interface BenchValidateOptions extends BaseClientOptions {
  tasks: string;
  maxTasks?: string;
}

interface NormalizationDefaults {
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
}

interface RunPaperclipBenchOptions {
  tasksPath: string;
  benchmark: string;
  outputDir: string;
  runId: string;
  paperclipVersion: string;
  model: string;
  runner: BenchRunner;
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
  maxTasks?: number;
  clean?: boolean;
  checkout?: boolean;
  issueProvisioner?: (task: BenchTask, issueMarkdown: string) => Promise<BenchIssueResolution>;
  runLiveTask?: (input: BenchLiveTaskInput) => Promise<BenchLiveTaskOutcome>;
  continueOnError?: boolean;
}

interface BenchIssueResolution {
  issue: Issue;
  source: "created" | "reused";
}

interface BenchLiveTaskInput {
  task: BenchTask;
  taskDir: string;
  outputDir: string;
  issueMarkdown: string;
  issue: Issue;
  issueSource: "created" | "reused";
  benchmark: string;
  runId: string;
  startedAt: string;
  defaultMaxCostUsd?: number;
  defaultMaxWallClockMinutes?: number;
}

interface BenchLiveTaskOutcome {
  issue: Issue;
  runIds: string[];
  status: BenchTaskStatus;
  patchPath?: string;
  failureStage?: string | null;
  notes?: string;
}

class BenchStageError extends Error {
  readonly stage: string;

  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}

const TERMINAL_RUN_STATUSES = new Set<HeartbeatRun["status"]>(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_ISSUE_STATUSES = new Set<Issue["status"]>(["done", "blocked", "cancelled", "in_review"]);
const BENCH_POLL_INTERVAL_MS = 1000;

export function registerBenchCommands(program: Command): void {
  const bench = program
    .command("bench")
    .description("Prepare and run Paperclip benchmark task suites");

  addCommonClientOptions(
    bench
      .command("run")
      .description("Normalize a JSONL benchmark suite into Paperclip-ready run artifacts")
      .requiredOption("--tasks <path>", "JSONL task file")
      .option("--benchmark <name>", "Benchmark name", "paperclip_native")
      .option("--output <dir>", "Run output directory")
      .option("--run-id <id>", "Stable run id for repeatable output paths")
      .option("--paperclip-version <version>", "Paperclip version label", "current")
      .option("--model <model>", "Model or bundle label", "unspecified")
      .option("--runner <runner>", "Runner mode: prepare or paperclip", "prepare")
      .option("--max-cost-usd <amount>", "Default per-task cost budget")
      .option("--max-wall-clock-minutes <minutes>", "Default per-task wall-clock budget")
      .option("--max-tasks <count>", "Limit the number of tasks read from the suite")
      .option("--clean", "Remove the output directory before writing")
      .option("--checkout", "Clone/check out task repositories into each task workspace")
      .option("--create-issues", "Create one Paperclip issue per benchmark task")
      .option("--project-id <id>", "Project ID for created benchmark issues")
      .option("--goal-id <id>", "Goal ID for created benchmark issues")
      .option("--assignee-agent-id <id>", "Assignee agent ID for created benchmark issues")
      .option("--issue-status <status>", "Status for created benchmark issues", "todo")
      .option("--billing-code <code>", "Billing code for created benchmark issues")
      .option("--continue-on-error", "Write failed task results and continue")
      .action(async (opts: BenchRunOptions) => {
        try {
          const runner = normalizeBenchRunner(opts.runner);
          const benchmark = normalizeIdentifier(opts.benchmark ?? "paperclip_native", "benchmark");
          const runId = opts.runId?.trim() || buildDefaultRunId(benchmark);
          const outputDir = opts.output?.trim() || path.join(".tmp", "paperclip-bench", runId);
          const maxCostUsd = parseOptionalPositiveNumber(opts.maxCostUsd, "max-cost-usd");
          const maxWallClockMinutes = parseOptionalPositiveNumber(
            opts.maxWallClockMinutes,
            "max-wall-clock-minutes",
          );
          const maxTasks = parseOptionalPositiveInteger(opts.maxTasks, "max-tasks");

          const issueProvisioner = opts.createIssues || runner === "paperclip"
            ? buildIssueProvisioner({
                ...opts,
                benchmark,
                runId,
              })
            : undefined;
          const runLiveTask = runner === "paperclip"
            ? buildPaperclipLiveTaskRunner({
                ...opts,
                benchmark,
                runId,
              })
            : undefined;

          const manifest = await runPaperclipBench({
            tasksPath: opts.tasks,
            benchmark,
            outputDir,
            runId,
            paperclipVersion: opts.paperclipVersion?.trim() || "current",
            model: opts.model?.trim() || "unspecified",
            runner,
            maxCostUsd,
            maxWallClockMinutes,
            maxTasks,
            clean: opts.clean,
            checkout: opts.checkout,
            issueProvisioner,
            runLiveTask,
            continueOnError: opts.continueOnError,
          });

          if (opts.json) {
            printOutput(manifest, { json: true });
            return;
          }

          console.log(pc.bold(runner === "prepare" ? "Paperclip bench run prepared" : "Paperclip bench run completed"));
          console.log(`Run: ${manifest.runId}`);
          console.log(`Benchmark: ${manifest.benchmark}`);
          console.log(`Runner: ${manifest.runner}`);
          console.log(`Tasks: ${manifest.taskCount}`);
          console.log(`Output: ${manifest.outputDir}`);
          if (issueProvisioner) {
            const created = manifest.tasks.filter((task) => task.paperclipIssue?.source === "created").length;
            const reused = manifest.tasks.filter((task) => task.paperclipIssue?.source === "reused").length;
            if (created > 0) console.log(`Issues created: ${created}`);
            if (reused > 0) console.log(`Issues reused: ${reused}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    bench
      .command("validate")
      .description("Validate a JSONL benchmark task suite")
      .requiredOption("--tasks <path>", "JSONL task file")
      .option("--max-tasks <count>", "Limit the number of tasks read from the suite")
      .action(async (opts: BenchValidateOptions) => {
        try {
          const maxTasks = parseOptionalPositiveInteger(opts.maxTasks, "max-tasks");
          const tasks = await loadBenchTasks(opts.tasks, {}, maxTasks);

          if (opts.json) {
            printOutput({ taskCount: tasks.length, taskIds: tasks.map((task) => task.id) }, { json: true });
            return;
          }

          console.log(pc.bold("Benchmark suite is valid"));
          console.log(`Tasks: ${tasks.length}`);
          for (const task of tasks) {
            console.log(`- ${task.id}: ${task.title}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

export async function runPaperclipBench(options: RunPaperclipBenchOptions): Promise<BenchManifest> {
  const defaults: NormalizationDefaults = {
    maxCostUsd: options.maxCostUsd,
    maxWallClockMinutes: options.maxWallClockMinutes,
  };
  const tasks = await loadBenchTasks(options.tasksPath, defaults, options.maxTasks);
  const outputDir = path.resolve(options.outputDir);

  if (options.clean) {
    await rm(outputDir, { recursive: true, force: true });
  }
  await mkdir(outputDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const results: BenchResult[] = [];
  const manifestTasks: BenchManifestTask[] = [];

  for (const task of tasks) {
    const safeId = safePathSegment(task.id);
    const taskDir = path.join(outputDir, "tasks", safeId);
    await mkdir(taskDir, { recursive: true });

    const issuePath = path.join(taskDir, "issue.md");
    const taskPath = path.join(taskDir, "task.json");
    const tracePath = path.join(taskDir, "trace.json");
    const workspacePath = options.checkout ? path.join(taskDir, "repo") : undefined;
    const issueMarkdown = renderBenchIssueMarkdown(task, {
      benchmark: options.benchmark,
      runId: options.runId,
      model: options.model,
      paperclipVersion: options.paperclipVersion,
    });

    const startedAt = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [
      { at: startedAt, type: "task.prepared", taskId: task.id },
    ];

    let paperclipIssue: BenchManifestTask["paperclipIssue"];
    let paperclipRunIds: string[] | undefined;
    let patchPath: string | undefined;
    let status: BenchResult["status"] = "prepared";
    let failureStage: string | null = null;
    let notes: string | undefined;

    try {
      await writeFile(issuePath, issueMarkdown, "utf8");
      await writeFile(taskPath, JSON.stringify(task, null, 2), "utf8");

      if (options.checkout) {
        if (!task.repo?.url && !task.repo?.path) {
          throw new Error(`Task ${task.id} cannot be checked out because it has no repo.url or repo.path`);
        }
        checkoutTaskRepo(task, workspacePath!);
        events.push({ at: new Date().toISOString(), type: "repo.checked_out", path: workspacePath });
      }

      let resolvedIssue: Issue | undefined;
      if (options.issueProvisioner) {
        const issueResolution = await options.issueProvisioner(task, issueMarkdown);
        resolvedIssue = issueResolution.issue;
        paperclipIssue = {
          id: issueResolution.issue.id,
          identifier: issueResolution.issue.identifier ?? undefined,
          status: issueResolution.issue.status ?? undefined,
          source: issueResolution.source,
        };
        status = issueResolution.source === "created" ? "issue_created" : "issue_reused";
        events.push({
          at: new Date().toISOString(),
          type: issueResolution.source === "created" ? "paperclip.issue_created" : "paperclip.issue_reused",
          issueId: issueResolution.issue.id,
          identifier: issueResolution.issue.identifier,
        });
      }

      if (options.runner === "paperclip") {
        if (!resolvedIssue) {
          throw new BenchStageError(
            "issue_provision",
            `Runner "${options.runner}" requires an issue provisioner or a task row with an existing issue reference`,
          );
        }
        if (!options.runLiveTask) {
          throw new BenchStageError("paperclip_runner", "Live Paperclip runner is not configured");
        }

        const liveOutcome = await options.runLiveTask({
          task,
          taskDir,
          outputDir,
          issueMarkdown,
          issue: resolvedIssue,
          issueSource: paperclipIssue?.source ?? "created",
          benchmark: options.benchmark,
          runId: options.runId,
          startedAt,
          defaultMaxCostUsd: options.maxCostUsd,
          defaultMaxWallClockMinutes: options.maxWallClockMinutes,
        });
        paperclipIssue = {
          id: liveOutcome.issue.id,
          identifier: liveOutcome.issue.identifier ?? undefined,
          status: liveOutcome.issue.status ?? undefined,
          source: paperclipIssue?.source,
        };
        paperclipRunIds = liveOutcome.runIds;
        patchPath = liveOutcome.patchPath;
        status = liveOutcome.status;
        failureStage = liveOutcome.failureStage ?? null;
        notes = liveOutcome.notes;
        events.push({
          at: new Date().toISOString(),
          type: "paperclip.task_completed",
          issueId: liveOutcome.issue.id,
          issueStatus: liveOutcome.issue.status,
          runIds: liveOutcome.runIds,
          patchPath: liveOutcome.patchPath ?? null,
          failureStage: liveOutcome.failureStage ?? null,
        });
      }
    } catch (err) {
      status = "failed";
      failureStage =
        err instanceof BenchStageError
          ? err.stage
          : options.runner === "paperclip"
            ? "paperclip_runner"
            : options.issueProvisioner
              ? "prepare_or_create_issue"
              : "prepare";
      notes = err instanceof Error ? err.message : String(err);
      events.push({
        at: new Date().toISOString(),
        type: "task.failed",
        stage: failureStage,
        error: notes,
      });

      if (!options.continueOnError) {
        await writeTrace(tracePath, task.id, startedAt, status, events, notes, {
          paperclipIssueId: paperclipIssue?.id ?? null,
          paperclipIssueIdentifier: paperclipIssue?.identifier ?? null,
          paperclipRunIds: paperclipRunIds ?? [],
          patchPath: patchPath ?? null,
          failureStage,
        });
        throw err;
      }
    }

    const endedAt = new Date().toISOString();
    events.push({ at: endedAt, type: "task.finished", status });
    await writeTrace(tracePath, task.id, startedAt, status, events, notes, {
      paperclipIssueId: paperclipIssue?.id ?? null,
      paperclipIssueIdentifier: paperclipIssue?.identifier ?? null,
      paperclipRunIds: paperclipRunIds ?? [],
      patchPath: patchPath ?? null,
      failureStage,
    });

    manifestTasks.push({
      id: task.id,
      title: task.title,
      issuePath: path.relative(outputDir, issuePath),
      taskPath: path.relative(outputDir, taskPath),
      tracePath: path.relative(outputDir, tracePath),
      patchPath,
      workspacePath: workspacePath ? path.relative(outputDir, workspacePath) : undefined,
      repo: task.repo,
      successChecks: task.successChecks,
      requiredArtifacts: task.requiredArtifacts,
      paperclipRunIds,
      status,
      paperclipIssue,
    });

    results.push({
      runId: options.runId,
      benchmark: options.benchmark,
      taskId: task.id,
      status,
      issuePath: path.relative(outputDir, issuePath),
      taskPath: path.relative(outputDir, taskPath),
      tracePath: path.relative(outputDir, tracePath),
      patchPath,
      workspacePath: workspacePath ? path.relative(outputDir, workspacePath) : undefined,
      paperclipIssueId: paperclipIssue?.id,
      paperclipIssueIdentifier: paperclipIssue?.identifier,
      paperclipRunIds,
      failureStage,
      notes,
    });
  }

  const manifest: BenchManifest = {
    schemaVersion: 1,
    runId: options.runId,
    benchmark: options.benchmark,
    paperclipVersion: options.paperclipVersion,
    model: options.model,
    runner: options.runner,
    createdAt,
    outputDir,
    maxCostUsd: options.maxCostUsd,
    maxWallClockMinutes: options.maxWallClockMinutes,
    taskCount: manifestTasks.length,
    tasks: manifestTasks,
  };

  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(
    path.join(outputDir, "results.jsonl"),
    `${results.map((result) => JSON.stringify(result)).join("\n")}\n`,
    "utf8",
  );

  return manifest;
}

export async function loadBenchTasks(
  filePath: string,
  defaults: NormalizationDefaults = {},
  maxTasks?: number,
): Promise<BenchTask[]> {
  const contents = await readFile(filePath, "utf8");
  const rawTasks = parseJsonlObjects(contents, filePath);
  const selected = maxTasks === undefined ? rawTasks : rawTasks.slice(0, maxTasks);
  const seen = new Set<string>();

  return selected.map((raw, index) => {
    const task = normalizeBenchTask(raw, {
      lineLabel: `${filePath}:${index + 1}`,
      defaults,
    });
    if (seen.has(task.id)) {
      throw new Error(`Duplicate benchmark task id '${task.id}' in ${filePath}`);
    }
    seen.add(task.id);
    return task;
  });
}

export function normalizeBenchTask(
  raw: Record<string, unknown>,
  opts: { lineLabel: string; defaults?: NormalizationDefaults },
): BenchTask {
  const defaults = opts.defaults ?? {};
  const id = firstString(raw, ["id", "task_id", "taskId"]);
  const title = firstString(raw, ["title", "name"]);
  const problemStatement = firstString(raw, [
    "problemStatement",
    "problem_statement",
    "description",
    "issue",
    "prompt",
    "goal",
  ]);

  if (!id) throw new Error(`${opts.lineLabel}: benchmark task requires id`);
  normalizeIdentifier(id, "task id");
  if (!title) throw new Error(`${opts.lineLabel}: benchmark task '${id}' requires title`);
  if (!problemStatement) {
    throw new Error(`${opts.lineLabel}: benchmark task '${id}' requires problemStatement, description, issue, prompt, or goal`);
  }

  return {
    id,
    title,
    problemStatement,
    repo: normalizeRepoSpec(raw),
    paperclipIssueRef: normalizeIssueRef(raw),
    maxWallClockMinutes: firstNumber(raw, [
      "maxWallClockMinutes",
      "max_wall_clock_minutes",
      "timeBudgetMinutes",
      "time_budget_minutes",
    ]) ?? defaults.maxWallClockMinutes,
    maxCostUsd: firstNumber(raw, ["maxCostUsd", "max_cost_usd", "tokenBudgetUsd", "token_budget_usd"]) ?? defaults.maxCostUsd,
    successChecks: firstStringArray(raw, ["successChecks", "success_checks", "checks"]),
    humanRubric: normalizeRubric(raw.humanRubric ?? raw.human_rubric),
    requiredArtifacts: firstStringArray(raw, ["requiredArtifacts", "required_artifacts"]),
    metadata: asRecord(raw.metadata),
  };
}

export function renderBenchIssueMarkdown(
  task: BenchTask,
  run: {
    benchmark: string;
    runId: string;
    model: string;
    paperclipVersion: string;
  },
): string {
  const lines: string[] = [
    `# ${task.title}`,
    "",
    "## Benchmark Context",
    "",
    `- Task ID: \`${task.id}\``,
    `- Benchmark: \`${run.benchmark}\``,
    `- Run ID: \`${run.runId}\``,
    `- Paperclip version: \`${run.paperclipVersion}\``,
    `- Model or bundle: \`${run.model}\``,
  ];

  if (task.maxWallClockMinutes !== undefined || task.maxCostUsd !== undefined) {
    lines.push("", "## Budgets", "");
    if (task.maxWallClockMinutes !== undefined) {
      lines.push(`- Max wall-clock minutes: ${task.maxWallClockMinutes}`);
    }
    if (task.maxCostUsd !== undefined) {
      lines.push(`- Max cost USD: ${task.maxCostUsd}`);
    }
  }

  if (task.repo) {
    lines.push("", "## Repository", "");
    if (task.repo.url) lines.push(`- URL: ${task.repo.url}`);
    if (task.repo.path) lines.push(`- Path: ${task.repo.path}`);
    if (task.repo.baseCommit) lines.push(`- Base commit: ${task.repo.baseCommit}`);
  }

  lines.push(
    "",
    "## Task",
    "",
    task.problemStatement.trim(),
    "",
    "## Rules",
    "",
    "- Make the minimal correct code change.",
    "- Add or update tests when appropriate.",
    "- Run the smallest relevant verification that proves the change.",
    "- Do not modify unrelated files.",
    "- At the end, produce a final summary with changes, verification, and remaining risks.",
  );

  if (task.successChecks.length > 0) {
    lines.push("", "## Success Checks", "");
    lines.push(...task.successChecks.map((check) => `- ${check}`));
  }

  if (task.requiredArtifacts.length > 0) {
    lines.push("", "## Required Artifacts", "");
    lines.push(...task.requiredArtifacts.map((artifact) => `- ${artifact}`));
  }

  if (task.humanRubric.length > 0) {
    lines.push("", "## Human Rubric", "");
    for (const item of task.humanRubric) {
      const suffix = item.maxScore === undefined ? "" : ` (${item.maxScore} pts)`;
      const description = item.description ? `: ${item.description}` : "";
      lines.push(`- ${item.name}${suffix}${description}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function normalizeBenchRunner(value: string | undefined): BenchRunner {
  const normalized = value?.trim() || "prepare";
  if (normalized === "prepare" || normalized === "paperclip") {
    return normalized;
  }
  throw new Error(`Unsupported bench runner '${normalized}'. Expected one of: prepare, paperclip.`);
}

function buildIssueProvisioner(opts: BenchRunOptions & { benchmark: string; runId: string }) {
  const ctx = resolveCommandContext(opts);
  return async (task: BenchTask, issueMarkdown: string): Promise<BenchIssueResolution> => {
    const issueRef = task.paperclipIssueRef?.trim();
    if (issueRef) {
      const existing = await ctx.api.get<Issue>(`/api/issues/${encodeURIComponent(issueRef)}`);
      if (!existing) {
        throw new BenchStageError("issue_provision", `Benchmark task ${task.id} references missing issue ${issueRef}`);
      }
      return { issue: existing, source: "reused" };
    }

    if (!ctx.companyId) {
      throw new BenchStageError(
        "issue_provision",
        "Company ID is required to create benchmark issues. Pass --company-id, set PAPERCLIP_COMPANY_ID, or reuse an existing issue from the task row.",
      );
    }

    const payload = {
      title: `[${opts.benchmark}] ${task.title}`,
      description: issueMarkdown,
      status: opts.issueStatus ?? "todo",
      priority: "medium",
      assigneeAgentId: opts.assigneeAgentId,
      projectId: opts.projectId,
      goalId: opts.goalId,
      billingCode: opts.billingCode || `bench:${opts.runId}`,
    };
    const issue = await ctx.api.post<Issue>(`/api/companies/${ctx.companyId}/issues`, payload);
    if (!issue) {
      throw new BenchStageError("issue_provision", `Paperclip API did not return the created issue for task ${task.id}`);
    }
    return { issue, source: "created" };
  };
}

function buildPaperclipLiveTaskRunner(opts: BenchRunOptions & { benchmark: string; runId: string }) {
  const ctx = resolveCommandContext(opts);

  return async (input: BenchLiveTaskInput): Promise<BenchLiveTaskOutcome> => {
    const assigneeAgentId = input.issue.assigneeAgentId ?? (opts.assigneeAgentId?.trim() || null);
    if (!assigneeAgentId) {
      throw new BenchStageError(
        "issue_checkout",
        `Benchmark issue ${input.issue.identifier ?? input.issue.id} has no assigneeAgentId to run`,
      );
    }

    try {
      await ctx.api.post<Issue>(`/api/issues/${input.issue.id}/checkout`, {
        agentId: assigneeAgentId,
        expectedStatuses: ["backlog", "todo", "blocked", "in_review", "in_progress"],
      });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        throw new BenchStageError("issue_checkout", err.message);
      }
      throw err;
    }

    const wakeResponse = await ctx.api.post<AgentWakeupResponse>(`/api/agents/${assigneeAgentId}/wakeup`, {
      source: "assignment",
      triggerDetail: "manual",
      reason: "bench_runner",
      payload: {
        benchmark: input.benchmark,
        runId: input.runId,
        taskId: input.task.id,
        issueId: input.issue.id,
      },
      idempotencyKey: `bench:${input.runId}:${input.task.id}:${input.issue.id}`,
    });

    const observedRunIds = new Set<string>();
    const initialRunId = readWakeupRunId(wakeResponse);
    if (initialRunId) observedRunIds.add(initialRunId);

    const budgetMs = resolveWallClockBudgetMs(input.task, input.defaultMaxWallClockMinutes);
    const deadline = budgetMs ? Date.now() + budgetMs : null;
    let latestIssue = await ctx.api.get<Issue>(`/api/issues/${input.issue.id}`);
    if (!latestIssue) {
      throw new BenchStageError("issue_poll", `Benchmark issue ${input.issue.id} disappeared while polling`);
    }

    let finalRun: HeartbeatRun | null = null;
    let failureStage: string | null = null;
    let notes = readWakeupNotes(wakeResponse);

    while (true) {
      const activeRunSummary = await ctx.api.get<{ id: string } | null>(`/api/issues/${input.issue.id}/active-run`);
      const activeRunId = typeof activeRunSummary?.id === "string" ? activeRunSummary.id : null;
      if (activeRunId) {
        observedRunIds.add(activeRunId);
        const run = await ctx.api.get<HeartbeatRun>(`/api/heartbeat-runs/${activeRunId}`);
        if (run) {
          finalRun = run;
          const costUsd = readHeartbeatRunCostUsd(run);
          const maxCostUsd = input.task.maxCostUsd ?? input.defaultMaxCostUsd;
          if (
            maxCostUsd !== undefined
            && costUsd !== null
            && costUsd > maxCostUsd
          ) {
            try {
              await ctx.api.post(`/api/heartbeat-runs/${run.id}/cancel`);
            } catch (cancelErr) {
              notes = appendNote(
                notes,
                `Cost budget exceeded at ${costUsd.toFixed(2)} USD, and cancelling run ${run.id} failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
              );
            }
            failureStage = "cost_budget_exceeded";
            notes = appendNote(notes, `Cancelled run ${run.id} after exceeding max cost budget ${maxCostUsd} USD.`);
            latestIssue = (await ctx.api.get<Issue>(`/api/issues/${input.issue.id}`)) ?? latestIssue;
            break;
          }
        }
      }

      latestIssue = (await ctx.api.get<Issue>(`/api/issues/${input.issue.id}`)) ?? latestIssue;
      if (latestIssue.executionRunId) observedRunIds.add(latestIssue.executionRunId);

      if (TERMINAL_ISSUE_STATUSES.has(latestIssue.status)) {
        if (latestIssue.executionRunId) {
          finalRun = await ctx.api.get<HeartbeatRun>(`/api/heartbeat-runs/${latestIssue.executionRunId}`, { ignoreNotFound: true });
        }
        break;
      }

      if (!activeRunId && latestIssue.executionRunId) {
        finalRun = await ctx.api.get<HeartbeatRun>(`/api/heartbeat-runs/${latestIssue.executionRunId}`, { ignoreNotFound: true });
        if (finalRun?.status && TERMINAL_RUN_STATUSES.has(finalRun.status)) {
          break;
        }
      }

      if (deadline && Date.now() >= deadline) {
        failureStage = failureStage ?? "run_timeout";
        if (activeRunId) {
          try {
            await ctx.api.post(`/api/heartbeat-runs/${activeRunId}/cancel`);
            notes = appendNote(notes, `Cancelled run ${activeRunId} after wall-clock budget expired.`);
          } catch (cancelErr) {
            notes = appendNote(
              notes,
              `Wall-clock budget expired for run ${activeRunId}, and cancelling it failed: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
            );
          }
        }
        latestIssue = (await ctx.api.get<Issue>(`/api/issues/${input.issue.id}`)) ?? latestIssue;
        break;
      }

      await delay(BENCH_POLL_INTERVAL_MS);
    }

    const issueRuns = await listIssueRunIdsSince(ctx, latestIssue.companyId, assigneeAgentId, latestIssue.id, input.startedAt);
    for (const runId of issueRuns) observedRunIds.add(runId);

    const sortedRunIds = [...observedRunIds];
    if (!failureStage && latestIssue.status !== "done") {
      failureStage = mapIssueStatusToFailureStage(latestIssue.status, finalRun?.status ?? null);
    }

    let extractedPatchPath: string | undefined;
    try {
      extractedPatchPath = await extractIssuePatch({
        issue: latestIssue,
        outputDir: input.outputDir,
        taskDir: input.taskDir,
      });
      if (latestIssue.currentExecutionWorkspace?.mode === "shared_workspace") {
        notes = appendNote(
          notes,
          `Patch was extracted from shared workspace ${latestIssue.currentExecutionWorkspace.name}; unrelated dirty changes in that workspace can contaminate the diff.`,
        );
      }
      if (!extractedPatchPath) {
        failureStage = failureStage ?? "patch_missing";
        notes = appendNote(notes, `No git diff was available in the execution workspace for issue ${latestIssue.identifier ?? latestIssue.id}.`);
      }
    } catch (err) {
      failureStage = failureStage ?? "patch_extract";
      notes = appendNote(notes, err instanceof Error ? err.message : String(err));
    }

    return {
      issue: latestIssue,
      runIds: sortedRunIds,
      status: latestIssue.status,
      patchPath: extractedPatchPath,
      failureStage,
      notes,
    };
  };
}

function parseJsonlObjects(contents: string, filePath: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const lines = contents.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${filePath}:${index + 1}: invalid JSONL row: ${message}`);
    }

    if (!isRecord(parsed)) {
      throw new Error(`${filePath}:${index + 1}: expected a JSON object`);
    }
    rows.push(parsed);
  });

  if (rows.length === 0) {
    throw new Error(`${filePath}: no benchmark tasks found`);
  }

  return rows;
}

function normalizeRepoSpec(raw: Record<string, unknown>): BenchRepoSpec | undefined {
  const rawRepo = raw.repo;
  const startingCommit = firstString(raw, ["startingCommit", "starting_commit", "baseCommit", "base_commit"]);

  if (typeof rawRepo === "string" && rawRepo.trim()) {
    return compactRepoSpec({ url: rawRepo.trim(), baseCommit: startingCommit });
  }

  if (isRecord(rawRepo)) {
    return compactRepoSpec({
      url: firstString(rawRepo, ["url", "remote", "repository"]),
      path: firstString(rawRepo, ["path", "localPath", "local_path"]),
      baseCommit: firstString(rawRepo, ["baseCommit", "base_commit", "startingCommit", "starting_commit"]) ?? startingCommit,
    });
  }

  return startingCommit ? { baseCommit: startingCommit } : undefined;
}

function normalizeIssueRef(raw: Record<string, unknown>): string | undefined {
  const metadata = asRecord(raw.metadata);
  return firstString(raw, [
    "paperclipIssueRef",
    "paperclip_issue_ref",
    "paperclipIssueId",
    "paperclip_issue_id",
    "paperclipIssueIdentifier",
    "paperclip_issue_identifier",
    "existingIssueId",
    "existing_issue_id",
    "issueRef",
    "issue_ref",
  ]) ?? (metadata
    ? firstString(metadata, [
        "paperclipIssueRef",
        "paperclipIssueId",
        "paperclipIssueIdentifier",
        "existingIssueId",
        "issueRef",
      ])
    : undefined);
}

function compactRepoSpec(repo: BenchRepoSpec): BenchRepoSpec | undefined {
  const compact = {
    url: repo.url?.trim() || undefined,
    path: repo.path?.trim() || undefined,
    baseCommit: repo.baseCommit?.trim() || undefined,
  };
  return compact.url || compact.path || compact.baseCommit ? compact : undefined;
}

function normalizeRubric(value: unknown): BenchRubricItem[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === "string" && item.trim()) {
        return { name: item.trim() };
      }
      if (isRecord(item)) {
        const name = firstString(item, ["name", "criterion", "label"]);
        if (!name) throw new Error(`human_rubric[${index}] requires name`);
        return {
          name,
          description: firstString(item, ["description", "notes"]),
          maxScore: firstNumber(item, ["maxScore", "max_score", "points"]),
        };
      }
      throw new Error(`human_rubric[${index}] must be a string or object`);
    });
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([name, raw]) => {
      if (typeof raw === "number") return { name, maxScore: raw };
      if (typeof raw === "string") return { name, description: raw };
      if (isRecord(raw)) {
        return {
          name,
          description: firstString(raw, ["description", "notes"]),
          maxScore: firstNumber(raw, ["maxScore", "max_score", "points"]),
        };
      }
      return { name };
    });
  }

  return [];
}

function checkoutTaskRepo(task: BenchTask, workspacePath: string): void {
  const source = task.repo?.url ?? task.repo?.path;
  if (!source) throw new Error(`Task ${task.id} has no repository source`);

  const clone = spawnSync("git", ["clone", "--no-tags", source, workspacePath], {
    encoding: "utf8",
  });
  if (clone.status !== 0) {
    throw new Error(`git clone failed for task ${task.id}: ${clone.stderr || clone.stdout}`);
  }

  if (task.repo?.baseCommit) {
    const checkout = spawnSync("git", ["checkout", task.repo.baseCommit], {
      cwd: workspacePath,
      encoding: "utf8",
    });
    if (checkout.status !== 0) {
      throw new Error(`git checkout failed for task ${task.id}: ${checkout.stderr || checkout.stdout}`);
    }
  }
}

async function writeTrace(
  tracePath: string,
  taskId: string,
  startedAt: string,
  status: BenchResult["status"],
  events: Array<Record<string, unknown>>,
  error?: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    tracePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        taskId,
        startedAt,
        endedAt: new Date().toISOString(),
        status,
        error,
        events,
        ...(extra ?? {}),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function readWakeupRunId(response: AgentWakeupResponse | null): string | null {
  if (!response) return null;
  if ("id" in response && typeof response.id === "string") {
    return response.id;
  }
  if ("executionRunId" in response && typeof response.executionRunId === "string") {
    return response.executionRunId;
  }
  return null;
}

function readWakeupNotes(response: AgentWakeupResponse | null): string | undefined {
  if (!response || !("status" in response) || response.status !== "skipped") return undefined;
  const parts = [response.reason, response.message].filter((value): value is string => Boolean(value && value.trim()));
  return parts.length > 0 ? `Heartbeat wakeup skipped: ${parts.join(" - ")}` : undefined;
}

function resolveWallClockBudgetMs(task: BenchTask, defaultMaxWallClockMinutes?: number): number | undefined {
  const minutes = task.maxWallClockMinutes ?? defaultMaxWallClockMinutes;
  if (minutes === undefined) return undefined;
  return Math.max(1, Math.ceil(minutes * 60_000));
}

function readHeartbeatRunCostUsd(run: HeartbeatRun | null | undefined): number | null {
  const usage = asRecord(run?.usageJson);
  const result = asRecord(run?.resultJson);
  return firstFiniteNumber(
    usage ? [usage.costUsd, usage.cost_usd, usage.total_cost_usd] : [],
    result ? [result.costUsd, result.cost_usd, result.total_cost_usd] : [],
  );
}

async function listIssueRunIdsSince(
  ctx: ReturnType<typeof resolveCommandContext>,
  companyId: string,
  agentId: string,
  issueId: string,
  startedAt: string,
): Promise<string[]> {
  const runs = await ctx.api.get<HeartbeatRun[]>(`/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=200`);
  if (!Array.isArray(runs)) return [];
  const startedAtMs = toTimestamp(startedAt) ?? 0;
  return runs
    .filter((run) => {
      const context = asRecord(run.contextSnapshot);
      return (
        typeof run.id === "string"
        && (toTimestamp(run.createdAt) ?? 0) >= startedAtMs
        && context?.issueId === issueId
      );
    })
    .sort((left, right) => (toTimestamp(left.createdAt) ?? 0) - (toTimestamp(right.createdAt) ?? 0))
    .map((run) => run.id);
}

async function extractIssuePatch(input: {
  issue: Issue;
  outputDir: string;
  taskDir: string;
}): Promise<string | undefined> {
  const workspaceCwd = input.issue.currentExecutionWorkspace?.cwd;
  if (!workspaceCwd) {
    throw new BenchStageError(
      "patch_extract",
      `Issue ${input.issue.identifier ?? input.issue.id} does not have a local execution workspace available for patch extraction`,
    );
  }

  const statusBefore = spawnSync("git", ["-C", workspaceCwd, "status", "--porcelain=v1"], {
    encoding: "utf8",
  });
  if (statusBefore.status !== 0) {
    throw new BenchStageError(
      "patch_extract",
      `git status failed for ${workspaceCwd}: ${statusBefore.stderr || statusBefore.stdout}`,
    );
  }

  const untrackedFiles = statusBefore.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  if (untrackedFiles.length > 0) {
    const addIntent = spawnSync("git", ["-C", workspaceCwd, "add", "-N", "--", ...untrackedFiles], {
      encoding: "utf8",
    });
    if (addIntent.status !== 0) {
      throw new BenchStageError(
        "patch_extract",
        `git add -N failed for ${workspaceCwd}: ${addIntent.stderr || addIntent.stdout}`,
      );
    }
  }

  const diff = spawnSync("git", ["-C", workspaceCwd, "diff", "--binary", "--no-ext-diff", "--submodule=diff", "HEAD", "--"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status !== 0) {
    throw new BenchStageError(
      "patch_extract",
      `git diff failed for ${workspaceCwd}: ${diff.stderr || diff.stdout}`,
    );
  }
  if (!diff.stdout.trim()) return undefined;

  const patchFilePath = path.join(input.taskDir, "patch.diff");
  await writeFile(patchFilePath, diff.stdout, "utf8");
  return path.relative(input.outputDir, patchFilePath);
}

function mapIssueStatusToFailureStage(
  status: Issue["status"],
  runStatus: HeartbeatRun["status"] | null,
): string | null {
  if (status === "done") return null;
  if (status === "blocked") return "issue_blocked";
  if (status === "cancelled") return "issue_cancelled";
  if (status === "in_review") return "issue_in_review";
  if (runStatus === "timed_out") return "run_timeout";
  if (runStatus === "cancelled") return "run_cancelled";
  if (runStatus === "failed") return "run_failed";
  return "issue_incomplete";
}

function appendNote(existing: string | undefined, addition: string): string {
  const trimmed = addition.trim();
  if (!trimmed) return existing ?? "";
  if (!existing?.trim()) return trimmed;
  return `${existing}\n${trimmed}`;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function firstFiniteNumber(...groups: unknown[][]): number | null {
  for (const group of groups) {
    for (const value of group) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => typeof item === "string" ? item.trim() : "")
        .filter(Boolean);
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalPositiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive number`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  const parsed = parseOptionalPositiveNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) {
    throw new Error(`${label} must start with an alphanumeric character and contain only letters, numbers, '.', '_', ':', or '-'`);
  }
  return trimmed;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "task";
}

function buildDefaultRunId(benchmark: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${safePathSegment(benchmark)}`;
}
