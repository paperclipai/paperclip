import { createHash } from "node:crypto";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "../../../packages/shared/src/constants.js";
import { type createConnectionProof, verifyConnectionArtifact, verifyConnectionRun } from "../connection-evidence.js";
import { connectionDelay } from "../connection-target.js";
import { activeRuns, firstTaskCompletionSettled, type Row } from "../first-task-scoring.js";
import { isBlockedUnstartedWake, isTerminalUnstartedWake } from "../non-execution-wake.js";
import { JourneyError, type JourneyContext, type OnboardingArtifactEvidence, type TargetSession } from "./types.js";
import { retainOnboardingArtifact } from "./artifact-evidence.js";
import { preAcceptanceTaskStatus, preAcceptanceViolations, type OnboardingPreAcceptanceEvidence } from "./onboarding-pre-acceptance.js";
import { isPendingNativeRecovery, isProviderUnstartedWorkspaceDeferral } from "./workspace-deferral.js";

export interface OnboardingFirstTaskInput {
  context: JourneyContext;
  agent: { id: string };
  connectionId: string;
  proof: ReturnType<typeof createConnectionProof>;
  campaignId: string;
  maxRuns: number;
  deadlineAt: number;
  own: TargetSession["own"];
  observeRun(run: Row): Promise<void>;
  onArtifact?(artifact: OnboardingArtifactEvidence): void;
  onPreAcceptanceFailure?(evidence: OnboardingPreAcceptanceEvidence): void;
}
export interface OnboardingFirstTaskResult {
  runIds: string[];
  onboardingIssueId: string;
  childIssueId: string;
  artifact: OnboardingArtifactEvidence;
}
interface Snapshot {
  tasks: Row[];
  runs: Row[];
  interactions: Row[];
  comments: Row[];
  documents: Row[];
  attachments: Row[];
}

function fail(code: string): never { throw new JourneyError("failed", code); }
const runIssueId = (run: Row) => run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
const isProposal = (row: Row) => ["request_confirmation", "request_checkbox_confirmation"].includes(row.kind);
const isPlanningDocument = (row: Row) => /^(?:plan|proposal)$/.test(row.key);

function sameWorkspaceRetry(source: Row, successor: Row): boolean {
  const issueIds = (run: Row) => [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId].filter(value => value != null);
  const sourceIssues = issueIds(source), successorIssues = issueIds(successor);
  return source.id !== successor.id && source.companyId === successor.companyId && source.agentId === successor.agentId &&
    sourceIssues.length > 0 && successorIssues.length > 0 && [...sourceIssues, ...successorIssues].every(id => id === sourceIssues[0]) &&
    successor.retryOfRunId === source.id && successor.contextSnapshot?.retryOfRunId === source.id &&
    successor.scheduledRetryReason === "workspace_busy" && successor.contextSnapshot?.retryReason === "workspace_busy" &&
    successor.contextSnapshot?.wakeReason === "workspace_busy_retry" &&
    Number.isSafeInteger(successor.scheduledRetryAttempt) &&
    successor.scheduledRetryAttempt === (source.scheduledRetryReason === "workspace_busy" ? source.scheduledRetryAttempt ?? 0 : 0) + 1;
}

function unstartedScheduledWorkspaceRetry(run: Row): boolean {
  return run.status === "scheduled_retry" && run.startedAt === null && run.finishedAt === null &&
    Number.isFinite(Date.parse(run.scheduledRetryAt)) && run.runtimeMode === "legacy" && run.runtimeModeResolvedAt === null &&
    ["nativeIssueId", "nativeSessionId", "runnerInstanceId", "processPid", "processStartedAt", "sessionIdAfter"].every(key => run[key] == null) &&
    run.lastOutputSeq === 0 && run.usageJson == null;
}

