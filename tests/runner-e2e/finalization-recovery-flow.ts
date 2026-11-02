import { waitForRunDelivery } from "./run-delivery.js";
import { captureStockHarness, gradeStockHire } from "./stock-harness.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { readFinalizationCrashBoundary, type FinalizationCrashBinding } from "./finalization-crash-boundary.js";
import { finalizationFiles, finalizationResultDigest, parseFinalizationProof, FINALIZATION_PAYLOAD_BYTES, gradeFinalizationRecovery, type FinalizationRecoveryObservation } from "./finalization-recovery.js";
import { readRegisteredArtifacts } from "./registered-artifact.js";
import { createTaskThroughUi } from "./user-actions.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
const acceptedResults = (events: Row[]) => events.flatMap(event => event.payload?.prpEvent?.eventType === "run.result.accepted"
  ? [event.payload.prpEvent.payload.result] : []);
const providerTurns = (events: Row[]) => events.filter(event => event.payload?.prpEvent?.eventType === "turn.started" && event.payload.prpEvent.sourceKind === "runner").length;
const eventReceipts = (events: Row[]) => events.flatMap(event => {
  const value = event.payload?.prpEvent;
  return value && ["run.result.accepted", "turn.started"].includes(value.eventType)
    ? [{ runId: value.runId, sourceInstanceId: value.sourceInstanceId, sourceEventId: value.sourceEventId,
      sourceSeq: value.sourceSeq, eventType: value.eventType, emittedAt: value.emittedAt }] : [];
});

