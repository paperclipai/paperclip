import { gradeQuestionResume, questionPath, validResumeQuestionForm } from "../question-resume-scoring.js";
import type { ContinuationCheckpoint } from "../continuation-scoring.js";
import { validateAgentTaskState } from "./agent-flows.js";
import type { JourneyContext } from "./types.js";

type Row = Record<string, any>;
export interface ClarificationReadback {
  issueId: string; key: string; revisionId: string; body: string; visibleBody: string;
}

export function clarificationQuestionFailure(point: ContinuationCheckpoint, question: Row, choice: boolean) {
  const stage = choice ? "choice" : "text";
  if (!questionPath(point, question)) {
    const source = point.runs.find(run => run.id === question.sourceRunId) as Row | undefined;
    const apiCreated = Object.values(source?.resultJson?.apiToolReceipts ?? {}).some(value => {
      const receipt = value as Row;
      return receipt.state === "completed" && receipt.operationId === "POST /api/issues/{id}/interactions"
        && receipt.result?.ok === true && receipt.result?.data?.id === question.id;
    });
    return apiCreated ? `clarification_${stage}_api_fallback` : `clarification_${stage}_native_path_invalid`;
  }
  return validResumeQuestionForm(point, question, choice) ? undefined : `clarification_${stage}_form_invalid`;
}

export function gradeClarificationEvidence(context: JourneyContext, issueId: string, marker: string,
  checkpoints: ContinuationCheckpoint[], readback?: ClarificationReadback) {
  const checks = gradeQuestionResume(checkpoints, marker);
  const final = checkpoints.find(point => point.phase === "final");
  const initial = checkpoints.filter(point => point.phase !== "final");
  const document = final?.documents[0] as Row | undefined;
  let bound = !!context.agent && context.agent.runtimeMode === "native" && !!context.environmentId;
  try {
    for (const point of checkpoints) validateAgentTaskState(context, issueId, {
      currentIssue: point.issue as Row & { id: string; status: string }, taskRuns: point.runs,
      comments: point.comments as Row[], interactions: point.interactions as Array<Row & { id: string; status: string }>, attachments: [],
    }, 3);
  } catch { bound = false; }
  checks.push({ id: "question-no-premature-output", passed: initial.length === 2 && initial.every(point =>
    point.documents.length === 0 && point.attachments.length === 0 && point.children.length === 0 && point.issue.status !== "done")
    && !!final && final.issue.status === "done" && final.attachments.length === 0 && final.children.length === 0,
  detail: "Wait for both real answers before producing the sole task document, with no extra task or download." },
  { id: "question-answers-owned-by-board", passed: !!final && final.interactions.length === 2 && final.interactions.every(value => {
    const question = value as Row;
    return question.status === "answered" && question.resolvedByUserId === context.user.id && !question.resolvedByAgentId;
  }), detail: "Both retained responses must come from the signed-in board user." },
  { id: "question-document-attributed", passed: !!document && document.issueId === issueId && document.companyId === context.company.id
    && document.createdByAgentId === context.agent?.id && document.updatedByAgentId === context.agent?.id,
  detail: "The owned native agent created and last wrote the document on this exact task and company." },
  { id: "question-document-reloaded", passed: !!document && !!readback && readback.issueId === issueId
    && readback.key === document.key && readback.revisionId === document.latestRevisionId && readback.body === document.body
    && readback.visibleBody.includes(`Use ${marker}.`) && /\bafternoon\b/i.test(readback.visibleBody),
  detail: "The reloaded document must show both saved answers at the independently read revision." },
  { id: "configured-model-and-environment", passed: bound && checkpoints.length === 3 && !!final
    && final.runs.length >= 1 && final.runs.length <= 3 && final.runs.every(run => run.status === "succeeded"),
  detail: "Every observed run belongs to the configured native agent, task, company, model and environment." });
  return checks;
}