/** Exercise the ordinary onboarding conversation; APIs observe, never submit its actions. */
export async function onboardingFirstTask(input: OnboardingFirstTaskInput): Promise<OnboardingFirstTaskResult> {
  const { context: { api, page, company }, agent, campaignId, proof } = input;
  const isPendingRun = (run: Row) => activeRuns([run]).length > 0 || run.status === "scheduled_retry" ||
    isPendingNativeRecovery(run, input.deadlineAt);
  if (!Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1) fail("invalid_onboarding_run_limit");
  const title = `Artifact ${campaignId}`;
  const seen = new Map<string, Row>();
  const observed = new Map<string, string>();
  const remaining = () => {
    const ms = input.deadlineAt - Date.now();
    if (ms <= 0) fail("onboarding_first_task_deadline");
    return Math.min(ms, 30_000);
  };
  const wait = async () => { await connectionDelay(Math.min(1000, remaining())); };
  const load = async (parentId?: string): Promise<Snapshot> => {
    remaining();
    const [tasks, rows] = await Promise.all([
      api.get<Row[]>(`/api/companies/${company.id}/issues?limit=100&includeAgentCreatedTasks=true`),
      api.get<Row[]>(`/api/companies/${company.id}/heartbeat-runs?limit=1000`),
    ]);
    const runs = await Promise.all(rows.map(row => api.get<Row>(`/api/heartbeat-runs/${row.id}`)));
    for (const run of runs) {
      seen.set(run.id, run);
      const revision = JSON.stringify([run.status, run.startedAt, run.finishedAt, run.usageJson, run.costUsd]);
      if (observed.get(run.id) !== revision) {
        await input.observeRun(run);
        observed.set(run.id, revision);
      }
    }
    if (seen.size > input.maxRuns || rows.length === 1000) fail("campaign_run_limit_exceeded");
    if (tasks.length === 100) fail("onboarding_task_scope_overflow");
    if (!parentId) return { tasks, runs, interactions: [], comments: [], documents: [], attachments: [] };
    const [interactions, comments, documents, attachments] = await Promise.all([
      api.get<Row[]>(`/api/issues/${parentId}/interactions`),
      api.get<Row[]>(`/api/issues/${parentId}/comments?order=asc`),
      Promise.all(tasks.map(async task => {
        const summaries = await api.get<Row[]>(`/api/issues/${task.id}/documents`);
        return Promise.all(summaries.map(async document => ({
          ...await api.get<Row>(`/api/issues/${task.id}/documents/${encodeURIComponent(document.key)}`),
          issueId: task.id, key: document.key,
        })));
      })).then(rows => rows.flat()),
      Promise.all(tasks.map(task => api.get<Row[]>(`/api/issues/${task.id}/attachments`))).then(rows => rows.flat()),
    ]);
    return { tasks, runs, interactions, comments, documents, attachments };
  };
  const assertRuns = (snapshot: Snapshot, allowedIssues: string[]) => {
    const runs = [...seen.values()];
    let workspacePending = false;
    const successors = new Map<string, Row>();
    for (const source of runs.filter(isProviderUnstartedWorkspaceDeferral)) {
      const linked = runs.filter(run => run.retryOfRunId === source.id || run.contextSnapshot?.retryOfRunId === source.id);
      if (linked.length > 1 || (linked[0] && !sameWorkspaceRetry(source, linked[0]))) fail("onboarding_workspace_retry_lineage_mismatch");
      if (linked[0]) successors.set(source.id, linked[0]);
      else workspacePending = true;
    }
    for (const run of seen.values()) {
      if (run.companyId !== company.id || run.agentId !== agent.id || !allowedIssues.includes(runIssueId(run))) fail("onboarding_run_scope_mismatch");
      if (isProviderUnstartedWorkspaceDeferral(run)) {
        const chain = new Set<string>();
        let tail: Row | undefined = run;
        while (tail && isProviderUnstartedWorkspaceDeferral(tail)) {
          if (chain.has(tail.id)) fail("onboarding_workspace_retry_lineage_mismatch");
          chain.add(tail.id); tail = successors.get(tail.id);
        }
        if (!tail || isPendingRun(tail)) workspacePending = true;
        else if (tail.status !== "succeeded" || tail.runtimeMode !== "native") fail("onboarding_first_task_failed");
        continue;
      }
      if (run.status === "scheduled_retry") {
        const source = seen.get(run.retryOfRunId);
        if (!source || !isProviderUnstartedWorkspaceDeferral(source) || !sameWorkspaceRetry(source, run) || !unstartedScheduledWorkspaceRetry(run)) fail("onboarding_workspace_retry_lineage_mismatch");
        workspacePending = true;
        continue;
      }
      if (isPendingNativeRecovery(run, input.deadlineAt)) { workspacePending = true; continue; }
      if (activeRuns([run]).length || run.status === "succeeded" || isBlockedUnstartedWake(run) || isTerminalUnstartedWake(run, snapshot.tasks)) continue;
      fail("onboarding_first_task_failed");
    }
    return workspacePending;
  };
  const assertBeforeAcceptance = (snapshot: Snapshot, parentId: string, checkpoint: OnboardingPreAcceptanceEvidence["checkpoint"]) => {
    const observed = {
      taskCount: snapshot.tasks.length, attachmentCount: snapshot.attachments.length,
      documentCount: snapshot.documents.length, nonPlanningDocumentCount: snapshot.documents.filter(document => !isPlanningDocument(document)).length,
      firstTaskMatchesCanonicalParent: snapshot.tasks[0]?.id === parentId,
      firstTaskStatus: preAcceptanceTaskStatus(snapshot.tasks[0]),
      canonicalParentStatus: preAcceptanceTaskStatus(snapshot.tasks.find(task => task.id === parentId)),
    };
    const violations = preAcceptanceViolations(observed);
    if (violations.length) {
      input.onPreAcceptanceFailure?.({ version: 1, checkpoint, violations, ...observed });
      fail("onboarding_work_before_acceptance");
    }
    return assertRuns(snapshot, [parentId]);
  };

  let snapshot = await load();
  while (!snapshot.tasks.length) { await wait(); snapshot = await load(); }
  const parent = snapshot.tasks[0]!;
  if (snapshot.tasks.length !== 1 || parent.originKind !== ONBOARDING_FIRST_TASK_ORIGIN_KIND ||
    parent.assigneeAgentId !== agent.id || !String(parent.description).includes("/first-task")) fail("onboarding_canonical_first_task_missing");
  await input.own({ kind: "issue", name: parent.title, id: parent.id });
  snapshot = await load(parent.id);
  if (seen.size) fail("onboarding_opening_started_model_work");
  assertBeforeAcceptance(snapshot, parent.id, "before-opening-answer");
  const opening = snapshot.interactions.filter(row => row.kind === "ask_user_questions" && row.status === "pending");
  const questions = opening[0]?.payload?.questionSet?.questions ?? opening[0]?.payload?.questions ?? [];
  const question = questions.find((row: Row) => row.id === "first-task-opening");
  const option = question?.options?.find((row: Row) => row.id === "task" && row.freeText === true);
  if (opening.length !== 1 || questions.length !== 1 || !option ||
    !snapshot.comments.some(row => row.authorAgentId === agent.id && String(row.body ?? "").trim())) fail("onboarding_opening_not_presented");
  await page.goto(`${api.origin}/${company.issuePrefix}/issues/${parent.identifier ?? parent.id}`, { timeout: remaining() });
  // Persist the exact intended child before the opening reply can dispatch any model work.
  await input.own({ kind: "issue", name: title });
  await page.getByRole("radio", { name: option.label }).last().click({ timeout: remaining() });
  const childBrief = [
    "Complete this child's approved scope in this order:",
    "1. Decode the following base64 into connection-input.json in its workspace, using actual tools.",
    `Exact input bytes: ${Buffer.from(proof.input).toString("base64")}`,
    '2. Write connection-proof.json containing exactly {"nonce":string,"count":number,"total":number,"sha256":string}. Copy nonce, count the input values, sum them, and compute sha256 of the exact input bytes including the final newline.',
    '3. Publish connection-proof.json on this child using register_deliverable with filename "connection-proof.json", workspace-relative contentRef "connection-proof.json", and correct byteSize and SHA-256 for that file.',
    "4. Use write_document to save a connection-proof document on this child including the filename connection-proof.json, input nonce, result, and the file link returned by register_deliverable. A Markdown workspace note is not a Paperclip task document and does not replace this step.",
    "5. Report completion with paperclip_finish using the current completion contract. Include verification for checks actually run and omit optional schema. Use deliverable:<attachmentId> from register_deliverable in evidence and any file artifacts. Keep local input paths in verification details, not completion evidence or artifacts. Correct rejected arguments using the tool feedback and retry before declaring a blocker.",
    "Do not hire agents, create additional tasks, or access credentials or unrelated files.",
  ].join("\n");
  await page.getByTestId("question-other-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill([
    `I have one task in mind. Propose exactly one child task named "${title}" and wait for my approval before creating it or doing its work.`,
    'Save that proposal with request_human_input using interactionKind "confirmation" (or "checkbox" bound to the saved plan revision when plan mode applies) and continuationPolicy "wake_assignee". Check that the tool returned a saved pending card. Correct rejected arguments from its feedback; a failed call is not a pending proposal.',
    "Do not resolve, accept, or record approval yourself. This opening answer supplies scope, not approval. Wait for my actual accepted card decision before calling create_task; a rejection does not authorize the work.",
    "After approval, assign it to yourself and let its own Paperclip execution produce the result. After it finishes, verify its saved document and published attachment.",
    "In your final reply in this onboarding conversation, include actual Markdown links to the child task, its saved document, and connection-proof.json. Copy the published attachment's returned contentPath or downloadPath into the file link URL, including its actual attachment ID. A backticked filename, document key, or path is not a clickable link. Obtain the real references from the child's saved results; do not invent IDs or URLs. Then complete both tasks.",
    "When you create the child, copy the entire brief between BEGIN CHILD BRIEF and END CHILD BRIEF VERBATIM into create_task.description. Preserve every step, tool name, parameter instruction, and exact encoded input. Do not summarize or paraphrase it.",
    "BEGIN CHILD BRIEF",
    childBrief,
    "END CHILD BRIEF",
  ].join("\n"), { timeout: remaining() });
  await page.getByRole("button", { name: opening[0]!.payload.submitLabel ?? "Continue", exact: true }).last().click({ timeout: remaining() });

  let proposal: Row | undefined;
  while (!proposal) {
    snapshot = await load(parent.id);
    const workspacePending = assertBeforeAcceptance(snapshot, parent.id, "awaiting-proposal");
    const pending = snapshot.interactions.filter(row => row.status === "pending");
    const proposals = pending.filter(isProposal);
    if (proposals.length > 1 || pending.some(row => row.kind === "ask_user_questions" && row.id !== opening[0]!.id)) fail("onboarding_proposal_scope_unclear");
    // Let the producing turn finish before acceptance; this journey does not test overlap.
    if (proposals.length === 1 && seen.size && !workspacePending && ![...seen.values()].some(isPendingRun)) proposal = proposals[0];
    else await wait();
  }
  const target = proposal.payload?.target;
  const plan = target?.type === "issue_document" ? snapshot.documents.find(document => document.issueId === parent.id && document.key === target.key &&
    (!target.issueId || target.issueId === parent.id) && document.latestRevisionId === target.revisionId &&
    (!target.documentId || target.documentId === document.id)) : undefined;
  if ((proposal.kind === "request_checkbox_confirmation" && (!plan || !isPlanningDocument(plan))) ||
    ![proposal.payload?.prompt, proposal.payload?.detailsMarkdown, plan?.body].some(text => typeof text === "string" && text.includes(title))) fail("onboarding_proposal_child_title_mismatch");
  if (proposal.kind === "request_checkbox_confirmation") {
    if (!proposal.payload?.options?.length) fail("onboarding_proposal_scope_unclear");
    for (const item of proposal.payload.options) await page.getByRole("checkbox", { name: item.label, exact: true }).last().check({ timeout: remaining() });
  }
  await page.getByRole("button", { name: proposal.payload?.acceptLabel ?? (proposal.kind === "request_confirmation" ? "Approve" : "Confirm selection"), exact: true }).last().click({ timeout: remaining() });
  for (;;) {
    snapshot = await load(parent.id);
    const status = snapshot.interactions.find(row => row.id === proposal!.id)?.status;
    if (status === "accepted") break;
    if (status !== "pending") fail("onboarding_proposal_not_accepted");
    await wait();
  }

  let childId: string | undefined;
  for (;;) {
    const currentParent = snapshot.tasks.find(row => row.id === parent.id);
    const children = snapshot.tasks.filter(row => row.id !== parent.id);
    if (!currentParent || children.length > 1 || children.some(row => row.parentId !== parent.id || row.title !== title || row.assigneeAgentId !== agent.id)) fail("onboarding_approved_child_mismatch");
    const child = children[0];
    if (currentParent.status === "cancelled" || child?.status === "cancelled") fail("onboarding_first_task_failed");
    if (!child && currentParent.status === "done") fail("onboarding_completed_without_child");
    if (child && !childId) { childId = child.id; await input.own({ kind: "issue", name: title, id: child.id }); }
    if (childId && child?.id !== childId) fail("onboarding_approved_child_mismatch");
    const workspacePending = assertRuns(snapshot, [parent.id, ...(childId ? [childId] : [])]);
    if (snapshot.attachments.some(row => row.issueId !== childId)) fail("onboarding_artifact_created_by_parent");
    const pending = workspacePending || [...seen.values()].some(isPendingRun);
    if (child?.status === "blocked" && child.unblockDescriptor?.owner === "board" && !pending) {
      const childRuns = [...seen.values()].filter(run => runIssueId(run) === child.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const latest = childRuns[0];
      const createdAt = latest && typeof latest.createdAt === "string" ? Date.parse(latest.createdAt) : NaN;
      const result = latest?.resultJson;
      if (Number.isFinite(createdAt) && childRuns.slice(1).every(run => Date.parse(run.createdAt) < createdAt) &&
        latest?.runtimeMode === "native" && latest.nativeIssueId === child.id && latest.contextSnapshot?.issueId === child.id &&
        latest.status === "succeeded" && latest.nativePhase === "committed" && result?.finalizationPhase === "committed" &&
        result.prpReportedWorkDisposition === "blocked" && result.finalizationReasonCode === "current_track_blocker_waiting" &&
        result.authoritativeDecision === "blocked" && result.issueStatusAfter === "blocked" &&
        Number.isSafeInteger(child.statusVersion) && result.statusVersionAfter === child.statusVersion) fail("onboarding_child_task_blocked");
    }
    const settled = child && currentParent.status === "done" && firstTaskCompletionSettled(snapshot.tasks, [parent.id], parent.id) &&
      !pending;
    if (settled) {
      const artifacts = snapshot.attachments.filter(row => row.issueId === child.id && row.originalFilename === "connection-proof.json");
      if (artifacts.length !== 1) fail("onboarding_child_artifact_missing");
      const artifact = artifacts[0]!;
      const run = seen.get(artifact.originatingRunId);
      if (artifact.createdByAgentId !== agent.id || !input.context.environmentId || !run || run.nativeIssueId !== child.id ||
        run.contextSnapshot?.issueId !== child.id || !verifyConnectionRun(run, { agentId: agent.id, connectionId: input.connectionId, method: "api_key", runtimeMode: "native", environmentId: input.context.environmentId })) fail("artifact_run_attribution_mismatch");
      const bytes = await api.bytes(`/api/attachments/${artifact.id}/content`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (artifact.byteSize !== bytes.byteLength || artifact.sha256 !== sha256 || !verifyConnectionArtifact(bytes, proof.expected)) fail("artifact_independent_check_failed");
      const retained = retainOnboardingArtifact({ id: artifact.id, originatingRunId: run.id, bytes, proof });
      input.onArtifact?.(retained);
      if (!snapshot.documents.some(row => row.issueId === child.id && !isPlanningDocument(row) && row.updatedByAgentId === agent.id &&
        typeof row.body === "string" && row.body.includes(proof.expected.nonce) && row.body.includes("connection-proof.json"))) fail("onboarding_child_document_missing");
      if (!snapshot.comments.some(row => row.authorAgentId === agent.id && String(row.body).includes(artifact.id) &&
        (String(row.body).includes(child.id) || String(row.body).includes(child.identifier ?? child.id)))) fail("onboarding_parent_result_links_missing");
      await page.reload({ timeout: remaining() });
      await page.locator(`a[href*="/api/attachments/${artifact.id}/content"]`).first().waitFor({ state: "visible", timeout: remaining() });
      return { runIds: [...seen.keys()], onboardingIssueId: parent.id, childIssueId: child.id,
        artifact: retained };
    }
    await wait(); snapshot = await load(parent.id);
  }
}
