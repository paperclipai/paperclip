import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { createTaskThroughUi } from "./user-actions.js";
import { readRegisteredArtifacts } from "./registered-artifact.js";
import { automaticRepositoryApiState, automaticRepositoryFiles, automaticRepositoryStopReason, gradeAutomaticRepository, type AutomaticRepositoryObservation } from "./automatic-repository.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
const execFile = promisify(execFileCallback);

export async function runAutomaticRepositoryFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  temporaryRoot: string; deadlineAt: number;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeAutomaticRepository>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const files = automaticRepositoryFiles(nonce);
  let issue: Row | undefined;
  let runs: Row[] = [];
  const observation: AutomaticRepositoryObservation = { expectedModel: execution.profile.model,
    expectedProvider: execution.profile.provider === "codex" ? "codex" : "acpx:claude", actualProviders: [], reference: "", issueDone: false, runCount: 0,
    successfulCommittedRuns: 0, sourceContinuation: null, successorSource: null, workspaceIds: [], readyRepository: false,
    savedContext: null, firstSavedContext: null, firstContextAttributed: false,
    firstContextObservedAt: null, successorStartedAt: null, predecessorFinishedAt: null, predecessorRetagged: true, continuationReceipt: null,
    actualReadme: null, actualCommit: null, downloaded: null, downloadVerified: false,
    visibleDelivery: false, pendingInteractions: -1, monitorScheduled: false };
  async function refresh() {
    if (!issue) return;
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?limit=100`);
    runs = (await Promise.all(listed.map(row => api.get<Row>(`/api/heartbeat-runs/${row.id}`))))
      .filter(row => row.agentId === fixtures.agent.id && [row.nativeIssueId, row.issueId, row.contextSnapshot?.issueId, row.contextSnapshot?.taskId].includes(issue!.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    observation.issueDone = issue.status === "done";
    observation.runCount = runs.length;
    observation.successfulCommittedRuns = runs.filter(run => run.runtimeMode === "native" && run.status === "succeeded" &&
      run.nativePhase === "committed" && run.resultJson?.finalizationPhase === "committed").length;
    observation.sourceContinuation = runs[0]?.resultJson?.nativeResult?.continuation?.kind ?? null;
    observation.successorSource = runs[1]?.contextSnapshot?.source ?? null;
    observation.successorStartedAt = runs[1]?.startedAt ? Date.parse(runs[1].startedAt) : null;
    observation.predecessorFinishedAt = runs[0]?.finishedAt ? Date.parse(runs[0].finishedAt) : null;
    observation.predecessorRetagged = Boolean(runs[0]?.contextSnapshot?.nativeStatusWakeIntentId);
    const intentId = runs[1]?.contextSnapshot?.nativeStatusWakeIntentId, dispatchId = runs[1]?.wakeupRequestId;
    observation.continuationReceipt = typeof intentId === "string" && typeof dispatchId === "string" ? { intentId, dispatchId } : null;
    if (runs.length === 1 && runs[0]?.status === "running" && observation.firstContextObservedAt === null) {
      const original = await readRegisteredArtifacts(api, issue.id, runs[0].id, [files.context]).catch(() => null);
      if (original?.[0]) {
        observation.firstSavedContext = original[0].content;
        observation.firstContextAttributed = original[0].contentVerified;
        observation.firstContextObservedAt = Date.now();
      }
    }
    observation.actualProviders = runs.map(run => {
      const provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
      return { model: provider?.model ?? null, kind: provider ? provider.kind === "acpx" ? `acpx:${provider.agent}` : provider.kind : null };
    });
    observation.workspaceIds = runs.map(run => run.runnerProfileJson?.nativeExecutionInput?.binding?.executionWorkspaceId ?? null);
    observation.monitorScheduled ||= Boolean(issue.monitorNextCheckAt || runs.some(run => String(run.resultJson?.finalizationReasonCode).startsWith("scheduled_monitor_")));
  }
  async function save(phase: string) {
    const checks = gradeAutomaticRepository(observation);
    if (issue) {
      input.observe(issue, runs, checks);
      await input.evidence("api-state.json", automaticRepositoryApiState(phase, issue, runs, checks));
    }
    await input.evidence("automatic-repository.json", { schema: "paperclip.e2e.automatic-repository.v1", phase, observation, checks,
      runs: runs.map(run => ({ id: run.id, status: run.status, nativePhase: run.nativePhase, source: run.contextSnapshot?.source,
        finalizationReason: run.resultJson?.finalizationReasonCode, startedAt: run.startedAt, finishedAt: run.finishedAt })) });
  }
  try {
    if (fixtures.project || execution.profile.generation !== "native") throw new Error("Automatic repository requires a projectless native fixture");
    const agent = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    if (agent.adapterConfig?.cwd) throw new Error("Automatic repository must not inherit an operator cwd");
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, { budgetMonthlyCents: 1000 });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, { budgetMonthlyCents: 1000 });
    const companyBudget = await api.get<Row>(`/api/companies/${fixtures.company.id}`);
    const agentBudget = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    if (companyBudget.budgetMonthlyCents !== 1000 || agentBudget.budgetMonthlyCents !== 1000)
      throw new Error("Automatic repository hard-stop budgets were not retained");
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      title: execution.task.buildTitle(nonce), prompt: execution.task.buildPrompt(nonce), workMode: "standard", requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`);
    await pollUntil({ label: "repository setup and automatic result delivery", deadlineAt: input.deadlineAt, intervalMs: 750,
      load: async () => { await refresh(); return { issue, runs }; },
      accept: () => observation.issueDone && observation.successfulCommittedRuns === 2,
      reject: state => state.issue ? automaticRepositoryStopReason({ status: state.issue.status }, state.runs.map(run => ({ status: run.status }))) : undefined });
    const view = await api.get<Row>(`/api/issues/${issue.id}/workspace`);
    const cwd = await realpath(view.workspace.cwd), isolated = await realpath(input.temporaryRoot);
    if (!cwd.startsWith(`${isolated}${path.sep}`) || !cwd.endsWith(`/isolated-workspaces/${fixtures.company.id}/${issue.id}`))
      throw new Error("Repository oracle requires the confined task directory");
    const repositories = view.repositories.filter((repo: Row) => repo.state === "ready" && repo.repoUrl === "https://github.com/octocat/Hello-World");
    if (repositories.length !== 1 || !/^\.paperclip-repositories\/task-repo-[a-f0-9]{24}$/.test(repositories[0].relativePath))
      throw new Error("Expected one contained prepared repository");
    const checkout = await realpath(path.join(cwd, repositories[0].relativePath));
    if (!checkout.startsWith(`${cwd}${path.sep}`)) throw new Error("Prepared repository escaped the task directory");
    const git = async (args: string[]) => (await execFile("git", ["-C", checkout, ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeout: 20_000, maxBuffer: 262_144, encoding: "utf8",
    })).stdout;
    observation.actualCommit = (await git(["rev-parse", "HEAD"])).trim();
    observation.actualReadme = await git(["show", "HEAD:README"]);
    observation.readyRepository = repositories[0].pinnedCommit === observation.actualCommit;
    const [original] = await readRegisteredArtifacts(api, issue.id, runs[0]!.id, [files.context]);
    observation.firstContextAttributed &&= original.contentVerified && original.content === observation.firstSavedContext;
    if (/^[a-f0-9]{64}\n$/.test(original.content)) observation.reference = original.content.trimEnd();
    const context = await api.get<Row>(`/api/issues/${issue.id}/file-resources/content?workspace=execution&path=${encodeURIComponent(files.context)}`);
    observation.savedContext = context.resource?.workspaceKind === "execution_workspace" && typeof context.content?.data === "string" ? context.content.data : null;
    const [artifact] = await readRegisteredArtifacts(api, issue.id, runs[1]!.id, [files.result]);
    observation.downloaded = JSON.parse(artifact.content);
    observation.downloadVerified = artifact.contentVerified;
    observation.pendingInteractions = (await api.get<Row[]>(`/api/issues/${issue.id}/interactions`)).filter(row => row.status === "pending").length;
    await page.reload();
    await expect(page.getByTestId("task-chat-thread-header").getByTestId("issue-detail-header")).toBeVisible();
    const delivery = page.locator(`a[href*="${artifact.attachmentId}"]`).first();
    await expect(delivery).toBeVisible({ timeout: 30_000 });
    observation.visibleDelivery = true;
    await save("completed");
    await input.capture("final-state", "Automatically resumed repository result", "final-state.png");
    const checks = gradeAutomaticRepository(observation);
    const failed = checks.filter(check => !check.passed);
    if (failed.length) throw new Error(`Automatic repository oracle failure: ${failed.map(check => check.id).join(", ")}`);
    return { issue, runs, checks };
  } catch (error) {
    await refresh().catch(() => undefined);
    await save("failed");
    throw error;
  }
}
