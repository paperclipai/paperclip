import { storyRepliesConsumed } from "./everyday-observations.js";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { readRegisteredArtifacts, RegisteredArtifactNotFoundError } from "./registered-artifact.js";
import { captureStockHarness, gradeStockHire } from "./stock-harness.js";
import { createTaskThroughUi, submitTaskReply } from "./user-actions.js";
import { waitForRunDelivery } from "./run-delivery.js";
import { followupStopApiState } from "./followup-stop-evidence.js";
import { downloadTaskTextArtifact } from "./task-text-artifact-download.js";
import { stopRunBelongsToTask, isActiveStopCheckpointRun, exactSyntheticJson, followupStopFiles, gradeFollowupStopResume, STOP_QUIET_WINDOW_MS, type FollowupStopObservation } from "./followup-stop-resume.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
export async function runFollowupStopResumeFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; temporaryRoot: string; deadlineAt: number;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeFollowupStopResume>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution } = input, files = followupStopFiles(input.nonce);
  if (execution.environment.id !== "local" || !fixtures.project) throw new Error("Stop/resume requires its owned local workspace");
  const workspace = await realpath(input.workspacePath), temporaryRoot = await realpath(input.temporaryRoot);
  if (!workspace.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error("Stop/resume source escaped its owned fixture");
  const source = `${randomBytes(32).toString("hex")}\n`, sourceSha256 = createHash("sha256").update(source).digest("hex");
  const contextPath = path.join(workspace, files.context);
  await writeFile(contextPath, source, { flag: "wx" });
  let issue: Row | undefined, runs: Row[] = [];
  const observation: FollowupStopObservation = { binding: { companyId: fixtures.company.id, agentId: fixtures.agent.id, issueId: "" },
    initial: null, followup: null, stop: null, final: null };
  const runEvents = (id: string) => collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const prpEvents = (rows: Row[], runId: string) => rows.flatMap(row => row.payload?.prpEvent?.runId === runId ? [row.payload.prpEvent] : []);
  async function refresh() {
    if (!issue) return;
    const [current, listed] = await Promise.all([api.get<Row>(`/api/issues/${issue.id}`),
      api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?agentId=${fixtures.agent.id}&limit=20`)]);
    issue = current;
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    if (runs.some(run => !stopRunBelongsToTask(run, observation.binding)))
      throw new Error("Stop/resume admitted work outside its original task");
    input.observe(issue, runs, gradeFollowupStopResume(observation));
  }
  function retainedRuntime(run: Row) {
    const native = run.runnerProfileJson?.nativeExecutionInput, provider = native?.provider;
    if (native?.binding?.runId !== run.id || native.binding.companyId !== fixtures.company.id || native.binding.issueId !== issue!.id ||
        native.binding.agentId !== fixtures.agent.id || provider?.model !== execution.profile.model ||
        (provider.kind === "acpx" ? `acpx:${provider.agent}` : provider.kind) !== (execution.profile.provider === "codex" ? "codex" : "acpx:claude"))
      throw new Error("Stop/resume runtime did not retain its task, owner, provider and model");
    return { instructionsDigest: String(native.runtimeContext?.instructions?.bundle?.digest ?? ""),
      toolFingerprint: String(run.runnerProfileJson?.nativeToolContractFingerprint ?? "") };
  }
  async function persist(phase: string) {
    await input.evidence("followup-stop-resume.json", { phase, observation, checks: gradeFollowupStopResume(observation) });
    await input.evidence("api-state.json", followupStopApiState(phase, issue, runs));
  }
  async function submit(body: string) {
    const before = await api.get<Row[]>(`/api/issues/${issue!.id}/comments`);
    const submittedAt = new Date().toISOString();
    await submitTaskReply(page, body);
    const added = await pollUntil({ label: "one persisted ordinary user message", deadlineAt: input.deadlineAt, intervalMs: 100,
      load: async () => (await api.get<Row[]>(`/api/issues/${issue!.id}/comments`)).filter(comment => !before.some(prior => prior.id === comment.id) &&
        comment.issueId === issue!.id && comment.companyId === fixtures.company.id && comment.authorUserId && !comment.authorAgentId && comment.body === body),
      accept: rows => rows.length === 1, reject: rows => rows.length > 1 ? "Duplicate ordinary user message" : undefined });
    return { commentIds: added.map(comment => comment.id), submittedAt };
  }
  const automaticPath = () => Boolean(issue?.executionRunId || issue?.scheduledRetry || issue?.activeRecoveryAction || issue?.monitorNextCheckAt ||
    runs.some(run => ["queued", "running", "scheduled_retry"].includes(run.status)));
  try {
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, { budgetMonthlyCents: 1000 });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, { budgetMonthlyCents: 1000 });
    const stock = await captureStockHarness({ api, companyId: fixtures.company.id, agentId: fixtures.agent.id, generation: "native", runIds: [] });
    if (gradeStockHire(stock).some(check => !check.passed)) throw new Error("Stop/resume requires production hire instructions and both hard stops");
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      projectName: fixtures.project.name, title: execution.task.buildTitle(input.nonce), prompt: execution.task.buildPrompt(input.nonce),
      workMode: "standard", requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    observation.binding.issueId = issue.id;
    await pollUntil({ label: "verified checkpoint during active provider work", deadlineAt: input.deadlineAt, intervalMs: 250, retryOnError: () => false,
      load: async () => {
        await refresh();
        const run = runs[0];
        if (runs.length !== 1 || !run || run.status !== "running" || run.runtimeMode !== "native" || run.nativeIssueId !== issue!.id) return false;
        const events = prpEvents(await runEvents(run.id), run.id);
        if (!isActiveStopCheckpointRun(run, events)) return false;
        const checkpoint = await readRegisteredArtifacts(api, issue!.id, run.id, [files.checkpoint])
          .then(([artifact]) => artifact).catch(error => {
            if (error instanceof RegisteredArtifactNotFoundError) return null;
            throw error;
          });
        if (!checkpoint) return false;
        if (!exactSyntheticJson(checkpoint.content, { sourceSha256, label: files.initialLabel })) throw new Error("Checkpoint does not match the independent source");
        const view = await api.get<Row>(`/api/issues/${issue!.id}/workspace`);
        if (await realpath(view.workspace.cwd) !== workspace || !issue!.executionWorkspaceId) throw new Error("Stop/resume did not use its configured workspace");
        observation.initial = { runId: run.id, workspaceId: issue!.executionWorkspaceId, ...retainedRuntime(run), checkpointVerified: true };
        await input.evidence("stop-resume-checkpoint.json", { artifactId: checkpoint.attachmentId, sha256: checkpoint.sha256, sourceSha256 });
        return true;
      }, accept: Boolean, reject: () => runs.length > 1 || runs.some(run => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status))
        ? "Active checkpoint boundary was not exercised" : undefined });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const followup = await submit(`Use ${files.finalLabel} as the label in the final result instead of the initial label. Keep the saved context file and finish the ongoing work.`);
    await refresh();
    const active = runs.find(run => run.id === observation.initial!.runId)!;
    const activeEvents = prpEvents(await runEvents(active.id), active.id);
    observation.followup = { commentIds: followup.commentIds, runId: active.id, runStatus: active.status,
      acceptedResults: activeEvents.filter(event => event.eventType === "run.result.accepted").length,
      providerStarted: activeEvents.some(event => event.eventType === "turn.started"), observedAt: new Date().toISOString() };
    if (runs.length !== 1 || !isActiveStopCheckpointRun(active, activeEvents))
      throw new Error("Follow-up was not recorded before the original active Stop boundary");
    await persist("followup-during-work");
    await input.capture("before-stop", "Follow-up persisted during original active work", "before-stop.png");
    await page.getByTestId("task-chat-composer-stop").last().click();
    await pollUntil({ label: "acknowledged original-run Stop", deadlineAt: input.deadlineAt, intervalMs: 200,
      load: async () => { await refresh(); return runs.find(run => run.id === active.id); },
      accept: run => run?.status === "cancelled" && !automaticPath(),
      reject: run => runs.length !== 1 ? "Stop admitted another run" : run && ["succeeded", "failed", "timed_out"].includes(run.status) ? "Stop did not cancel the original active work" : undefined });
    const stopped = runs[0]!, stop = stopped.resultJson?.nativeCancellation;
    const acknowledged = stop?.schema === "paperclip.native-cancellation.v1" && stop.companyId === fixtures.company.id &&
      stop.issueId === issue.id && stop.runId === stopped.id && stop.scope === "run" && stop.dispatched === true &&
      stop.dispatchState === "acknowledged" && stop.reasonCode === "cancellation_run_only" && typeof stop.intentId === "string" &&
      typeof stop.intentAuditId === "string" && typeof stop.acknowledgementAuditId === "string" && stop.intentAuditId !== stop.acknowledgementAuditId;
    observation.stop = { runId: stopped.id, status: stopped.status, acknowledgementMatches: Boolean(acknowledged), samples: [], resumeSubmittedAt: null };
    if (!acknowledged) throw new Error("Original user Stop lacks its matching durable acknowledgement");
    await page.reload();
    let quietStarted: number | undefined;
    do {
      await refresh();
      quietStarted ??= Date.now();
      observation.stop.samples.push({ at: new Date().toISOString(), runIds: runs.map(run => run.id), automaticPath: automaticPath() });
      if (runs.length !== 1 || runs[0]!.status !== "cancelled" || automaticPath()) throw new Error("Stopped work resumed before the real user message");
      if (Date.now() - quietStarted >= STOP_QUIET_WINDOW_MS) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < input.deadlineAt);
    await persist("stopped-before-resume");
    await input.capture("stopped", "Stopped task stays idle before explicit user resumption", "stopped.png");
    const resumed = await submit("Resume the same task now. Skip the earlier foreground delay because I interrupted it. Finish using the existing context file and my latest earlier label instruction, and deliver the requested result here.");
    observation.stop.resumeSubmittedAt = resumed.submittedAt;
    await pollUntil({ label: "one explicit resumed admission with verified output", deadlineAt: input.deadlineAt, intervalMs: 500,
      load: async () => { await refresh(); return runs.filter(run => run.id !== active.id); },
      accept: rows => rows.length === 1 && rows[0]!.status === "succeeded" && rows[0]!.nativePhase === "committed" && issue!.status === "done",
      reject: rows => rows.length > 1 ? "Explicit resumption duplicated work" : rows.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Explicit resumption failed" : undefined });
    const resumedRun = runs.find(run => run.id !== active.id)!;
    const delivered = await waitForRunDelivery({ binding: { companyId: fixtures.company.id, issueId: issue.id, runId: resumedRun.id },
      agentId: fixtures.agent.id, deadlineAt: input.deadlineAt, load: async () => {
        await refresh();
        const [comments, attachments] = await Promise.all([api.get<Row[]>(`/api/issues/${issue!.id}/comments`),
          api.get<Row[]>(`/api/issues/${issue!.id}/attachments`)]);
        return { run: runs.find(run => run.id === resumedRun.id) ?? {}, runCount: runs.filter(run => run.id !== active.id).length,
          comments, attachments };
      } });
    const [artifact] = await readRegisteredArtifacts(api, issue.id, resumedRun.id, [files.result]);
    const [interactions, view, allIssues] = await Promise.all([api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
      api.get<Row>(`/api/issues/${issue.id}/workspace`), api.get<Row[]>(`/api/companies/${fixtures.company.id}/issues?limit=100`)]);
    if (allIssues.length !== 1 || await realpath(view.workspace.cwd) !== workspace) throw new Error("Explicit resumption changed its task or configured workspace");
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const downloadPath = await downloadTaskTextArtifact(page, artifact!.attachmentId, files.result);
    if (!exactSyntheticJson(await readFile(downloadPath, "utf8"), { reference: source.trimEnd(), label: files.finalLabel }))
      throw new Error("Browser download did not retain the independently seeded context and earlier follow-up");
    observation.final = { runIds: runs.map(run => run.id), resumedRunId: resumedRun.id, workspaceId: issue.executionWorkspaceId,
      sourceUnchanged: (await readFile(contextPath, "utf8")) === source,
      resultVerified: Boolean(artifact && exactSyntheticJson(artifact.content, { reference: source.trimEnd(), label: files.finalLabel })),
      issueDone: issue.status === "done", resumeCommentBound: storyRepliesConsumed([delivered.run as any], resumed.commentIds), originalStillCancelled: runs.find(run => run.id === active.id)?.status === "cancelled",
      committed: delivered.run.nativePhase === "committed" && delivered.run.runtimeMode === "native", startedAt: resumedRun.startedAt,
      ...retainedRuntime(delivered.run), ...delivered.delivery, visibleDelivery: true,
      pendingInteractions: interactions.filter(row => row.status === "pending").length };
    await input.evidence("stop-resume-final-delivery.json", { runId: resumedRun.id, resumeCommentIds: resumed.commentIds,
      artifactId: artifact!.attachmentId, sha256: artifact!.sha256, sourceSha256, delivery: delivered.delivery });
    const checks = gradeFollowupStopResume(observation);
    input.observe(issue, runs, checks);
    await persist("completed");
    await input.capture("final-state", "Explicitly resumed work delivers retained context and follow-up", "final-state.png");
    if (checks.some(check => !check.passed)) throw new Error(`Stop/resume qualification failed: ${checks.filter(check => !check.passed).map(check => check.id).join(", ")}`);
    return { issue, runs, checks };
  } catch (error) { await refresh().catch(() => undefined); await persist("failed"); throw error; }
}
