import { isBlockedUnstartedWake } from "./non-execution-wake.js";
import { answerableRuntimeRunIds } from "./runtime-question-readiness.js";
import { sanitizeJson } from "./redaction.js";
import { createHash } from "node:crypto";
import { firstTaskScenario } from "./first-task-cases.js";
import { completionDelivery } from "./completion-updates.js";
export type Row = { id: string; [key: string]: any };
export interface FirstTaskCheckpoint {
  id: string;
  at: string;
  phase:
    | "opening"
    | "response"
    | "clarified"
    | "revised"
    | "accepted"
    | "rejected"
    | "finished";
  issueId: string;
  tasks: Row[];
  agents: Row[];
  comments: Row[];
  interactions: Row[];
  documents: Row[];
  attachments?: Row[];
  runs: Row[];
}
export interface FirstTaskEvidence {
  caseId: string;
  nonce: string;
  onboardingIssueId: string;
  agentId: string;
  initialTaskIds: string[];
  instructions: Array<{
    path: string;
    content: string;
    sha256: string;
    contentSha256?: string;
    redacted?: boolean;
  }>;
  source?: { sha: string; ref: string; dirty: boolean };
  runtimeSettings?: Record<string, unknown>;
  configuredModel: string | null;
  observedModels: string[];
  checkpoints: FirstTaskCheckpoint[];
  checks: FirstTaskCheck[];
}
export interface FirstTaskCheck {
  id: string;
  passed: boolean;
  /** Unexercised checks remain non-passing, but are not behavioral failures. */
  notReached?: string;
  evidence: string[];
  detail: string;
}
export const digestText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function snapshotInstruction(
  path: string,
  content: string,
  secrets: readonly string[] = [],
) {
  const safe = sanitizeJson({ content }, secrets) as { content: string };
  return {
    path,
    content: safe.content,
    sha256: digestText(content),
    contentSha256: digestText(safe.content),
    redacted: safe.content !== content,
  };
}
/** Only user-visible affirmative proposals count; incidental task nouns do not. */
function hasTaskProposal(text: string, confirmationCard = false) {
  const affirmative = text.split(/(?<=[.!?])\s+/).filter((sentence) =>
    !/\b(?:no\s+(?:(?:new|child)\s+)?(?:subtask|task)|(?:not|never|won['’]t|don['’]t|without)\b[^.!?]{0,80}\b(?:subtask|task))\b/i.test(sentence),
  ).join("\n");
  return /\b(?:approve|accept|propose|proposed|proposing|proposal|suggest|suggested|suggesting|recommend|recommended|recommending|create|creating|set up)\b[\s\S]{0,160}\b(?:subtask|task)\b/i.test(affirmative) ||
    /\b(?:subtask|task)\b[^.!?\n]{0,30}\bproposal\b/i.test(affirmative) ||
    (confirmationCard && (
      /\b(?:I|we)(?:['’]ll| will)\s+(?:save|attach|write|make|open|create)\b[^.!?]{0,160}\b(?:(?:new|child)\s+task|subtask)\b/i.test(affirmative) ||
      /\b(?:subtask|task)\s+(?:I|we)(?:['’]ll| will)\s+(?:create|open|set up)\b/i.test(affirmative)
    ));
}

export const activeRuns = (runs: Row[]) =>
  runs.filter((run) => ["queued", "running"].includes(run.status));
export function questionCount(interaction: Row) {
  return (
    interaction.payload?.questionSet?.questions ??
    interaction.payload?.questions ??
    []
  ).length;
}
/** Inspect the presentation the user saw, including superseded cards at earlier checkpoints. */
function gradeQuestionChoices(
  checkpoints: FirstTaskCheckpoint[],
): FirstTaskCheck {
  const seen = new Set<string>();
  const failures: string[] = [];
  const refs = new Set<string>();
  for (const checkpoint of checkpoints) {
    for (const interaction of checkpoint.interactions) {
      if (interaction.kind !== "ask_user_questions") continue;
      const questions =
        interaction.payload?.questionSet?.questions ??
        interaction.payload?.questions ??
        [];
      for (const question of questions) {
        const key = JSON.stringify([interaction.id, question]);
        if (seen.has(key)) continue;
        seen.add(key);
        // A canonical text question has no visible choice controls. Its legacy
        // compatibility entry may contain a single freeText option; ignore that.
        if (question?.answerMode === "text") continue;
        const labels = new Set<string>(
          (question?.options ?? [])
            .map((option: any) =>
              String(option.label ?? "")
                .trim()
                .toLowerCase(),
            )
            .filter(Boolean),
        );
        if (labels.size >= 2) continue;
        refs.add(checkpoint.id);
        failures.push(
          `${interaction.id} / ${question?.id ?? "unknown question"}: "${question?.prompt ?? ""}" has ${labels.size} distinct choice option(s); expected at least 2, or a text question`,
        );
      }
    }
  }
  return {
    id: "question-choice-options",
    passed: failures.length === 0,
    detail:
      failures.length > 0
        ? failures.join("; ")
        : "Every presented choice question offers at least two distinct options; open-ended text questions are allowed",
    evidence: failures.length > 0 ? [...refs] : checkpoints.map((c) => c.id),
  };
}

/** A terminal parent with no child is an assessable wrong outcome, not a transport timeout. */
export function firstTaskCompletionSettled(
  tasks: Row[],
  initialTaskIds: string[],
  issueId: string,
): boolean {
  const children = tasks.filter((task) => !initialTaskIds.includes(task.id));
  return children.length > 0
    ? children.every((task) => task.status === "done")
    : tasks.some((task) => task.id === issueId && task.status === "done");
}

function isPlanDocument(document: Row): boolean {
  return (
    document.key === "plan" ||
    (/(?:^|[-_])plan(?:$|[-_])/i.test(String(document.key)) &&
      (/\bplan\b/i.test(String(document.title ?? "")) ||
        /^#+\s+plan\b/im.test(String(document.body ?? ""))))
  );
}
/** Plan/proposal documents are planning evidence, never durable completion output. */
function isPlanningDocument(document: Row): boolean {
  return (
    isPlanDocument(document) ||
    (/(?:^|[-_])proposal(?:$|[-_])/i.test(String(document.key)) &&
      /(?:^|\n)(?:#+\s*)?(?:proposed (?:(?:child|single|first) )?task|(?:(?:first|single)[- ])?task proposal|proposal)\b/i.test(
        `${document.title ?? ""}\n${document.body ?? ""}`,
      ))
  );
}
function isVerifiedAttachment(a: Row): boolean {
  return a.contentVerified === true && typeof a.body === "string" && a.contentSha256 === digestText(a.body);
}
function attachmentDocument(a: Row): Row {
  return { ...a, key: String(a.originalFilename ?? a.filename ?? "").replace(/\.(?:md|txt)$/i, ""), title: a.title ?? a.originalFilename ?? a.filename };
}
function isPlanningAttachment(a: Row): boolean {
  return isVerifiedAttachment(a) && isPlanningDocument(attachmentDocument(a));
}
function verifiedFirstTaskOutputs(checkpoint: FirstTaskCheckpoint): Row[] {
  return [...checkpoint.documents, ...(checkpoint.attachments ?? []).filter(isVerifiedAttachment).map(attachmentDocument)];
}
/** Provider identities, not generic sessionReused flags, prove continuity. */
export function gradeNativeSessionContinuity(runs: Row[], issueId: string): FirstTaskCheck {
  const parent = [...new Map(runs.filter((run) => run.nativeIssueId === issueId).map((run) => [run.id, run])).values()];
  const identities = parent.map((run) => ({
    run: run.id,
    session: run.nativeSessionId,
    provider: run.runnerProfileJson?.sessionCheckpoint?.providerSessionId,
    workspace: run.runnerProfileJson?.nativeExecutionInput?.binding?.executionWorkspaceId,
  }));
  const passed = parent.length >= 2 && ["session", "provider", "workspace"].every((key) =>
    identities.every((identity) => typeof identity[key as "session"] === "string" && identity[key as "session"].length > 0) &&
    new Set(identities.map((identity) => identity[key as "session"])).size === 1,
  );
  return { id: "native-session-continuity", passed, evidence: ["finished"],
    detail: `Same-task follow-ups must retain native/provider/workspace identities: ${JSON.stringify(identities)}` };
}

export function gradeFirstTask(e: FirstTaskEvidence): FirstTaskCheck[] {
  const scenario = firstTaskScenario(e.caseId, e.nonce);
  const checks: FirstTaskCheck[] = [];
  const add = (
    id: string,
    passed: boolean,
    detail: string,
    refs: string[],
    notReached?: string,
  ) =>
    checks.push({
      id,
      passed: notReached ? false : passed,
      detail,
      evidence: refs,
      ...(notReached ? { notReached } : {}),
    });
  const first = e.checkpoints.find((c) => c.phase === "response");
  const last = e.checkpoints.at(-1);
  const approval = e.checkpoints.find((c) => c.phase === "accepted");
  const rejection =
    e.caseId === "reject-no-execution"
      ? e.checkpoints.find((c) => c.phase === "rejected")
      : undefined;
  const extras = (c: FirstTaskCheckpoint) =>
    c.tasks.filter((t) => !e.initialTaskIds.includes(t.id));
  const seeded = new Set(e.checkpoints[0]?.comments.map((c) => c.id));
  const replies = (c: FirstTaskCheckpoint) =>
    c.comments.filter((r) => r.authorAgentId && !seeded.has(r.id));
  add(
    "recorded-response",
    Boolean(
      first &&
        replies(first).length +
          first.interactions.filter(
            (i) =>
              !e.checkpoints[0]?.interactions.some((old) => old.id === i.id),
          ).length >
          0,
    ),
    "An agent response or structured interaction was recorded",
    first ? [first.id] : [],
  );
  add(
    "instruction-snapshot",
    e.instructions.some((i) => i.path.endsWith("first-task/SKILL.md")) &&
      e.instructions.some((i) => i.path === "AGENTS.md") &&
      e.instructions.every(
        (i) =>
          digestText(i.content) === (i.contentSha256 ?? i.sha256) &&
          (i.redacted || i.sha256 === digestText(i.content)),
      ),
    "Actual persona and skill were retained with verified hashes",
    e.instructions.map((i) => i.path),
  );
  checks.push(gradeQuestionChoices(e.checkpoints));
  if (!first || !last) return checks;
  const text = replies(first)
    .map((r) => r.body ?? "")
    .join("\n");
  const questions = first.interactions.filter(
    (i) =>
      i.kind === "ask_user_questions" &&
      !e.checkpoints[0]?.interactions.some((old) => old.id === i.id),
  );
  add(
    "no-reintroduction",
    !/welcome to paperclip|your first agent teammate/i.test(text),
    "Do not repeat the seeded welcome",
    [first.id],
  );
  add(
    "opening-not-repeated",
    !questions.some((i) =>
      (i.payload?.questionSet?.questions ?? i.payload?.questions ?? []).some(
        (q: any) => q.id === "first-task-opening",
      ),
    ),
    "Do not post another opening choice",
    [first.id],
  );
  if (scenario.opening === "interview")
    add(
      "interview-questions",
      questions.length === 1 &&
        questionCount(questions[0]) >= 3 &&
        questionCount(questions[0]) <= 4,
      "One structured interview with 3–4 questions",
      [first.id],
    );
  if (scenario.opening === "ambiguous")
    add(
      "focused-clarification",
      questions.length > 0 || (text.match(/\?/g)?.length ?? 0) >= 2,
      "Ask focused questions before proposing ambiguous work",
      [first.id],
    );
  if (["task", "message"].includes(scenario.opening))
    add(
      "subtask-proposal",
      [text, ...first.documents.filter(isPlanningDocument)
        .map((d) => `${d.title ?? ""}\n${d.body ?? ""}`)]
        .some((visible) => hasTaskProposal(visible)) ||
      first.interactions.some((i) =>
        ["request_confirmation", "request_checkbox_confirmation"].includes(i.kind) &&
        hasTaskProposal([i.title, i.summary, i.payload?.prompt, i.payload?.detailsMarkdown]
          .filter(Boolean).join("\n"), true),
      ),
      "Propose a task for the concrete request",
      [first.id],
    );
  if (scenario.opening === "plan" || e.caseId === "interview-plan-accept") {
    const proposal =
      e.checkpoints.find((c) => c.phase === "clarified") ?? first;
    add(
      "durable-plan",
      proposal.documents.some(
        (d) => isPlanDocument(d) && String(d.body).trim(),
      ),
      "Save the requested plan before acceptance",
      [proposal.id],
    );
  }
  const before = e.checkpoints.filter(
    (c) =>
      c.phase !== "opening" &&
      (!approval || Date.parse(c.at) < Date.parse(approval.at)),
  );
  if (scenario.opening !== "ordinary") {
    add(
      "no-premature-work",
      before.every(
        (c) =>
          extras(c).length === 0 &&
          c.agents.length === e.checkpoints[0].agents.length &&
          c.documents.every(isPlanningDocument) &&
          (c.attachments ?? []).every(isPlanningAttachment) &&
          (c.tasks.find((t) => t.id === c.issueId)?.status !== "done" ||
            Boolean(rejection && Date.parse(c.at) >= Date.parse(rejection.at))),
      ),
      "Before acceptance: no hires, execution tasks, finished output, or claimed completion; closing an unexecuted rejected task is allowed",
      before.map((c) => c.id),
    );
  } else {
    add(
      "ordinary-task-control",
      questions.length === 0 &&
        extras(last).length === 0 &&
        verifiedFirstTaskOutputs(last).some(
          (d) =>
            !isPlanningDocument(d) && String(d.body).includes(scenario.marker),
        ),
      "Ordinary work produces output without onboarding questions or delegation",
      [last.id],
    );
  }
  if (e.caseId === "accept-while-running") {
    const accepted = approval?.interactions.find(i => i.status === "accepted" &&
      ["request_confirmation", "request_checkbox_confirmation"].includes(i.kind));
    const source = last.runs.find(r => r.id === accepted?.sourceRunId);
    const acceptedAt = Date.parse(accepted?.resolvedAt ?? "");
    const startedAt = Date.parse(source?.startedAt ?? "");
    const finishedAt = Date.parse(source?.finishedAt ?? "");
    const overlapped = Number.isFinite(acceptedAt) && Number.isFinite(startedAt) &&
      Number.isFinite(finishedAt) && startedAt <= acceptedAt && acceptedAt < finishedAt;
    add("accepted-while-running", overlapped,
      "The persisted approval resolution must fall inside its source run's actual execution interval",
      approval ? [approval.id, last.id] : [last.id],
      overlapped ? undefined : "The recording did not prove acceptance during the source run; the concurrency regression was not exercised.");
  }
  if (!scenario.firstResponseOnly && e.caseId !== "reject-no-execution") {
    const notReached = approval
      ? undefined
      : "The recording did not reach the acceptance checkpoint; this part of the journey was not evaluated.";
    const acceptedComment = approval?.comments.some(
      (c) => !c.authorAgentId && c.body === scenario.acceptance,
    );
    const acceptedCard = approval?.interactions.some(
      (i) =>
        ["request_confirmation", "request_checkbox_confirmation"].includes(
          i.kind,
        ) &&
        i.status === "accepted" &&
        i.result?.outcome === "accepted",
    );
    add(
      "acceptance-recorded",
      Boolean(approval && (acceptedComment || acceptedCard)),
      "Explicit acceptance is persisted as a user comment or approved confirmation card",
      approval ? [approval.id] : [],
      notReached,
    );
    if (e.caseId === "interview-plan-accept") {
      add(
        "accepted-plan-retained",
        last.documents.some((d) => isPlanDocument(d) && String(d.body).trim()),
        "The accepted plan remains available as a durable document",
        [last.id],
        notReached,
      );
    } else {
      const children = extras(last);
      add(
        "one-scoped-subtask",
        children.length === 1 &&
          children[0].parentId === e.onboardingIssueId &&
          children[0].assigneeAgentId === e.agentId,
        "Exactly one approved subtask belongs to this onboarding issue and agent",
        [last.id],
        notReached,
      );
      add(
        "creation-after-acceptance",
        Boolean(approval) &&
          children.every(
            (t) =>
              typeof t.createdAt === "string" &&
              Date.parse(t.createdAt) >= Date.parse(approval!.at),
          ),
        "Task creation must follow acceptance, including between checkpoints",
        [last.id],
        notReached,
      );
      add(
        "durable-completion",
        children.length === 1 &&
          children[0].status === "done" &&
          verifiedFirstTaskOutputs(last).some(
            (d) =>
              d.issueId === children[0].id &&
              !isPlanningDocument(d) &&
              String(d.body).includes(scenario.marker) &&
              (e.caseId !== "revise-accept" ||
                (!String(d.body).includes(scenario.originalMarker) &&
                  /sunday/i.test(d.body))),
          ),
        "Approved output is saved on the completed child, with revised scope when applicable",
        [last.id],
        notReached,
      );
    }
  }
  if (e.caseId === "reject-no-execution")
    add(
      "rejection-respected",
      extras(last).length === 0 &&
        last.documents.every(isPlanningDocument) &&
        (last.attachments ?? []).every(isPlanningAttachment) &&
        activeRuns(last.runs).length === 0,
      "Rejected work never executes",
      [last.id],
      rejection
        ? undefined
        : "The recording did not reach the rejection checkpoint; the rejection response was not evaluated.",
    );
  add(
    "provider-runs-succeeded",
    last.runs.length > 0 && last.runs.every((r) => r.status === "succeeded" || isBlockedUnstartedWake(r) ||
      (scenario.firstResponseOnly && r.status === "running" && answerableRuntimeRunIds(last.interactions).has(r.id))),
    "Provider runs succeeded, or a first-response run is paused on its recorded answerable native question",
    [last.id],
  );
  if (e.runtimeSettings?.adapterType === "paperclip_runner" &&
    ["task-reply-accept", "task-card-accept"].includes(e.caseId) && last.phase === "finished") {
    checks.push({ ...gradeNativeSessionContinuity(e.checkpoints.flatMap((checkpoint) => checkpoint.runs), e.onboardingIssueId), evidence: [last.id] });
  }
  if (e.runtimeSettings?.completionDeliveryProbe && last) {
    const worker = last.tasks.find(t => t.parentId === e.onboardingIssueId) ?? {};
    checks.push(...completionDelivery({ sourceId: e.onboardingIssueId, worker, documents: last.documents,
      comments: last.comments, runs: last.runs, marker: scenario.marker,
      renderedLinks: e.runtimeSettings.completionRenderedLinks as Array<{ commentId: string; href: string }> | undefined,
    }).checks.map(check => ({ ...check, evidence: [last.id] })));
  }
  return checks;
}
