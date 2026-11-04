import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FirstTaskCheck, FirstTaskCheckpoint, FirstTaskEvidence, Row } from "./first-task-scoring.js";

export const APPROVAL_HISTORY_SUITE = "onboarding-approval-history";
export const APPROVAL_HISTORY_CASE = "interview-hire-execute";
export const DRAFT_OPTION = "Draft welcome note";
export const PUBLISH_OPTION = "Publish welcome note";
export const approvalHistoryWriter = (marker: string) => `Garden Writer ${marker}`;
export const approvalHistoryFacts = (marker: string) => [
  "We run a neighborhood garden club for beginners with a free Saturday meetup.",
  `Our first deliverable is a two-sentence welcome note saved as a task document, including ${marker}.`,
  `Please save a two-step plan and ask me to review it with exactly two checkboxes labeled "${DRAFT_OPTION}" and "${PUBLISH_OPTION}". Initially select both; I will choose the scope.`,
  "Plan acceptance authorizes only my selected steps. Do not hire or create a task yet.",
  `After plan acceptance, propose hiring exactly one writer named "${approvalHistoryWriter(marker)}" with a separate saved checkbox confirmation. Wait for that approval before hiring.`,
  "Use the same provider, model, and AI connection as yourself for the writer. No outside services or additional agents are needed.",
  'After hiring, ask me a separate saved ordinary confirmation labeled "Start drafting" before creating the writer’s task. This is an execution confirmation; keep the saved plan revision unchanged.',
  "After I accept Start drafting, assign exactly one child task to that writer, wait for its execution, verify the saved welcome document, and finish this onboarding task. Never publish the note externally.",
].join(" ");

export function approvalHistoryDefinitionDigest() {
  const hash = createHash("sha256");
  for (const file of ["first-task-approval-history.ts", "first-task-approval-history-flow.ts", "first-task-cases.ts", "first-task-flow.ts", "first-task-scoring.ts", "first-task-fixtures.ts"]) {
    hash.update(file).update("\0").update(readFileSync(new URL(file, import.meta.url))).update("\0");
  }
  return hash.digest("hex");
}

const acceptedByHuman = (card: Row | undefined) => Boolean(card?.status === "accepted" && card.result?.outcome === "accepted"
  && card.resolvedByUserId && !card.resolvedByAgentId && !card.resolvedByRunId && Number.isFinite(Date.parse(card.resolvedAt)));
const planCard = (c: FirstTaskCheckpoint) => c.interactions.find(card => card.kind === "request_checkbox_confirmation"
  && card.payload?.target?.type === "issue_document" && card.payload.target.key === "plan");
const hiringCard = (c: FirstTaskCheckpoint, writer: string) => c.interactions.find(card => card.kind === "request_checkbox_confirmation"
  && !card.payload?.target && card.payload?.options?.length === 1 && card.payload.options[0].label.includes(writer));
const executionCard = (c: FirstTaskCheckpoint) => c.interactions.find(card => card.kind === "request_confirmation"
  && !card.payload?.target && /start drafting/i.test(card.payload?.prompt ?? ""));

