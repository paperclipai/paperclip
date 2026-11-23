import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { createTaskThroughUi } from "./user-actions.js";
import { convertRepositoryProofAgent } from "./repository-conversion-setup.js";
import { readRegisteredArtifacts } from "./registered-artifact.js";
import { gradeRepositoryProof, repositoryConfigurationDigest, repositoryProofFiles, type RepositoryProofObservation } from "./repository-verification.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
const execFile = promisify(execFileCallback);

export async function runRepositoryVerificationFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; temporaryRoot: string; deadlineAt: number;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeRepositoryProof>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const files = repositoryProofFiles(nonce), conversion = execution.task.id === "convert-and-deliver";
  let issue: Row | undefined, runs: Row[] = [];
  const expectedLegacyAdapter = execution.profile.provider === "codex" ? "codex_local" : "claude_local";
  const observation: RepositoryProofObservation = { conversion, expectedLegacyAdapter, originalAdapter: "", finalAdapter: "",
    configurationBefore: "", configurationAfter: "", instructionsBefore: "", instructionsAfter: "", permissionsPreserved: false,
    expectedModel: execution.profile.model, actualModel: null, expectedProvider: execution.profile.provider === "codex" ? "codex" : "acpx:claude",
    actualProvider: null, environmentRetained: false, issueDone: false, runCount: 0, committedRuns: 0,
    sourceBytes: "", currentSourceBytes: null, expectedCommit: "", downloaded: null, downloadVerified: false,
    visibleDelivery: false, pendingInteractions: -1 };
  async function instructionsDigest() {
    const bundle = await api.get<{ entryFile: string; files: Array<{ path: string }> }>(`/api/agents/${fixtures.agent.id}/instructions-bundle`);
    const files = await Promise.all([...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).map(async file => ({
      path: file.path, content: (await api.get<{ content: string }>(`/api/agents/${fixtures.agent.id}/instructions-bundle/file?path=${encodeURIComponent(file.path)}`)).content,
    })));
    if (bundle.entryFile !== "AGENTS.md" || files.length !== 1 || files[0]?.content !== "You are an agent in a Paperclip company.\n")
      throw new Error("Repository proof requires the shipped default hire instructions, without a fixture manual");
    return createHash("sha256").update(JSON.stringify({ entryFile: bundle.entryFile, files })).digest("hex");
  }
  async function refresh() {
    if (!issue) return;
    issue = await api.get<Row>(`/api/issues/${issue.id}`);
    const listed = await api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?agentId=${fixtures.agent.id}&limit=20`);
    runs = (await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`))))
      .filter(run => [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].includes(issue!.id));
    observation.issueDone = issue.status === "done";
    observation.runCount = runs.length;
    observation.committedRuns = runs.filter(run => run.status === "succeeded" && run.runtimeMode === "native" &&
      run.nativePhase === "committed" && run.resultJson?.finalizationPhase === "committed").length;
    const provider = runs[0]?.runnerProfileJson?.nativeExecutionInput?.provider;
    observation.actualModel = provider?.model ?? null;
    observation.actualProvider = provider ? provider.kind === "acpx" ? `acpx:${provider.agent}` : provider.kind : null;
    observation.environmentRetained = runs.length === 1 && runs[0]?.contextSnapshot?.paperclipEnvironment?.id === fixtures.environment.id;
  }
  async function save(phase: string) {
    const checks = gradeRepositoryProof(observation);
    if (issue) {
      input.observe(issue, runs, checks);
      await input.evidence("api-state.json", {
        capturePhase: phase,
        issue: { id: issue.id, companyId: issue.companyId, identifier: issue.identifier, status: issue.status,
          assigneeAgentId: issue.assigneeAgentId, executionWorkspaceId: issue.executionWorkspaceId, statusVersion: issue.statusVersion },
        runs: runs.map(run => ({ id: run.id, companyId: run.companyId, agentId: run.agentId, issueId: run.issueId,
          nativeIssueId: run.nativeIssueId, status: run.status, runtimeMode: run.runtimeMode, nativePhase: run.nativePhase,
          startedAt: run.startedAt, finishedAt: run.finishedAt, errorCode: run.errorCode,
          finalizationPhase: run.resultJson?.finalizationPhase })),
        checks,
      });
    }
    await input.evidence("repository-verification.json", { schema: "paperclip.e2e.repository-verification.v1", phase, observation, checks,
      runs: runs.map(run => ({ id: run.id, status: run.status, nativePhase: run.nativePhase, source: run.contextSnapshot?.source,
        startedAt: run.startedAt, finishedAt: run.finishedAt })) });
  }
  try {
    if (!fixtures.project || execution.profile.generation !== "native") throw new Error("Repository proof requires its owned configured project");
    const workspace = await realpath(input.workspacePath), root = await realpath(input.temporaryRoot);
    if (workspace !== path.join(root, "workspace")) throw new Error("Repository proof cannot seed an unowned source checkout");
    const git = async (args: string[]) => (await execFile("git", ["-C", workspace, ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeout: 20_000, maxBuffer: 262_144, encoding: "utf8",
    })).stdout;
    observation.sourceBytes = `${randomBytes(32).toString("hex")}\n`;
    await writeFile(path.join(workspace, files.source), observation.sourceBytes, { flag: "wx" });
    await git(["init", "--initial-branch=verification"]);
    await git(["add", "--", files.source]);
    await git(["-c", "user.name=Qualification Fixture", "-c", "user.email=qualification@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Seed independent repository reference"]);
    observation.expectedCommit = (await git(["rev-parse", "HEAD"])).trim();
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, { budgetMonthlyCents: 1000 });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, { budgetMonthlyCents: 1000 });
    const before = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    const company = await api.get<Row>(`/api/companies/${fixtures.company.id}`);
    if (before.budgetMonthlyCents !== 1000 || company.budgetMonthlyCents !== 1000) throw new Error("Repository proof hard-stop budgets were not retained");
    if (before.adapterType !== (conversion ? expectedLegacyAdapter : "paperclip_runner")) throw new Error("Initial adapter does not match the requested journey");
    observation.originalAdapter = before.adapterType;
    observation.configurationBefore = repositoryConfigurationDigest(before);
    observation.instructionsBefore = await instructionsDigest();
    if (conversion) await convertRepositoryProofAgent(api, fixtures);
    const after = await api.get<Row>(`/api/agents/${fixtures.agent.id}`);
    observation.finalAdapter = after.adapterType;
    observation.configurationAfter = repositoryConfigurationDigest(after);
    observation.instructionsAfter = await instructionsDigest();
    observation.permissionsPreserved = (conversion ? before.adapterConfig?.dangerouslySkipPermissions === true : true) &&
      (execution.profile.provider === "codex" ? after.adapterConfig?.codexPermissionMode === "never" : after.adapterConfig?.acpxPermissionMode === "approve-all");
    if (after.defaultEnvironmentId !== fixtures.environment.id || observation.configurationBefore !== observation.configurationAfter ||
        observation.instructionsBefore !== observation.instructionsAfter || !observation.permissionsPreserved || after.adapterType !== "paperclip_runner")
      throw new Error("Production runner selection did not retain the configured agent context");
    await save("configured");
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      projectName: fixtures.project.name, title: execution.task.buildTitle(nonce), prompt: execution.task.buildPrompt(nonce), workMode: "standard", requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`);
    await pollUntil({ label: "configured repository result", deadlineAt: input.deadlineAt, intervalMs: 1000,
      load: async () => { await refresh(); return { issue, runs }; },
      accept: () => observation.issueDone && observation.committedRuns === 1,
      reject: state => state.runs.length > 1 ? "Unexpected extra provider admission" : state.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status))
        ? "Provider admission failed" : state.runs.length && state.runs.every(run => run.status === "succeeded") && ["blocked", "in_review"].includes(state.issue!.status) ? "Task stopped before delivery" : undefined });
    const context = await api.get<Row>(`/api/issues/${issue.id}/file-resources/content?workspace=execution&path=${encodeURIComponent(files.source)}`);
    observation.currentSourceBytes = context.resource?.workspaceKind === "execution_workspace" && typeof context.content?.data === "string" ? context.content.data : null;
    const [artifact] = await readRegisteredArtifacts(api, issue.id, runs[0]!.id, [files.result]);
    observation.downloaded = JSON.parse(artifact.content);
    observation.downloadVerified = artifact.contentVerified;
    observation.pendingInteractions = (await api.get<Row[]>(`/api/issues/${issue.id}/interactions`)).filter(row => row.status === "pending").length;
    await page.reload();
    await expect(page.locator(`a[href*="${artifact.attachmentId}"]`).first()).toBeVisible({ timeout: 30_000 });
    observation.visibleDelivery = true;
    await save("completed");
    await input.capture("final-state", "Verified configured repository delivery", "final-state.png");
    const checks = gradeRepositoryProof(observation), failed = checks.filter(check => !check.passed);
    if (failed.length) throw new Error(`Repository verification failed: ${failed.map(check => check.id).join(", ")}`);
    return { issue, runs, checks };
  } catch (error) { await refresh().catch(() => undefined); await save("failed"); throw error; }
}
