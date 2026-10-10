import { expect, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { collectRunEvents } from "./run-observations.js";
import { restartChatServer } from "./chat-restart.js";
import { readRegisteredArtifacts } from "./registered-artifact.js";
import { TASK_WORKSPACES_BUDGET_CENTS, taskWorkspaceFiles, taskWorkspacePrompt } from "./task-workspaces-cases.js";
import { gradeTaskWorkspaces, isRepositoryPreparationReceipt, type TaskWorkspaceCheckpoint, type TaskWorkspaceObservation } from "./task-workspaces-scoring.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
const execFile = promisify(execFileCallback);
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export async function runTaskWorkspacesFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  temporaryRoot: string; deadlineAt: number;
  restart(): Promise<unknown>;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeTaskWorkspaces>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const native = execution.profile.generation === "native";
  const files = taskWorkspaceFiles(nonce);
  const companyPath = `/api/companies/${fixtures.company.id}`;
  let issue: Row | undefined;
  let runs: Row[] = [];
  const evidence: TaskWorkspaceObservation = { nonce, native, daytona: execution.environment.id === "daytona", initial: null,
    checkpoints: [], projectCount: -1, runCount: 0, restarted: false, pendingInteractions: -1, activeOperations: -1,
    activeRecovery: true, artifact: null, remoteLeaseRunIds: [] };
  const eventEvidence: Array<{ runId: string; events: Row[] }> = [];
  async function refresh() {
    if (!issue) return;
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    // A synthetic company contains only this task. Extra/background work is counted, never hidden.
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    evidence.runCount = runs.length;
  }
  async function save(phase: string) {
    const checks = gradeTaskWorkspaces(evidence);
    if (issue) input.observe(issue, runs, checks);
    await input.evidence("task-workspaces.json", { schema: "paperclip.e2e.task-workspaces.v1", phase,
      budgetMonthlyCents: TASK_WORKSPACES_BUDGET_CENTS, expectedTurns: 3, observation: evidence, checks });
    await input.evidence("task-workspaces-runs.json", { runs, events: eventEvidence });
  }
  async function readFile(relativePath: string) {
    const response = await api.get<Row>(`/api/issues/${issue!.id}/file-resources/content?workspace=execution&path=${encodeURIComponent(relativePath)}`);
    if (response.resource?.workspaceKind !== "execution_workspace" || typeof response.content?.data !== "string") {
      throw new Error("Task file oracle did not return execution-workspace text bytes");
    }
    return response.content.data as string;
  }
  async function observeWorkspace() {
    const view = await api.get<Row>(`/api/issues/${issue!.id}/workspace`);
    if (!view.workspace?.id || !view.workspace.cwd) throw new Error("Task has no durable workspace binding");
    const cwd = await realpath(view.workspace.cwd);
    const isolated = await realpath(input.temporaryRoot);
    const suffix = `/isolated-workspaces/${fixtures.company.id}/${issue!.id}`;
    const confinedTaskRoot = cwd.startsWith(`${isolated}${path.sep}`) && cwd.endsWith(suffix);
    if (!confinedTaskRoot) throw new Error("Task workspace is not its confined company/task directory");
    return { view, cwd, confinedTaskRoot };
  }
  async function settled(turn: number) {
    await pollUntil({ label: `task workspace turn ${turn} durably settled`,
      deadlineAt: Math.min(input.deadlineAt, Date.now() + (execution.task.turnTimeoutMs ?? 240_000)), intervalMs: 750,
      load: async () => {
        await refresh();
        const [interactions, recovery] = await Promise.all([
          api.get<Row[]>(`/api/issues/${issue!.id}/interactions`), api.get<Row>(`/api/issues/${issue!.id}/recovery-actions`),
        ]);
        const operations = (await Promise.all(runs.map(run => api.get<Row[]>(`/api/heartbeat-runs/${run.id}/workspace-operations`)))).flat();
        evidence.pendingInteractions = interactions.filter(row => row.status === "pending").length;
        evidence.activeOperations = operations.filter(row => ["pending", "queued", "running"].includes(row.status)).length;
        evidence.activeRecovery = [recovery.active, ...(recovery.actions ?? [])].some(row => row
          && ["active", "pending"].includes(row.status) && row.wakePolicy?.kind === "resume_native_run");
        return { issue, runs };
      },
      accept: state => state.runs.length === turn && state.issue?.status === "done" && state.runs.every(run => run.status === "succeeded"
        && (!native || (run.nativePhase === "committed" && run.resultJson?.finalizationPhase === "committed")))
        && evidence.pendingInteractions === 0 && evidence.activeOperations === 0 && !evidence.activeRecovery,
      reject: state => state.runs.length > turn ? "Unexpected extra provider run" : state.runs.some(run => terminal.has(run.status) && run.status !== "succeeded") ? "A requested turn failed" : undefined,
    });
  }
  async function checkpoint(turn: 1 | 2 | 3) {
    const { view, cwd, confinedTaskRoot } = await observeWorkspace();
    const run = runs[turn - 1]!;
    if (run.companyId !== fixtures.company.id || run.agentId !== fixtures.agent.id
      || ![run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].includes(issue!.id)) {
      throw new Error("Provider run is not attributed to the selected task and agent");
    }
    const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    eventEvidence.push({ runId: run.id, events });
    const spans = events.filter(event => event.eventType === "run.performance.span").map(event => event.payload);
    const nativeInput = run.runnerProfileJson?.nativeExecutionInput;
    const point: TaskWorkspaceCheckpoint = { turn,
      issue: { id: issue!.id, projectId: issue!.projectId, executionWorkspaceId: issue!.executionWorkspaceId, status: issue!.status, scheduledRetry: issue!.scheduledRetry },
      workspace: { id: view.workspace.id, projectId: view.workspace.projectId, cwd }, confinedTaskRoot,
      note: await readFile(files.note), repositories: view.repositories,
      run: { id: run.id, status: run.status, runtimeMode: run.runtimeMode, nativePhase: run.nativePhase,
        nativeBinding: nativeInput?.binding?.executionWorkspaceId, nativeCwd: nativeInput?.workspace?.cwd,
        transport: spans.find(p => p?.span === "runner.transport.selected")?.mode,
        authenticated: spans.some(p => p?.span === "runner.prp.authenticate" && p.outcome === "ok"),
        nativeCompleted: events.some(event => event.eventType === "run.result.accepted" && event.payload?.prpEvent?.sourceKind === "control_plane"
          && event.payload.prpEvent.runId === run.id && event.payload.prpEvent.payload?.result?.reportedWorkDisposition === "done")
          && events.some(event => event.eventType === "run.terminal" && event.payload?.prpEvent?.sourceKind === "control_plane"
            && event.payload.prpEvent.runId === run.id && event.payload.prpEvent.payload?.runTerminalState === "succeeded") },
      prepareCalls: events.filter(event => isRepositoryPreparationReceipt(event, run.id)).length,
    };
    if (turn > 1) {
      const repository = view.repositories[0];
      if (!repository || !/^\.paperclip-repositories\/task-repo-[a-f0-9]{24}$/.test(repository.relativePath)) throw new Error("No contained managed repository receipt");
      const checkout = await realpath(path.join(cwd, repository.relativePath));
      if (!checkout.startsWith(`${cwd}${path.sep}`)) throw new Error("Repository oracle path escaped the isolated task root");
      const git = async (...args: string[]) => (await execFile("git", ["-C", checkout, ...args], { timeout: 15_000, maxBuffer: 65_536 })).stdout.trim();
      point.repository = { head: await git("rev-parse", "HEAD"),
        baseIsAncestor: await git("merge-base", "--is-ancestor", repository.pinnedCommit, "HEAD").then(() => true, () => false),
        dirty: (await git("status", "--porcelain", "--", files.repositoryFile)).length > 0,
        content: await readFile(`${repository.relativePath}/${files.repositoryFile}`) };
    }
    evidence.checkpoints.push(point);
    evidence.projectCount = (await api.get<Row[]>(`${companyPath}/projects`)).length;
    if (execution.environment.id === "daytona") evidence.remoteLeaseRunIds = (await api.get<Row[]>(`/api/environments/${fixtures.environment.id}/leases`))
      .filter(lease => lease.issueId === issue!.id && typeof lease.providerLeaseId === "string").map(lease => lease.heartbeatRunId);
    await save(`turn-${turn}`);
    await page.reload();
    await expect(page.getByTestId("task-chat-thread-header").getByTestId("issue-detail-header")).toBeVisible();
    await expect(page.getByTestId("task-chat-agent-bubble").filter({ hasText: `TASK-WORKSPACE-${turn}-${nonce}` }).last()).toBeVisible({ timeout: 30_000 });
    await input.capture(`task-files-turn-${turn}`, `Projectless task after turn ${turn}`, `task-files-turn-${turn}.png`);
  }
  try {
    if (fixtures.project) throw new Error("Task-workspaces fixture must not create a project");
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    if (agent.adapterConfig?.cwd) throw new Error("Task-workspaces fixture must not configure operator cwd");
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, { budgetMonthlyCents: TASK_WORKSPACES_BUDGET_CENTS });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, { budgetMonthlyCents: TASK_WORKSPACES_BUDGET_CENTS });
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      title: execution.task.buildTitle(nonce), prompt: taskWorkspacePrompt(nonce, 1, native), workMode: "standard", requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`);
    const before = await pollUntil({ label: "initial projectless workspace admission", deadlineAt: input.deadlineAt,
      load: () => api.get<Row>(`/api/issues/${issue!.id}/workspace`), accept: view => Boolean(view.workspace?.id), intervalMs: 300 });
    evidence.initial = { workspaceId: before.workspace.id, cwd: await realpath(before.workspace.cwd), repositories: before.repositories.length };
    await save("initial-admission");
    await settled(1); await checkpoint(1);
    // Controller lifecycle only: the original provider turn is already settled.
    const issueUrl = page.url();
    await restartChatServer(page, async () => { await input.restart(); });
    evidence.restarted = true;
    await page.goto(issueUrl);
    await expect(page.getByTestId("task-chat-thread-header").getByTestId("issue-detail-header")).toBeVisible();
    await submitTaskReply(page, taskWorkspacePrompt(nonce, 2, native));
    await settled(2); await checkpoint(2);
    await submitTaskReply(page, taskWorkspacePrompt(nonce, 3, native));
    await settled(3); await checkpoint(3);
    const [artifact] = await readRegisteredArtifacts(api, issue.id, runs[2]!.id, [files.proof]);
    evidence.artifact = artifact;
    await save("completed");
    const checks = gradeTaskWorkspaces(evidence);
    const failed = checks.filter(check => !check.passed);
    if (failed.length) throw new Error(`Task workspace oracle failure: ${failed.map(check => check.id).join(", ")}`);
    return { issue, runs, checks };
  } catch (error) {
    await refresh().catch(() => undefined);
    await save("failed");
    throw error;
  }
}