export async function runFinalizationRecoveryFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  temporaryRoot: string; deadlineAt: number; restart(binding: FinalizationCrashBinding): Promise<void>;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeFinalizationRecovery>): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { page, api, fixtures, execution } = input, files = finalizationFiles(input.nonce);
  if (execution.environment.id !== "daytona" || !fixtures.project) throw new Error("Finalization recovery requires its owned remote workspace");
  let issue: Row | undefined, runs: Row[] = [], beforeProof: Awaited<ReturnType<typeof readRegisteredArtifacts>>[number] | undefined;
  let observation: FinalizationRecoveryObservation | undefined, proof: ReturnType<typeof parseFinalizationProof> | undefined;
  const events = (runId: string) => collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`));
  async function refresh() {
    if (!issue) return;
    const [current, listed] = await Promise.all([
      api.get<Row>(`/api/issues/${issue.id}`),
      api.get<Row[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?agentId=${fixtures.agent.id}&limit=20`),
    ]);
    issue = current;
    runs = (await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`))))
      .filter(run => run.agentId === fixtures.agent.id);
    if (observation) input.observe(issue, runs, gradeFinalizationRecovery(observation));
  }
  async function save(phase: string) {
    if (observation) await input.evidence("finalization-recovery.json", { phase, observation, checks: gradeFinalizationRecovery(observation) });
    await input.evidence("api-state.json", { capturePhase: phase,
      issue: issue ? { id: issue.id, companyId: issue.companyId, status: issue.status, executionRunId: issue.executionRunId,
        executionWorkspaceId: issue.executionWorkspaceId } : null,
      runs: runs.map(run => ({ id: run.id, companyId: run.companyId, nativeIssueId: run.nativeIssueId, status: run.status,
        runtimeMode: run.runtimeMode, nativePhase: run.nativePhase, startedAt: run.startedAt, finishedAt: run.finishedAt,
        finalizationPhase: run.resultJson?.finalizationPhase })) });
  }
  try {
    await api.patch(`/api/companies/${fixtures.company.id}/budgets`, { budgetMonthlyCents: 1000 });
    await api.patch(`/api/agents/${fixtures.agent.id}/budgets`, { budgetMonthlyCents: 1000 });
    const [company, agent] = await Promise.all([api.get<Row>(`/api/companies/${fixtures.company.id}`), api.get<Row>(`/api/agents/${fixtures.agent.id}`)]);
    if (company.budgetMonthlyCents !== 1000 || agent.budgetMonthlyCents !== 1000) throw new Error("Finalization recovery budgets were not retained");
    const instructions = await captureStockHarness({ api, companyId: fixtures.company.id, agentId: fixtures.agent.id, generation: "native", runIds: [] });
    if (gradeStockHire(instructions).some(check => !check.passed)) throw new Error("Finalization recovery requires the production default hire instructions");
    const created = await createTaskThroughUi({ page, issuePrefix: fixtures.company.issuePrefix!, agentName: fixtures.agent.name,
      projectName: fixtures.project.name, title: execution.task.buildTitle(input.nonce), prompt: execution.task.buildPrompt(input.nonce),
      workMode: "standard", requireExplicitTitle: true });
    issue = await api.get<Row>(`/api/issues/${created.issueId}`);
    await pollUntil({ label: "accepted result with unfinished workspace export", deadlineAt: input.deadlineAt, intervalMs: 100,
      load: async () => {
        await refresh();
        const run = runs[0];
        if (!run || runs.length !== 1 || run.nativePhase !== "workspace_finalizing") return false;
        const [operations, rows] = await Promise.all([api.get<Row[]>(`/api/heartbeat-runs/${run.id}/workspace-operations`), events(run.id)]);
        const pending = operations.filter(operation => operation.companyId === fixtures.company.id && operation.issueId === issue!.id &&
          operation.heartbeatRunId === run.id && operation.phase === "workspace_finalize" && operation.status === "running");
        const accepted = acceptedResults(rows);
        if (!pending.length || accepted.length !== 1 || providerTurns(rows) < 1) return false;
        [beforeProof] = await readRegisteredArtifacts(api, issue!.id, run.id, [files.proof]);
        proof = parseFinalizationProof(JSON.parse(beforeProof!.content));
        const binding = { companyId: fixtures.company.id, issueId: issue!.id, runId: run.id };
        await readFinalizationCrashBoundary(route => api.get(route), binding);
        await input.evidence("finalization-before.json", { binding, events: eventReceipts(rows), originalProof: proof,
          artifact: { id: beforeProof!.attachmentId, sha256: beforeProof!.sha256 },
          operations: pending.map(operation => ({ id: operation.id, companyId: operation.companyId, issueId: operation.issueId,
            heartbeatRunId: operation.heartbeatRunId, phase: operation.phase, status: operation.status, startedAt: operation.startedAt })) });
        observation = { binding, before: { resultDigest: finalizationResultDigest(accepted[0]), acceptedResults: accepted.length,
          providerTurns: providerTurns(rows), operationIds: pending.map(operation => operation.id), artifactId: beforeProof!.attachmentId,
          artifactSha256: beforeProof!.sha256 }, crash: null, final: null };
        return true;
      }, accept: Boolean,
      reject: () => runs.length > 1 ? "Unexpected provider admission before crash" : runs.some(run => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status) || run.nativePhase === "committed")
        ? "Finalization fault boundary was not exercised before settlement" : undefined });
    await save("before-crash");
    await page.goto("about:blank", { waitUntil: "commit" });
    await input.restart(observation!.binding);
    const ack = JSON.parse(await readFile(runnerE2EServerControlPaths(input.temporaryRoot).restartAcknowledgementPath, "utf8"));
    if (ack.requestId !== `finalization-${input.nonce}` || ack.status !== "ready" || !ack.crashBoundary) throw new Error("Crash restart has no boundary receipt");
    observation!.crash = ack.crashBoundary;
    await save("restarted");
    await pollUntil({ label: "original native run recovered without provider replay", deadlineAt: input.deadlineAt, intervalMs: 500,
      load: async () => { await refresh(); return runs[0]; },
      accept: run => run?.id === observation!.binding.runId && run.status === "succeeded" && run.nativePhase === "committed" &&
        run.resultJson?.finalizationPhase === "committed" && issue!.status === "done",
      reject: run => runs.length > 1 ? "Recovery repeated provider admission" : run && ["failed", "cancelled", "timed_out"].includes(run.status) ? "Original run did not recover" : undefined });
    let run = runs[0]!;
    const provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
    if (provider?.model !== execution.profile.model || (provider.kind === "acpx" ? `acpx:${provider.agent}` : provider.kind) !==
        (execution.profile.provider === "codex" ? "codex" : "acpx:claude")) throw new Error("Recovered run did not retain the configured provider and model");
    const [rows, operations, interactions, view, artifacts] = await Promise.all([
      events(run.id), api.get<Row[]>(`/api/heartbeat-runs/${run.id}/workspace-operations`),
      api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
      api.get<Row>(`/api/issues/${issue.id}/workspace`), readRegisteredArtifacts(api, issue.id, run.id, [files.proof]),
    ]);
    if (!proof) throw new Error("Missing original proof before crash");
    const cwd = await realpath(view.workspace.cwd), root = await realpath(input.temporaryRoot), file = path.join(cwd, files.data);
    if (!cwd.startsWith(`${root}${path.sep}`)) throw new Error("Finalization oracle escaped its fixture-owned workspace");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== FINALIZATION_PAYLOAD_BYTES || !((await realpath(file)).startsWith(`${cwd}${path.sep}`)))
      throw new Error("Restored binary is missing, linked, or the wrong size");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const delivered = await waitForRunDelivery({ binding: observation!.binding, agentId: fixtures.agent.id, deadlineAt: input.deadlineAt,
      load: async () => {
        await refresh();
        const [comments, attachments] = await Promise.all([api.get<Row[]>(`/api/issues/${issue!.id}/comments`),
          api.get<Row[]>(`/api/issues/${issue!.id}/attachments`)]);
        return { run: runs[0] ?? {}, runCount: runs.length, comments, attachments };
      } });
    run = delivered.run;
    const delivery = delivered.delivery;
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`);
    await expect(page.getByTestId("task-chat-agent-bubble").locator(`a[href*="${artifacts[0]!.attachmentId}"]`).last()).toBeVisible({ timeout: 30_000 });
    observation!.final = { runIds: runs.map(candidate => candidate.id), committed: run.runtimeMode === "native" && run.nativePhase === "committed",
      issueDone: issue.status === "done", resultDigest: finalizationResultDigest(run.resultJson.nativeResult), acceptedResults: acceptedResults(rows).length,
      providerTurns: providerTurns(rows), resumedOperations: operations.filter(operation => operation.companyId === fixtures.company.id && operation.issueId === issue!.id &&
        operation.heartbeatRunId === run.id && operation.phase === "workspace_finalize" && operation.status === "succeeded" && operation.metadata?.resumedFromOperationId)
        .map(operation => ({ resumedFromOperationId: operation.metadata.resumedFromOperationId, startedAt: operation.startedAt })),
      artifactId: artifacts[0]!.attachmentId, artifactSha256: artifacts[0]!.sha256, byteSize: stat.size,
      actualSha256: hash.digest("hex"), expectedSha256: proof.sha256, proofReference: proof.reference, finalDeliveryCount: delivery.finalDeliveryCount,
      deliveryReceiptMatches: delivery.deliveryReceiptMatches,
      visibleDelivery: true, pendingInteractions: interactions.filter(interaction => interaction.status === "pending").length };
    await input.evidence("finalization-after.json", { binding: observation!.binding, events: eventReceipts(rows),
      operations: operations.map(operation => ({ id: operation.id, companyId: operation.companyId, issueId: operation.issueId,
        heartbeatRunId: operation.heartbeatRunId, phase: operation.phase, status: operation.status, startedAt: operation.startedAt,
        finishedAt: operation.finishedAt, resumedFromOperationId: operation.metadata?.resumedFromOperationId })),
      restoredFile: { path: files.data, byteSize: stat.size, sha256: observation!.final.actualSha256 },
      delivery: { runId: run.id, status: run.issueCommentStatus, satisfiedByCommentId: run.issueCommentSatisfiedByCommentId,
        presentation: delivery.presentation, replies: delivery.replies } });
    const checks = gradeFinalizationRecovery(observation!);
    input.observe(issue, runs, checks);
    await save("completed");
    await input.capture("final-state", "Original accepted work delivered after finalization recovery", "final-state.png");
    if (checks.some(check => !check.passed)) throw new Error(`Finalization recovery failed: ${checks.filter(check => !check.passed).map(check => check.id).join(", ")}`);
    return { issue, runs, checks };
  } catch (error) { await refresh().catch(() => undefined); await save("failed"); throw error; }
}
