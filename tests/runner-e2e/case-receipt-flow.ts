import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { pollUntil, RunnerApiHttpError } from "./api.js";
import type { runCaseHandoffsFlow } from "./case-handoffs-flow.js";
import { caseHandoffRunFailure, hasNativeHandoffReceipt } from "./case-handoffs-scoring.js";
import {
  CASE_RECEIPT_BUDGET_CENTS, CASE_RECEIPT_MAX_TURNS, CASE_RECEIPT_RUN_TIMEOUT_MS,
  caseReceiptAgentPrompt,
} from "./case-receipt-cases.js";
import { gradeCaseReceipt, hasTaskDocumentRead, type CaseReceiptObservation } from "./case-receipt-scoring.js";
import { codexSubscriptionAgentConfig } from "./codex-subscription-fixture.js";
import { collectRunEvents } from "./run-observations.js";

type Row = Record<string, any>;
type Input = Parameters<typeof runCaseHandoffsFlow>[0];
const roles = ["triage", "implementation", "verification"] as const;

/** A real-provider smoke with tiny work products and ordinary production APIs. */
export async function runCaseReceiptFlow(input: Input) {
  const { api, page, fixtures, execution, nonce } = input;
  const companyPath = `/api/companies/${fixtures.company.id}`;
  const agents = { triage: fixtures.agent.id, implementation: "", verification: "" };
  const configuredAgents: Row[] = [];
  const setupObservations: Row[] = [];
  let issue: Row | null = null;
  let caseRecord: Row | null = null;
  let runs: Row[] = [], handoffs: Row[] = [];
  let receipt: Row | null = null, review: Row | null = null, initialBrief: Row | null = null;
  let triageReadBrief = false;
  let receiptRevisions: Row[] = [];
  let kickoffReplayed = false, verifierReadReceipt = false, builderReadReview = false;
  const handoffToolRunIds: string[] = [];
  let budgetEvidence: CaseReceiptObservation["budgets"];
  const utcDay = new Date().toISOString().slice(0, 10);
  const configuredLimits = { maxRuns: CASE_RECEIPT_MAX_TURNS, runTimeoutMs: CASE_RECEIPT_RUN_TIMEOUT_MS,
    attemptTimeoutMs: execution.task.attemptTimeoutMs.local, automaticRetryPolicy: execution.task.automaticRetryPolicy,
    agents: configuredAgents };
  const agentConfig = (role: typeof roles[number], original: Row) => ({
    ...original, budgetMonthlyCents: CASE_RECEIPT_BUDGET_CENTS,
    adapterConfig: { ...original.adapterConfig, timeoutSec: CASE_RECEIPT_RUN_TIMEOUT_MS / 1000, modelReasoningEffort: "low" },
    runtimeConfig: { ...original.runtimeConfig, heartbeat: { ...original.runtimeConfig?.heartbeat,
      enabled: false, maxConcurrentRuns: 1, maxDailyRuns: role === "implementation" ? 2 : 1,
      maxDailyCostCents: CASE_RECEIPT_BUDGET_CENTS } },
  });
  async function waitForReady(role: typeof roles[number]) {
    // Production setup performs a small provider probe outside heartbeat usage.
    // Observe the initial attempt; do not restart setup or wait for its 60s retry.
    await pollUntil({ label: `receipt ${role} readiness`, deadlineAt: Math.min(input.deadlineAt, Date.now() + 45_000), intervalMs: 500,
      load: async () => {
        const agent = await api.get<Row>(`/api/agents/${agents[role]}`);
        const observation = { role, agentId: agent.id, lifecycleState: agent.lifecycleState,
          status: agent.status, lifecycleError: agent.lifecycleError, lifecycleHolds: agent.lifecycleHolds,
          observedAt: new Date().toISOString() };
        const previous = setupObservations.at(-1);
        if (!previous || previous.agentId !== agent.id || previous.lifecycleState !== agent.lifecycleState
          || previous.status !== agent.status || previous.lifecycleError !== agent.lifecycleError) setupObservations.push(observation);
        await input.evidence("receipt-setup.json", { observations: setupObservations,
          usageCoverage: "Production lifecycle hello probes are outside heartbeat usage; their tokens and cost are unavailable." });
        return agent;
      },
      accept: agent => agent.lifecycleState === "ready" && ["idle", "active"].includes(agent.status),
      reject: agent => agent.lifecycleError ? `Agent setup failed: ${agent.lifecycleError}`
        : agent.lifecycleHolds?.length ? `Agent setup held: ${agent.lifecycleHolds.join(", ")}`
          : ["paused", "rejected", "terminated"].includes(agent.lifecycleState) ? `Agent setup stopped: ${agent.lifecycleState}` : undefined,
    });
  }
  async function refresh() {
    if (!issue || !caseRecord) return;
    const [currentIssue, currentCase, listed, history] = await Promise.all([
      api.get<Row>(`/api/issues/${issue.id}`), api.get<Row>(`/api/cases/${caseRecord.id}`),
      api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=20`),
      api.get<Row>(`/api/cases/${caseRecord.id}/handoffs?limit=20`),
    ]);
    issue = currentIssue; caseRecord = currentCase;
    runs = await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`)));
    runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    handoffs = history.items ?? [];
    input.observe(issue, runs, [], caseRecord);
  }
  async function readDocument(key: string): Promise<Row | null> {
    try { const value = await api.get<Row>(`/api/issues/${issue!.id}/documents/${key}`); return value.document ?? value; }
    catch (error) { if (error instanceof RunnerApiHttpError && error.status === 404) return null; throw error; }
  }
  async function save(stage: string, failure?: unknown) {
    if (!issue || !caseRecord) return [];
    const [tasks, records, interactions] = await Promise.all([
      api.get<Row[]>(`${companyPath}/issues?limit=20&includeAgentCreatedTasks=true`),
      api.get<Row[]>(`${companyPath}/cases?limit=20`), api.get<Row[]>(`/api/issues/${issue.id}/interactions`),
    ]);
    const observation: CaseReceiptObservation = {
      nonce, companyId: fixtures.company.id, taskId: issue.id, caseId: caseRecord.id, agents,
      issue, caseRecord, tasks, cases: records, handoffs, runs, receipt, receiptRevisions, review,
      handoffToolRunIds, verifierReadReceipt, builderReadReview, kickoffReplayed,
      initialBrief, triageReadBrief, pendingInteractions: interactions.filter(row => row.status === "pending").length,
      configuredLimits, budgets: budgetEvidence,
    };
    const checks = gradeCaseReceipt(observation);
    input.observe(issue, runs, checks, caseRecord);
    const projectDocument = (value: Row | null): Row | null => value ? {
      id: value.id, issueId: value.issueId, companyId: value.companyId, key: value.key, body: value.body ?? value.latestBody,
      latestRevisionId: value.latestRevisionId, latestRevisionNumber: value.latestRevisionNumber,
      createdByAgentId: value.createdByAgentId, updatedByAgentId: value.updatedByAgentId,
      ...(value.revision ? { revision: value.revision } : {}),
    } : null;
    const publicObservation: CaseReceiptObservation = {
      nonce, companyId: fixtures.company.id, taskId: issue.id, caseId: caseRecord.id, agents,
      issue: { id: issue.id, companyId: issue.companyId, status: issue.status, assigneeAgentId: issue.assigneeAgentId },
      caseRecord: { id: caseRecord.id, identifier: caseRecord.identifier, companyId: caseRecord.companyId,
        workIssueId: caseRecord.workIssueId, status: caseRecord.status, phase: caseRecord.phase,
        handoffVersion: caseRecord.handoffVersion, completedAt: caseRecord.completedAt, fields: caseRecord.fields,
        pendingHandoff: caseRecord.pendingHandoff ? { id: caseRecord.pendingHandoff.id, state: caseRecord.pendingHandoff.state } : null },
      cases: records.map(row => ({ id: row.id, companyId: row.companyId, workIssueId: row.workIssueId,
        caseType: row.caseType, status: row.status, phase: row.phase, handoffVersion: row.handoffVersion, fields: { nonce: row.fields?.nonce } })),
      tasks: tasks.map(row => ({ id: row.id, status: row.status })),
      handoffs: handoffs.map(row => ({ id: row.id, companyId: row.companyId, caseId: row.caseId,
        issueId: row.issueId, version: row.version, phase: row.phase, state: row.state, destinationKind: row.destinationKind, fromAgentId: row.fromAgentId,
        toAgentId: row.toAgentId, sourceRunId: row.sourceRunId, expectedIssueStatusVersion: row.expectedIssueStatusVersion,
        appliedIssueStatusVersion: row.appliedIssueStatusVersion, assignmentAppliedAt: row.assignmentAppliedAt,
        deliveredAt: row.deliveredAt, completedAt: row.completedAt, lastErrorCode: row.lastErrorCode })),
      runs: runs.map(row => ({ id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status,
        runtimeMode: row.runtimeMode, issueId: row.issueId, nativeIssueId: row.nativeIssueId,
        startedAt: row.startedAt, finishedAt: row.finishedAt, errorCode: row.errorCode,
        contextSnapshot: { issueId: row.contextSnapshot?.issueId, taskId: row.contextSnapshot?.taskId,
          paperclipCase: row.contextSnapshot?.paperclipCase ? {
            id: row.contextSnapshot.paperclipCase.id, taskId: row.contextSnapshot.paperclipCase.taskId,
            phase: row.contextSnapshot.paperclipCase.phase, handoffVersion: row.contextSnapshot.paperclipCase.handoffVersion,
            issueStatusVersion: row.contextSnapshot.paperclipCase.issueStatusVersion,
            incomingHandoff: row.contextSnapshot.paperclipCase.incomingHandoff,
          } : undefined } })),
      receipt: projectDocument(receipt), receiptRevisions, review: projectDocument(review),
      handoffToolRunIds, verifierReadReceipt, builderReadReview, kickoffReplayed,
      initialBrief: projectDocument(initialBrief), triageReadBrief, pendingInteractions: observation.pendingInteractions, configuredLimits, budgets: budgetEvidence,
    };
    // Persist synthetic work products and allowlisted facts, never provider prompts/sessions.
    await input.evidence("case-receipt.json", {
      schema: "paperclip.e2e.case-receipt.v1", stage, checks, observation: publicObservation,
      ...(failure instanceof Error ? { failure: { message: failure.message.slice(0, 2000) } } : {}),
    });
    return checks;
  }
  try {
    // Daily limits must remain valid for the entire short attempt.
    if (Date.now() + execution.task.attemptTimeoutMs.local >= Date.parse(`${utcDay}T23:59:59.000Z`)) {
      throw new Error("Receipt smoke must not cross the UTC daily-run limit reset; no agents started");
    }
    await api.patch("/api/instance/settings/experimental", { enableCases: true });
    await waitForReady("triage");
    for (const role of ["implementation", "verification"] as const) {
      const original = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: "local",
        workspacePath: input.workspacePath, secretRefs: fixtures.secretRefs, executionId: `${nonce}-${role}` });
      const configured = agentConfig(role, execution.profile.credential === "CODEX_AUTH_JSON"
        ? codexSubscriptionAgentConfig(original, process.env, fixtures.company.id) : original);
      const agent = await api.post<Row>(`${companyPath}/agents`, { ...configured, name: `Receipt ${role} ${nonce}`, role: "engineer" });
      agents[role] = agent.id;
      await waitForReady(role);
    }
    for (const role of roles) {
      const detail = await api.get<Row>(`/api/agents/${agents[role]}/instructions-bundle/file?path=AGENTS.md`);
      if (typeof detail.content !== "string" || !detail.content.trim()) throw new Error("Missing production agent instructions");
      const appendix = caseReceiptAgentPrompt(role, agents, nonce);
      const appendedInstructions = `${detail.content}\n\n## Receipt smoke role\n\n${appendix}\n`;
      await api.saveAgentInstructions(agents[role], appendedInstructions);
      const savedInstructions = await api.get<Row>(`/api/agents/${agents[role]}/instructions-bundle/file?path=AGENTS.md`);
      if (savedInstructions.content !== appendedInstructions) throw new Error("Receipt role instructions were not preserved before provider admission");
      const persisted = await api.get<Row>(`/api/agents/${agents[role]}`);
      configuredAgents.push({ id: persisted.id, maxDailyRuns: persisted.runtimeConfig?.heartbeat?.maxDailyRuns,
        maxConcurrentRuns: persisted.runtimeConfig?.heartbeat?.maxConcurrentRuns, heartbeatEnabled: persisted.runtimeConfig?.heartbeat?.enabled,
        timeoutSec: persisted.adapterConfig?.timeoutSec, modelReasoningEffort: persisted.adapterConfig?.modelReasoningEffort });
      await input.evidence(`receipt-${role}-instructions.json`, { agentId: persisted.id,
        productionInstructionsSha256: createHash("sha256").update(detail.content).digest("hex"), appendixBytes: Buffer.byteLength(appendix) });
      await waitForReady(role);
    }
    const [company, ...persistedAgents] = await Promise.all([
      api.get<Row>(companyPath), ...roles.map(role => api.get<Row>(`/api/agents/${agents[role]}`)),
    ]);
    budgetEvidence = { company: { budgetMonthlyCents: company.budgetMonthlyCents },
      agents: persistedAgents.map(agent => ({ id: agent.id, budgetMonthlyCents: agent.budgetMonthlyCents })) };
    if (company.budgetMonthlyCents !== CASE_RECEIPT_BUDGET_CENTS
      || persistedAgents.some(agent => agent.budgetMonthlyCents !== CASE_RECEIPT_BUDGET_CENTS)) {
      throw new Error("Receipt smoke budget readback failed before provider admission");
    }
    for (const role of roles) {
      const bounds = configuredAgents.find(agent => agent.id === agents[role]);
      if (!bounds || bounds.maxDailyRuns !== (role === "implementation" ? 2 : 1)
        || bounds.maxConcurrentRuns !== 1 || bounds.heartbeatEnabled !== false
        || bounds.timeoutSec !== CASE_RECEIPT_RUN_TIMEOUT_MS / 1000 || bounds.modelReasoningEffort !== "low") {
        throw new Error(`Receipt ${role} limits readback failed before provider admission`);
      }
    }
    const project = await api.post<Row>(`${companyPath}/projects`, { name: `Receipts ${nonce}` });
    for (const [index, status] of ["draft", "done"].entries()) await api.post(`${companyPath}/cases`, {
      caseType: "receipt-research", key: `passive-${nonce}-${index}`, title: `Receipt notes ${index + 1} ${nonce}`,
      summary: "Passive filter fixture; no work requested.", status, fields: { nonce },
    });
    const kickoff = { idempotencyKey: `receipt-${nonce}`,
      case: { create: { caseType: "receipt-smoke", title: execution.task.buildTitle(nonce), projectId: project.id,
        summary: "Produce a receipt, have it independently reviewed, apply the requested currency correction, and finish the same task. Keep findings in ordinary primary-task documents.",
        fields: { nonce, items: [{ quantity: 2, unitPrice: 3 }], currency: "USD" } } },
      workflow_document_text: `Receipt workflow ${nonce}. Reuse this primary task throughout.
Triage (${agents.triage}) reads brief, validates all receipt inputs and saves inputsValidated, then hands off to implementation.
Implementation (${agents.implementation}) computes the total and writes receipt with total only; omit currency in the first revision so the independent reviewer can detect the missing field. Hand off to verification.
Verification (${agents.verification}) reads the saved receipt, independently recomputes its total and checks currency. Write review with totalCorrect and missing, then return the same task to implementation in phase revision.
Revision (${agents.implementation}) reads review and receipt, preserves the verified total, adds currency from case inputs and saves the next receipt revision. Hand off to done and complete the same task normally.
Use observed case/task versions, persist findings before each handoff, and obey existing completion gates. Exactly four runs; no additional tasks or cases.`,
      initialDocuments: [{ key: "brief", title: "Receipt brief", body: `Receipt ${nonce}: total and currency are required.` }],
      toAgentId: agents.triage, phase: "triage", instructions: `${nonce}: Read the primary task document workflow, inspect the saved receipt inputs and hand this same task to the builder, following your receipt role instructions.` };
    const started = await api.post<Row>(`${companyPath}/case-handoffs`, kickoff);
    // Set observable identities immediately so partial failures still retain their provenance.
    issue = { id: started.taskId }; caseRecord = { id: started.caseId };
    await refresh();
    const replay = await api.post<Row>(`${companyPath}/case-handoffs`, kickoff);
    kickoffReplayed = replay.replayed === true && replay.handoffId === started.handoffId
      && replay.taskId === started.taskId && replay.caseId === started.caseId;
    if (!kickoffReplayed) throw new Error("Receipt kickoff replay did not return the original handoff/task/case");
    await save("accepted");
    await page.goto(`/${fixtures.company.issuePrefix}/cases/${caseRecord!.identifier}`);
    await expect(page.getByRole("heading", { name: execution.task.buildTitle(nonce), exact: true })).toBeVisible();
    await input.capture("case-kickoff", "Receipt case with one primary task", "case-kickoff.png");
    await pollUntil({ label: "four-turn receipt smoke", deadlineAt: input.deadlineAt, intervalMs: 1000,
      load: async () => { await refresh(); return { issue, runs, handoffs }; },
      accept: state => state.issue?.status === "done" && state.runs.length === CASE_RECEIPT_MAX_TURNS
        && state.runs.every(run => run.status === "succeeded") && state.handoffs.length === 5
        && caseRecord?.status === "done"
        && state.handoffs.every(handoff => handoff.destinationKind === "done" ? handoff.state === "completed" : handoff.state === "delivered"),
      reject: state => state.runs.length > CASE_RECEIPT_MAX_TURNS ? "Receipt smoke provider execution cap exceeded"
        : caseHandoffRunFailure(state.runs) ?? (state.handoffs.some(handoff => handoff.state === "cancelled") ? "Receipt handoff cancelled"
          : state.issue?.status === "blocked" ? "Receipt task became blocked; inspect retained task/run evidence" : undefined),
    });
    [receipt, review, initialBrief] = await Promise.all([readDocument("receipt"), readDocument("review"), readDocument("brief")]);
    const [receiptHistory, reviewHistory] = await Promise.all([
      api.get<Row>(`/api/issues/${issue!.id}/documents/receipt/revisions`),
      api.get<Row>(`/api/issues/${issue!.id}/documents/review/revisions`),
    ]);
    receiptRevisions = Array.isArray(receiptHistory) ? receiptHistory : receiptHistory.revisions ?? [];
    if (review) review = { ...review, revision: (Array.isArray(reviewHistory) ? reviewHistory : reviewHistory.revisions)?.[0] };
    for (const run of runs) {
      const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
      if (hasNativeHandoffReceipt(events)) handoffToolRunIds.push(run.id);
      if (run.agentId === agents.triage) triageReadBrief ||= hasTaskDocumentRead(events, issue!.id, "brief");
      if (run.agentId === agents.verification) verifierReadReceipt ||= hasTaskDocumentRead(events, issue!.id, "receipt", true);
      if (run.agentId === agents.implementation && run.contextSnapshot?.paperclipCase?.phase === "revision") {
        builderReadReview ||= hasTaskDocumentRead(events, issue!.id, "review", true);
      }
    }
    const checks = await save("completed");
    const failed = checks.filter(check => !check.passed);
    if (!checks.length || failed.length) throw new Error(`Receipt smoke oracle failed: ${failed.map(check => check.id).join(", ") || "missing evidence"}`);
    await verifyReceiptBrowser(input, caseRecord!, issue!, receipt!);
    await save("browser-verified");
    return { issue: issue!, runs, checks };
  } catch (error) {
    await refresh().catch(() => undefined);
    if (caseRecord?.id) {
      if (!receipt) receipt = await readDocument("receipt").catch(() => null);
      if (!review) review = await readDocument("review").catch(() => null);
      await save("failed", error).catch(() => undefined);
    }
    throw error;
  } finally {
    // Retire only this disposable fixture's agents, including partial runs.
    for (const id of Object.values(agents).filter(Boolean)) await api.post(`/api/agents/${id}/pause`, {}).catch(() => undefined);
  }
}

