import { completionDelivery } from "./completion-updates.js";
import type { ChatFeatureCase } from "./chat-feature-cases.js";

export interface FeatureTask {
  id: string; companyId: string; title: string; description?: string | null; identifier?: string; status: string;
  assigneeAgentId?: string | null; projectId?: string | null; parentId?: string | null;
  completedAt?: string | null; conversationState?: string; scheduledRetry?: unknown; activeRecoveryAction?: unknown;
}
export interface FeatureRun {
  id: string; companyId: string; agentId: string; status: string; runtimeMode?: string;
  nativeIssueId?: string | null; startedAt?: string | null; finishedAt?: string | null;
  contextSnapshot?: Record<string, any>; resultJson?: Record<string, any>;
}
export interface FeatureComment {
  id: string; issueId: string; body: string; createdAt: string;
  authorAgentId?: string | null; authorUserId?: string | null; createdByRunId?: string | null;
}
export interface FeatureDocument {
  id: string; issueId?: string; companyId: string; key: string; body: string;
  latestRevisionId: string; createdByAgentId?: string; updatedByAgentId?: string;
  document?: { id: string; companyId: string; createdByAgentId?: string; updatedByAgentId?: string };
  revisions: Array<{ id: string; body: string; createdByAgentId?: string; createdByRunId?: string; createdAt: string }>;
}
export interface ChatFeatureObservation {
  caseId: ChatFeatureCase; companyId: string; leadId: string; workerId: string; projectId: string;
  source: FeatureTask | null; tasks: FeatureTask[]; runs: FeatureRun[];
  comments: FeatureComment[]; documents: FeatureDocument[];
  activity: Array<{ action: string; agentId?: string | null; details?: Record<string, unknown> }>;
  query: string; marker: string;
  renderedLinks: Array<{ commentId: string; href: string }>;
}
export function linksFeatureTask(href: string, task: FeatureTask): boolean {
  try {
    const url = new URL(href, "http://fixture.invalid");
    if (url.origin !== "http://fixture.invalid") return false;
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const index = parts.indexOf("issues");
    return index >= 0 && [task.id, task.identifier].filter(Boolean).includes(parts[index + 1]);
  } catch { return false; }
}
export function announcementMatchesBrief(body: string, marker: string): boolean {
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(body.trim())]
    .map(part => part.segment.trim()).filter(Boolean);
  return /\bAcorn Notes\b/i.test(body) && /\bNovember 12\b/i.test(body) && body.includes(marker)
    && sentences.length === 2 && sentences.every(sentence => /[.!?]["'”’]*$/.test(sentence));
}

export function gradeChatFeature(input: ChatFeatureObservation) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const task = input.tasks[0];
  const source = input.source;
  const taskRuns = task ? input.runs.filter(run => (run.nativeIssueId ?? run.contextSnapshot?.issueId) === task.id) : [];
  const sourceRuns = input.runs.filter(run => source && (run.nativeIssueId ?? run.contextSnapshot?.issueId) === source.id);
  const savedQuery = input.comments.filter(comment => !comment.authorAgentId && comment.body.trim() === input.query.trim());
  const replies = input.comments.filter(comment => comment.authorAgentId === input.leadId && sourceRuns.some(run => run.id === comment.createdByRunId));
  add("one-human-request", savedQuery.length === 1 && input.comments.filter(comment => !comment.authorAgentId).length === 1,
    "Exactly the YAML query was submitted once; no hidden follow-up nudged completion.");
  add("one-assigned-task", input.tasks.length === 1 && !!task && task.companyId === input.companyId
    && task.projectId === input.projectId && task.assigneeAgentId === input.workerId && task.parentId == null && task.id !== source?.id,
  "One ordinary task belongs to Launch and Morgan, separate from the standing conversation.");
  const taskText = `${task?.title ?? ""}\n${task?.description ?? ""}`;
  add("task-request-captured", /\blaunch\b/i.test(taskText) && /\bannouncement\b/i.test(taskText),
    "The saved task actually requests the launch announcement, not unrelated work for the right owner.");
  const creations = input.activity.filter(event => event.action === "issue.created");
  add("agent-created-task", creations.length === 1 && creations[0]!.agentId === input.leadId,
    "The CEO's actual creation audit proves the harness did not create the result.");
  add("bounded-native-work", input.runs.length === (input.caseId === "create-backlog" ? 1 : 3)
    && input.runs.every(run => run.companyId === input.companyId && run.runtimeMode === "native" && run.status === "succeeded")
    && input.runs.length === sourceRuns.length + taskRuns.length,
  "All company runs are accounted for, native, succeeded, and bound to the source or delegated task.");
  add("conversation-retained", !!source && source.companyId === input.companyId && source.assigneeAgentId === input.leadId
    && source.status === "in_review" && source.conversationState === "waiting" && !source.scheduledRetry && !source.activeRecoveryAction,
  "The source conversation remains available and settled without recovery.");
  add("chat-task-link", !!task && input.renderedLinks.some(link => replies.some(reply => reply.id === link.commentId) && linksFeatureTask(link.href, task)),
    "An attributed chat reply renders a link to the exact created task.");
  if (input.caseId === "create-backlog") {
    add("saved-without-execution", task?.status === "backlog" && taskRuns.length === 0 && !task.scheduledRetry && !task.activeRecoveryAction
      && creations[0]?.details?.status === "backlog" && sourceRuns.length === 1,
    "The original creation was backlog; briefly starting and later correcting it cannot pass.");
    add("backlog-reply", replies.some(reply => /\b(backlog|not started|not start|won't start|will not start|saved for later)\b/i.test(reply.body)),
      "The reply communicates that the work remains unstarted.");
  } else {
    add("worker-executed", taskRuns.length === 1 && taskRuns[0]!.agentId === input.workerId && task?.status === "done"
      && Number.isFinite(Date.parse(task.completedAt ?? "")) && !task.scheduledRetry && !task.activeRecoveryAction,
    "Morgan actually executed the one task and it is durably Done.");
    const outputs = input.documents.filter(document => document.issueId === task?.id && !["plan", "summary", "proposal"].includes(document.key.toLowerCase()));
    add("grounded-worker-document", outputs.some(document => {
      const metadata = document.document ?? document;
      return metadata.companyId === input.companyId && metadata.createdByAgentId === input.workerId && metadata.updatedByAgentId === input.workerId
        && announcementMatchesBrief(document.body, input.marker)
        && document.revisions.some(revision => revision.id === document.latestRevisionId && revision.body === document.body
          && revision.createdByAgentId === input.workerId && taskRuns.some(run => run.id === revision.createdByRunId
            && Date.parse(revision.createdAt) >= Date.parse(run.startedAt ?? "") && Date.parse(revision.createdAt) <= Date.parse(run.finishedAt ?? "")));
    }), "A current worker-authored revision contains two sentences and the brief's product, date and invitation code.");
    const delivery = completionDelivery({ sourceId: source?.id ?? "", worker: task ?? {}, documents: outputs,
      comments: input.comments, runs: input.runs, marker: input.marker,
      renderedLinks: input.renderedLinks.filter(link => task && linksFeatureTask(link.href, task)) });
    checks.push(...delivery.checks);
  }
  return { passed: checks.every(check => check.passed), checks };
}
