import { isDeepStrictEqual } from "node:util";
import type { ContinuationCheckpoint } from "./continuation-scoring.js";
import { isSingleClaudeQuestion } from "./runtime-question-readiness.js";

type Row = Record<string, any>;
export type QuestionPath = "provider" | "semantic";
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const questions = (c?: ContinuationCheckpoint): Row[] =>
  (c?.interactions ?? []).filter((i: any) => i.kind === "ask_user_questions") as Row[];
export const resumeQuestionFields = (i?: Row): Row[] =>
  Array.isArray(i?.payload?.questionSet?.questions) ? i.payload.questionSet.questions : [];

/** Classify by server-owned identities and the applied semantic receipt. A
 * missing receipt is unknown, never inferred from form shape or run count. */
export function questionPath(checkpoint: ContinuationCheckpoint | undefined, i?: Row): QuestionPath | null {
  if (!checkpoint || !i || !nonempty(i.id) || !nonempty(i.sourceRunId) || !nonempty(i.idempotencyKey)) return null;
  const matches = checkpoint.runs.filter(r => r.id === i.sourceRunId) as Row[];
  const run = matches.length === 1 ? matches[0] : undefined;
  if (!run || run.runtimeMode !== "native" || !nonempty(run.companyId) ||
      run.companyId !== (checkpoint.issue as Row).companyId ||
      i.companyId !== run.companyId || i.issueId !== checkpoint.issue.id || run.issueId !== i.issueId ||
      !nonempty(checkpoint.issue.assigneeAgentId) || i.createdByAgentId !== checkpoint.issue.assigneeAgentId ||
      run.agentId !== checkpoint.issue.assigneeAgentId) return null;
  const request = i.payload?.runtimeRequestId;
  if (request !== undefined) {
    return nonempty(request) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request) &&
      i.idempotencyKey === `paperclip-runner-question:${run.id}:${request}` &&
      i.continuationPolicy === "none" && run.status === "running" ? "provider" : null;
  }
  const receipt = run.resultJson?.semanticToolReceipts?.[i.idempotencyKey];
  const created = receipt?.result?.interaction;
  return run.status === "succeeded" && i.continuationPolicy === "wake_assignee" &&
    receipt?.operationId === "request_human_input" && receipt.result?.disposition === "applied" &&
    created?.id === i.id && created?.sourceRunId === run.id && created?.issueId === i.issueId &&
    created?.companyId === i.companyId && created?.kind === "ask_user_questions" &&
    isDeepStrictEqual(created?.payload?.questionSet, i.payload?.questionSet) ? "semantic" : null;
}

export function validResumeQuestionForm(checkpoint: ContinuationCheckpoint, i: Row, choice: boolean): boolean {
  const path = questionPath(checkpoint, i);
  const fields = resumeQuestionFields(i);
  if (!path || fields.some(f => !nonempty(f.id)) || new Set(fields.map(f => f.id)).size !== fields.length) return false;
  if (!choice) return fields.length === 1 && fields[0].answerMode === "text" &&
    !fields[0].options?.length && !fields[0].customAnswer;
  return fields[0]?.answerMode === "single_select" &&
    (fields.length === 1 || (path === "provider" && isSingleClaudeQuestion(fields)));
}

function sameQuestion(a: Row, b?: Row) {
  return !!b && ["id", "kind", "sourceRunId", "issueId", "companyId", "createdByAgentId", "idempotencyKey", "continuationPolicy"]
    .every(k => a[k] === b[k]) && isDeepStrictEqual(a.payload, b.payload);
}
function answeredByUser(i?: Row) {
  return i?.status === "answered" && nonempty(i.resolvedByUserId) && !i.resolvedByAgentId;
}
function resumedRun(before: ContinuationCheckpoint | undefined, after: ContinuationCheckpoint | undefined, i?: Row) {
  if (!before || !after || !i) return false;
  const path = questionPath(before, i);
  const prior = new Set(before.runs.map(r => r.id));
  const next = after.runs.filter(r => !prior.has(r.id)) as Row[];
  if (prior.size !== before.runs.length || new Set(after.runs.map(r => r.id)).size !== after.runs.length ||
      before.runs.some(r => !after.runs.some(n => n.id === r.id))) return false;
  if (path === "provider") return next.length === 0 &&
    after.runs.some(r => r.id === i.sourceRunId && ["running", "succeeded"].includes(r.status));
  if (path !== "semantic" || next.length !== 1) return false;
  const context = next[0].contextSnapshot;
  return context?.issueId === i.issueId && context?.sourceRunId === i.sourceRunId &&
    context?.interactionId === i.id && context?.interactionKind === "ask_user_questions" &&
    context?.interactionStatus === "answered";
}