export async function verifyReceiptBrowser(input: Pick<Input, "page" | "fixtures" | "execution" | "nonce" | "capture">, workflowCase: Row, task: Row, receipt: Row) {
  const { page, fixtures, nonce, execution } = input;
  const prefix = fixtures.company.issuePrefix!;
  await page.goto(`/${prefix}/cases`);
  const cases = () => page.getByRole("region", { name: "Case list" });
  await expect(cases().getByRole("link")).toHaveCount(3);
  await page.getByRole("button", { name: /^Filter cases/ }).click();
  await page.getByLabel("Filter by project", { exact: true }).click();
  await page.getByRole("option", { name: "No project", exact: true }).click();
  await expect(page.getByRole("button", { name: "Filter by project", exact: true })).toHaveText("No project");
  await page.keyboard.press("Escape");
  await expect(cases().getByRole("link")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: /^Filter cases/ }).click();
  await page.getByLabel("Filter by type", { exact: true }).click();
  await page.getByRole("option", { name: "receipt-smoke", exact: true }).click();
  await expect(page.getByRole("button", { name: "Filter by type", exact: true })).toHaveText("receipt-smoke");
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.get("type")).toBe("receipt-smoke");
  await expect(cases().getByRole("link")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search cases" }).fill(nonce);
  await expect(cases().getByRole("link")).toHaveCount(1);
  await cases().getByRole("link", { name: new RegExp(execution.task.buildTitle(nonce)) }).click();
  await expect(page.getByRole("heading", { name: execution.task.buildTitle(nonce), exact: true })).toBeVisible();
  const work = page.getByRole("region", { name: "Case work", exact: true });
  await expect(work.getByText("done", { exact: true })).toBeVisible();
  await expect(work.getByRole("link")).toHaveAttribute("href", `/${prefix}/issues/${task.identifier}`);
  const history = page.getByRole("region", { name: "Case handoffs" });
  await expect(history.locator(":scope > ol > li")).toHaveCount(5);
  await expect(history.locator("summary").filter({ hasText: /^Done/ })).toHaveCount(1);
  await history.locator("summary").filter({ has: page.getByText("verification", { exact: true }) }).click();
  await expect(history).toContainText("currency");
  await input.capture("case-final", "Same task after the reviewer requested a correction", "case-final.png");
  const receiptTitle = typeof receipt.title === "string" && receipt.title ? receipt.title : "receipt";
  const receiptButton = page.getByRole("button", { name: receiptTitle, exact: true });
  await receiptButton.click();
  const preview = page.getByRole("dialog", { name: receiptTitle, exact: true });
  await expect(preview).toContainText(/"currency"\s*:\s*"USD"/);
  await preview.getByText("Revision history", { exact: true }).click();
  await expect(preview.getByRole("button", { name: /^rev 1/ })).toBeVisible();
  await expect(preview.getByRole("button", { name: /^rev 2/ })).toBeVisible();
  await preview.getByRole("button", { name: /^rev 1/ }).click();
  await input.capture("case-document", "Real receipt document and its two revisions", "case-document.png");
  await page.keyboard.press("Escape");
  await expect(receiptButton).toBeFocused();
  await expect(page.getByTestId("case-pages").locator("input, textarea, [contenteditable=true]")).toHaveCount(0);
  await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Cases", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Search cases" })).toHaveValue(nonce);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search cases" })).toHaveValue(nonce);
  await expect(cases().getByRole("link")).toHaveCount(1);
  await page.goto(`/${prefix}/cases/${workflowCase.identifier}`);
  await expect(page.getByRole("region", { name: "Case work", exact: true })).toContainText("done");
  await page.goto(`/${prefix}/issues/${task.identifier}`);
  await expect(page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
  await expect(page.getByTestId("issue-assignee-paused-notice")).toHaveCount(0);
  await input.capture("task-final", "Original task completed by the returning builder", "task-final.png");
}