/** Independent persisted-state oracle; successful provider runs cannot replace any approval or output. */
export function gradeApprovalHistory(e: FirstTaskEvidence, marker: string): FirstTaskCheck[] {
  const checks: FirstTaskCheck[] = [];
  const last = e.checkpoints.at(-1);
  if (!last) return [{ id: "approval-history-recorded", passed: false, detail: "Missing onboarding approval checkpoints", evidence: [] }];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail, evidence: e.checkpoints.map(c => c.id) });
  const writer = approvalHistoryWriter(marker);
  const plan = planCard(last), hiring = hiringCard(last, writer), execution = executionCard(last);
  const draft = plan?.payload.options?.find((option: Row) => option.label === DRAFT_OPTION);
  const selectedOnlyDraft = (card: Row | undefined) => Boolean(draft && acceptedByHuman(card)
    && card?.result.selectedOptionIds?.length === 1 && card.result.selectedOptionIds[0] === draft.id);
  const approvedHire = (c: FirstTaskCheckpoint) => {
    const card = hiringCard(c, writer);
    return acceptedByHuman(card) && card?.result.selectedOptionIds?.length === 1
      && card.result.selectedOptionIds[0] === card.payload.options[0].id;
  };
  const newAgents = (c: FirstTaskCheckpoint) => c.agents.filter(agent => !e.checkpoints[0].agents.some(initial => initial.id === agent.id));
  const children = (c: FirstTaskCheckpoint) => c.tasks.filter(task => !e.initialTaskIds.includes(task.id));
  add("no-premature-work", e.checkpoints.every(c => {
    const hired = approvedHire(c), executing = acceptedByHuman(executionCard(c));
    return (hired || newAgents(c).length === 0) && (executing || (children(c).length === 0
      && c.documents.every(doc => doc.key === "plan" || /(?:^|[-_])proposal(?:$|[-_])/.test(doc.key))
      && !(c.attachments?.length) && c.tasks.find(task => task.id === e.onboardingIssueId)?.status !== "done"));
  }), "Hiring and execution each wait for their own human decision at every checkpoint");
  add("three-separate-human-approvals", acceptedByHuman(plan) && approvedHire(last) && acceptedByHuman(execution)
    && new Set([plan?.id, hiring?.id, execution?.id]).size === 3
    && Date.parse(plan!.resolvedAt) <= Date.parse(hiring!.createdAt)
    && Date.parse(hiring!.resolvedAt) <= Date.parse(execution!.createdAt),
  "A revision-bound checkbox plan, a hiring checkbox, and a later untargeted execution confirmation were independently accepted");
  const afterPlan = e.checkpoints.filter(c => ["plan-accepted", "hiring-proposed", "hiring-accepted", "execution-proposed", "accepted", "finished"].includes(c.phase));
  add("selected-plan-scope-retained", afterPlan.length > 0 && afterPlan.every(c => {
    const card = planCard(c);
    if (!card) return false;
    return selectedOnlyDraft(card) && card.id === plan?.id && card.payload.target.revisionId === plan?.payload.target.revisionId
      && c.documents.some(doc => doc.issueId === e.onboardingIssueId && doc.key === "plan"
        && (!card.payload.target.documentId || doc.id === card.payload.target.documentId)
        && doc.latestRevisionId === card.payload.target.revisionId);
  }), "Only the selected draft option and exact accepted plan revision survive hiring, execution, and reload");
  const workers = newAgents(last), tasks = children(last);
  add("approved-writer-executes-once", workers.length === 1 && workers[0].name === writer
    && approvedHire(last) && Date.parse(workers[0].createdAt) >= Date.parse(hiring!.resolvedAt)
    && tasks.length === 1 && tasks[0].parentId === e.onboardingIssueId && tasks[0].assigneeAgentId === workers[0].id
    && acceptedByHuman(execution) && Date.parse(tasks[0].createdAt) >= Date.parse(execution!.resolvedAt)
    && last.runs.filter(run => (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) === tasks[0].id
      && run.agentId === workers[0].id && run.startedAt).length === 1,
  "Exactly the approved writer owns one task and starts one child execution after Start drafting is accepted");
  const stages = ["plan-accepted", "hiring-proposed", "hiring-accepted", "execution-proposed", "accepted", "finished"];
  add("approval-history-stages", stages.every(phase => e.checkpoints.some(c => c.phase === phase)), "Every approval and waiting boundary was observed");
  add("no-pending-approvals", last.interactions.every(card => card.status !== "pending"), "Completion leaves no pending human request or duplicate approval");
  const finished = e.checkpoints.filter(c => c.phase === "finished");
  const output = (c: FirstTaskCheckpoint) => c.documents.filter(doc => doc.issueId === tasks[0]?.id && doc.key !== "plan")
    .map(doc => ({ id: doc.id, key: doc.key, revisionId: doc.latestRevisionId, body: doc.body }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
  add("reload-retains-completion", finished.length >= 2 && tasks.length === 1 && tasks[0].status === "done"
    && last.tasks.find(task => task.id === e.onboardingIssueId)?.status === "done"
    && finished.slice(-2).every(c => c.tasks.some(task => task.id === tasks[0].id && task.status === "done")
      && c.documents.some(doc => doc.issueId === tasks[0].id && doc.key !== "plan" && String(doc.body).includes(marker)))
    && JSON.stringify(output(finished.at(-2)!)) === JSON.stringify(output(last)),
  "Reload retains the completed assigned child, saved welcome document, and completed onboarding parent");
  return checks;
}
