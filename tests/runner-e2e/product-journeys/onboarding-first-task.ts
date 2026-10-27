import { createHash } from "node:crypto";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "../../../packages/shared/src/constants.js";
import { type createConnectionProof, verifyConnectionArtifact, verifyConnectionRun } from "../connection-evidence.js";
import { connectionDelay } from "../connection-target.js";
import { activeRuns, firstTaskCompletionSettled, type Row } from "../first-task-scoring.js";
import { isBlockedUnstartedWake, isTerminalUnstartedWake } from "../non-execution-wake.js";
import { JourneyError, type JourneyContext, type OnboardingArtifactEvidence, type TargetSession } from "./types.js";
import { retainOnboardingArtifact } from "./artifact-evidence.js";

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

/** Exercise the ordinary onboarding conversation; APIs observe, never submit its actions. */
export async function onboardingFirstTask(input: OnboardingFirstTaskInput): Promise<OnboardingFirstTaskResult> {
  const { context: { api, page, company }, agent, campaignId, proof } = input;
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
    for (const run of seen.values()) {
      if (run.companyId !== company.id || run.agentId !== agent.id || !allowedIssues.includes(runIssueId(run))) fail("onboarding_run_scope_mismatch");
      if (activeRuns([run]).length || run.status === "succeeded" || isBlockedUnstartedWake(run) || isTerminalUnstartedWake(run, snapshot.tasks)) continue;
      fail("onboarding_first_task_failed");
    }
  };
  const assertBeforeAcceptance = (snapshot: Snapshot, parentId: string) => {
    if (snapshot.tasks.length !== 1 || snapshot.tasks[0]!.id !== parentId || snapshot.attachments.length ||
      snapshot.documents.some(document => !isPlanningDocument(document)) || snapshot.tasks[0]!.status === "done") fail("onboarding_work_before_acceptance");
    assertRuns(snapshot, [parentId]);
  };

  let snapshot = await load();
  while (!snapshot.tasks.length) { await wait(); snapshot = await load(); }
  const parent = snapshot.tasks[0]!;
  if (snapshot.tasks.length !== 1 || parent.originKind !== ONBOARDING_FIRST_TASK_ORIGIN_KIND ||
    parent.assigneeAgentId !== agent.id || !String(parent.description).includes("/first-task")) fail("onboarding_canonical_first_task_missing");
  await input.own({ kind: "issue", name: parent.title, id: parent.id });
  snapshot = await load(parent.id);
  if (seen.size) fail("onboarding_opening_started_model_work");
  assertBeforeAcceptance(snapshot, parent.id);
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
  await page.getByTestId("question-other-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill([
    `I have one task in mind. Propose exactly one child task named "${title}" and wait for my approval before creating it or doing its work.`,
    "After approval, assign it to yourself and let its own Paperclip execution produce the result. Then verify and link its saved document and downloadable file in this onboarding conversation and complete both tasks.",
    "The child's approved scope: decode the following base64 into connection-input.json in its workspace, using actual tools.",
    `Exact input bytes: ${Buffer.from(proof.input).toString("base64")}`,
    'Write connection-proof.json containing exactly {"nonce":string,"count":number,"total":number,"sha256":string}. Copy nonce, count the input values, sum them, and compute sha256 of the exact input bytes including the final newline.',
    "Publish connection-proof.json on that child using register_deliverable with workspace-relative contentRef and correct byteSize and SHA-256. Save a connection-proof document on the child including the input nonce, result, and file link. Do not hire agents, create additional tasks, or access credentials or unrelated files.",
  ].join("\n"), { timeout: remaining() });
  await page.getByRole("button", { name: opening[0]!.payload.submitLabel ?? "Continue", exact: true }).last().click({ timeout: remaining() });

  let proposal: Row | undefined;
  while (!proposal) {
    snapshot = await load(parent.id);
    assertBeforeAcceptance(snapshot, parent.id);
    const pending = snapshot.interactions.filter(row => row.status === "pending");
    const proposals = pending.filter(isProposal);
    if (proposals.length > 1 || pending.some(row => row.kind === "ask_user_questions" && row.id !== opening[0]!.id)) fail("onboarding_proposal_scope_unclear");
    // Let the producing turn finish before acceptance; this journey does not test overlap.
    if (proposals.length === 1 && seen.size && !activeRuns([...seen.values()]).length) proposal = proposals[0];
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
    assertRuns(snapshot, [parent.id, ...(childId ? [childId] : [])]);
    if (snapshot.attachments.some(row => row.issueId !== childId)) fail("onboarding_artifact_created_by_parent");
    const settled = child && currentParent.status === "done" && firstTaskCompletionSettled(snapshot.tasks, [parent.id], parent.id) && !activeRuns([...seen.values()]).length;
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
