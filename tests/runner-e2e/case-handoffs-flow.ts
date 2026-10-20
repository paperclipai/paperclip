import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { collectRunEvents } from "./run-observations.js";
import { caseHandoffInstructions, CASE_HANDOFF_MAX_TURNS } from "./case-handoffs-cases.js";
import { caseHandoffRunFailure, gradeCaseHandoffs, hasNativeHandoffReceipt, type CaseHandoffObservation } from "./case-handoffs-scoring.js";
import { codexSubscriptionAgentConfig } from "./codex-subscription-fixture.js";

type Row = Record<string, any>;
export async function runCaseHandoffsFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  workspacePath: string; deadlineAt: number;
  observe(issue: Row, runs: Row[], checks: ReturnType<typeof gradeCaseHandoffs>, workflowCase: Row): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, page, fixtures, execution, nonce } = input;
  const companyPath = `/api/companies/${fixtures.company.id}`;
  const agents = { triage: fixtures.agent.id, implementation: "", verification: "" };
  let issue: Row | null = null, caseRecord: Row | null = null;
  let runs: Row[] = [], handoffs: Row[] = [];
  const documents: Record<string, Row> = {};
  const handoffToolRunIds: string[] = [];
  let observation: CaseHandoffObservation | null = null;
  async function refresh() {
    if (!issue || !caseRecord) return;
    [issue, caseRecord] = await Promise.all([
      api.get<Row>(`/api/issues/${issue.id}`), api.get<Row>(`/api/cases/${caseRecord.id}`),
    ]);
    const listed = await api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=100`);
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    const page = await api.get<Row>(`/api/cases/${caseRecord.id}/handoffs?limit=100`);
    handoffs = Array.isArray(page) ? page : page.items ?? page.handoffs ?? [];
  }
  async function save(phase: string) {
    if (!issue || !caseRecord) return;
    const [tasks, records, interactions] = await Promise.all([
      api.get<Row[]>(`${companyPath}/issues?limit=100&includeAgentCreatedTasks=true`),
      api.get<Row[]>(`${companyPath}/cases?limit=100`),
      api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
    ]);
    observation = { nonce, companyId: fixtures.company.id, taskId: issue.id, caseId: caseRecord.id,
      agents, issue, caseRecord, cases: records, tasks, handoffs, runs, documents, handoffToolRunIds,
      pendingInteractions: interactions.filter(row => row.status === "pending").length };
    const checks = gradeCaseHandoffs(observation);
    input.observe(issue, runs, checks, caseRecord);
    await input.evidence("case-handoffs.json", {
      schema: "paperclip.e2e.case-handoffs.v1", phase, expectedTurns: 4, maximumTurns: CASE_HANDOFF_MAX_TURNS,
      observation: { ...observation, issue: { id: issue.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId },
        caseRecord: { id: caseRecord.id, workIssueId: caseRecord.workIssueId, phase: caseRecord.phase, handoffVersion: caseRecord.handoffVersion, pendingHandoff: caseRecord.pendingHandoff ? { id: caseRecord.pendingHandoff.id, state: caseRecord.pendingHandoff.state, lastErrorCode: caseRecord.pendingHandoff.lastErrorCode } : null },
        cases: records.map(row => ({ id: row.id, workIssueId: row.workIssueId })), tasks: tasks.map(row => ({ id: row.id, status: row.status })),
        handoffs: handoffs.map(row => ({ id: row.id, caseId: row.caseId, issueId: row.issueId, version: row.version, phase: row.phase,
          state: row.state, sourceRunId: row.sourceRunId, fromAgentId: row.fromAgentId, toAgentId: row.toAgentId, lastErrorCode: row.lastErrorCode })),
        runs: runs.map(row => ({ id: row.id, companyId: row.companyId, issueId: row.issueId, nativeIssueId: row.nativeIssueId,
          agentId: row.agentId, status: row.status, runtimeMode: row.runtimeMode })),
      }, checks,
    });
    return checks;
  }
  try {
    await api.patch("/api/instance/settings/experimental", { enableCases: true });
    for (const role of ["implementation", "verification"] as const) {
      const payload = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: "local",
        workspacePath: input.workspacePath, secretRefs: fixtures.secretRefs, executionId: `${nonce}-${role}` });
      // Public reads redact environment values. Build each agent from the
      // original fixture config instead of copying a redacted response.
      const agent = await api.post<Row>(`${companyPath}/agents`, {
        ...codexSubscriptionAgentConfig(payload, process.env, fixtures.company.id),
        name: `Case ${role} ${nonce}`, role: "engineer",
      });
      agents[role] = agent.id;
    }
    const instructions = caseHandoffInstructions({ nonce, triageId: agents.triage, implementationId: agents.implementation, verificationId: agents.verification });
    const started = await api.post<Row>(`${companyPath}/case-handoffs`, { idempotencyKey: `kickoff-${nonce}`,
      case: { create: { caseType: "arithmetic-workflow", title: execution.task.buildTitle(nonce), summary: instructions, fields: { a: 2, b: 3, nonce } } },
      workflow_document_text: instructions,
      toAgentId: agents.triage, phase: "triage", instructions: `${nonce}: Read the primary task document workflow. Start phase triage and hand this same task to implementation.` });
    issue = await api.get<Row>(`/api/issues/${started.taskId}`);
    caseRecord = await api.get<Row>(`/api/cases/${started.caseId}`);
    input.observe(issue, runs, [], caseRecord);
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/cases/${encodeURIComponent(caseRecord.identifier)}`);
    await expect(page.getByRole("heading", { name: execution.task.buildTitle(nonce), exact: true })).toBeVisible();
    await input.capture("case-kickoff", "Case created with its primary task", "case-kickoff.png");
    await pollUntil({ label: "same-task case handoff roundtrip", deadlineAt: input.deadlineAt, intervalMs: 1000,
      load: async () => { await refresh(); await save("running"); return { issue, runs, caseRecord, handoffs }; },
      accept: state => state.issue?.status === "done" && state.runs.length >= 4 && state.runs.every(run => run.status === "succeeded")
        && state.handoffs.length === 4 && state.handoffs.every(handoff => handoff.state === "delivered"),
      reject: state => state.runs.length > CASE_HANDOFF_MAX_TURNS ? "Provider turn cap exceeded"
        : caseHandoffRunFailure(state.runs)
          ?? (state.handoffs.some(handoff => handoff.state === "cancelled") ? "A workflow handoff was cancelled" : undefined),
    });
    for (const key of ["answer", "phase-triage", "phase-implementation", "phase-verification", "phase-revision"]) {
      documents[key] = await api.get<Row>(`/api/issues/${issue!.id}/documents/${key}`);
    }
    for (const run of runs) {
      const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
      if (hasNativeHandoffReceipt(events)) handoffToolRunIds.push(run.id);
    }
    const checks = await save("completed");
    const failed = checks?.filter(check => !check.passed) ?? [];
    if (!checks?.length || failed.length) throw new Error(`Case handoff oracle failed: ${failed.map(check => check.id).join(", ") || "missing evidence"}`);
    await page.reload();
    const work = page.getByRole("region", { name: "Case work", exact: true });
    await expect(work).toBeVisible();
    await expect(work.getByText("revision", { exact: true })).toBeVisible();
    const history = page.getByRole("region", { name: "Case handoffs", exact: true });
    await expect(history.locator(":scope > ol > li")).toHaveCount(4);
    await history.locator("summary").filter({ has: page.getByText("verification", { exact: true }) }).click();
    await expect(history).toContainText("verification");
    await input.capture("case-final", "Persistent case and handoff history after verification", "case-final.png");
    await page.goto(`/${encodeURIComponent(fixtures.company.issuePrefix!)}/issues/${encodeURIComponent(issue!.identifier ?? issue!.id)}`);
    await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
    await expect(page.getByTestId("task-chat-agent-bubble").filter({ hasText: `CASE-HANDOFF-DONE-${nonce}` }).last()).toBeVisible();
    await input.capture("task-final", "The original task completed by the returning implementation agent", "task-final.png");
    return { issue: issue!, runs, checks };
  } catch (error) {
    await refresh().catch(() => undefined);
    await save("failed").catch(() => undefined);
    throw error;
  }
}