/** Behavioral qualification supports either valid native path. It does not
 * replace the separate documentation-placement/semantic-tool qualification. */
export function gradeQuestionResume(checkpoints: ContinuationCheckpoint[], marker: string) {
  const initial = checkpoints.find(c => c.phase === "initial");
  const middle = checkpoints.find(c => c.phase === "answered");
  const final = checkpoints.find(c => c.phase === "final");
  const first = questions(initial)[0];
  const second = questions(middle).find(i => i.status === "pending");
  const choice = resumeQuestionFields(first)[0];
  const text = resumeQuestionFields(second)[0];
  const options: Row[] = choice?.options ?? [];
  const afternoon = options.find(o => /^afternoon\b/i.test(String(o.label).trim()));
  const checks = [{
    id: "question-resume.forms",
    passed: !!initial && !!middle && questions(initial).length === 1 && first?.status === "pending" &&
      validResumeQuestionForm(initial, first, true) && options.length >= 2 &&
      options.every(o => nonempty(o.id)) && new Set(options.map(o => o.id)).size === options.length &&
      options.some(o => /^morning\b/i.test(String(o.label).trim())) && !!afternoon &&
      questions(middle).length === 2 && questions(middle).filter(i => i.status === "pending").length === 1 &&
      nonempty(second?.id) && second?.id !== first?.id && validResumeQuestionForm(middle, second, false),
    detail: "One choice plus only a verified provider Other companion, then a distinct text-only question.",
  }];
  for (const [before, after, i, field, answer] of [
    [initial, middle, first, choice, "choice"], [middle, final, second, text, "text"],
  ] as const) {
    const committed = questions(after).filter(q => q.id === i?.id);
    const retained = questions(final).filter(q => q.id === i?.id);
    const response: Row[] = committed[0]?.result?.answers ?? [];
    const primary = response.filter(a => a.questionId === field?.id);
    const optionalIds = resumeQuestionFields(i).slice(1).map(f => f.id);
    const validAnswer = primary.length === 1 && (answer === "choice"
      ? primary[0].optionIds?.length === 1 && primary[0].optionIds[0] === afternoon?.id && !primary[0].otherText
      : !primary[0].optionIds?.length && primary[0].otherText === `Use ${marker}.`);
    checks.push({
      id: `question-resume.${answer}.answer`,
      passed: !!i && committed.length === 1 && retained.length === 1 &&
        sameQuestion(i, committed[0]) && sameQuestion(i, retained[0]) && answeredByUser(committed[0]) &&
        answeredByUser(retained[0]) && isDeepStrictEqual(committed[0].result, retained[0].result) &&
        validAnswer && response.every(a => a.questionId === field?.id ||
          (optionalIds.includes(a.questionId) && !a.optionIds?.length && !a.otherText)),
      detail: "The real board answer must remain bound to the unchanged question, with no fabricated or substituted response.",
    }, {
      id: `question-resume.${answer}.path`,
      passed: resumedRun(before, after, i),
      detail: `Observed path: ${questionPath(before, i) ?? "unknown"}; provider answers resume the same run; semantic answers require one exactly bound response wake.`,
    });
  }
  checks.push({
    id: "question-resume.complete-evidence",
    passed: checkpoints.length === 3 && !!initial && !!middle && !!final && initial.runs.length === 1 &&
      questions(final).length === 2 && final.runs.length >= 1 && final.runs.length <= 3 &&
      final.runs.every((r: Row) => r.companyId === (final.issue as Row).companyId &&
        r.issueId === final.issue.id && r.agentId === final.issue.assigneeAgentId &&
        typeof r.runnerProfileJson?.nativeExecutionInput?.task?.prompt === "string") &&
      final.documents.length === 1 && !!final.documents[0].latestRevisionId &&
      final.documents[0].body.includes(`Use ${marker}.`) && /\bafternoon\b/i.test(final.documents[0].body),
    detail: "Retain all three checkpoints, every native input and exactly one saved document containing the choice and the complete submitted reference.",
  });
  return checks.map(c => ({ ...c, passed: Boolean(c.passed) }));
}
