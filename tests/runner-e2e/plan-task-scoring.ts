import { isDeepStrictEqual } from "node:util";
import type { PlanCase } from "./plan-task-cases.js";

export type PlanRow = Record<string, any>;
export interface PlanDocument { id: string; latestRevisionNumber: number; issueId: string; key: string; body: string; latestRevisionId: string; revisions: PlanRow[] }
export interface PlanObservation {
  issues: PlanRow[]; runs: PlanRow[]; documents: PlanDocument[];
  comments: PlanRow[]; activity: PlanRow[]; interactions: PlanRow[]; wakes: PlanRow[];
}
export interface PlanCheck { id: string; passed: boolean; detail: string }
export const PLAN_GRADER = "paperclip.plan-task-guidance.v1";
export function planDocumentJson(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  const text = body.trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try { return JSON.parse(fenced?.[1] ?? text); } catch { return undefined; }
}
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

export function gradePlanTask(input: {
  caseId: PlanCase; marker: string; parentId: string; leadId: string; alexId: string; rileyId: string;
  observation: PlanObservation; maxRuns: number; origin: string;
}) {
  const { caseId, marker, parentId, leadId, alexId, rileyId, observation: o } = input;
  const checks: PlanCheck[] = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const parent = o.issues.find(i => i.id === parentId);
  const children = o.issues.filter(i => i.id !== parentId);
  const alex = children.filter(i => i.assigneeAgentId === alexId);
  const riley = children.filter(i => i.assigneeAgentId === rileyId);
  const expectedChildren = caseId === "cohesive" ? 0 : caseId === "review" ? 1 : 2;
  const pending = o.interactions.some(i => ["pending", "open"].includes(i.status)) || o.wakes.some(w => w.truncated ||
    w.events?.some((event: PlanRow) => event.kind === "wake_request" && !["completed", "skipped", "failed", "cancelled"].includes(event.status) &&
      !(event.status === "coalesced" && o.runs.some(r => r.id === event.runId && r.status === "succeeded"))));
  check("tasks-completed", Boolean(parent) && o.issues.every(i => i.status === "done" && !i.scheduledRetry && !i.activeRecoveryAction) && !pending &&
    o.issues.every(i => o.wakes.filter(w => w.issueId === i.id && Array.isArray(w.events) && !w.truncated).length === 1),
    "Every requested task must be done with no waiting decision, retry, recovery or pending wake; an adverse review is a completed deliverable.");
  check("bounded-native-runs", o.runs.length > 0 && o.runs.length <= input.maxRuns && o.runs.every(r => r.status === "succeeded" && r.runtimeMode === "native" &&
    r.runnerInstanceId && r.nativeSessionId && !r.retryOfRunId && time(r.finishedAt) >= time(r.startedAt)),
    `Observed ${o.runs.length} total run records; all must be successful native executions with identity and finite ordered timestamps, without retries.`);
  check("minimal-owned-work", children.length === expectedChildren && (caseId === "cohesive" ||
    (riley.length === 1 && (caseId === "review" ? alex.length === 0 : alex.length === 1))),
    `Expected ${expectedChildren} independent work items for the stated owners; found ${children.length}.`);

  function document(issue: PlanRow | undefined, owner: string, expected: unknown, label: string) {
    const docs = issue ? o.documents.filter(d => d.issueId === issue.id && d.key === "result") : [];
    const doc = docs.length === 1 ? docs[0] : undefined;
    const revision = doc?.revisions.find(r => r.id === doc.latestRevisionId);
    const writes = o.activity.filter(a => ["issue.document_created", "issue.document_updated"].includes(a.action) &&
      a.entityId === issue?.id && a.details?.documentId === doc?.id && a.details?.key === "result" &&
      a.details?.revisionNumber === doc?.latestRevisionNumber);
    const write = writes.length === 1 ? writes[0] : undefined;
    const run = o.runs.find(r => r.id === write?.runId);
    const runIssue = run?.nativeIssueId ?? run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
    check(`${label}-saved-output`, !!doc && isDeepStrictEqual(planDocumentJson(doc.body), expected), "The saved result must match the independently calculated business output.");
    check(`${label}-authorship`, !!revision && revision.createdByAgentId === owner && !revision.createdByUserId &&
      write?.agentId === owner && run?.agentId === owner && runIssue === issue?.id && revision.body === doc?.body,
      "The latest document revision must join its exact author and run on the owned task; assignment or a claimed signature alone is insufficient.");
    return doc;
  }
  const order = { marker, units: 5, total: 29 };
  const verdict = { marker, verdict: "reject", correctTotal: 29, difference: 1 };
  let expected: unknown = order;
  if (caseId === "parallel") {
    document(alex[0], alexId, { marker, seats: 24 }, "alex");
    document(riley[0], rileyId, { marker, welcome: "Hola, equipo" }, "riley");
    expected = { marker, seats: 24, welcome: "Hola, equipo" };
  }
  if (caseId === "dependency") {
    const source = document(alex[0], alexId, order, "alex");
    expected = { marker, releasedTotal: 29, sourceRevisionId: source?.latestRevisionId };
    document(riley[0], rileyId, expected, "riley");
    const downstream = o.runs.filter(r => (r.nativeIssueId ?? r.contextSnapshot?.issueId ?? r.contextSnapshot?.taskId) === riley[0]?.id);
    check("prerequisite-before-execution", downstream.length > 0 && downstream.every(r => time(r.startedAt) >= time(alex[0]?.completedAt)),
      "No downstream provider execution may precede the prerequisite's persisted completion; late creation is also a valid way to wait.");
  }
  if (caseId === "review") {
    document(riley[0], rileyId, verdict, "independent-review");
    expected = verdict;
    check("review-write-boundary", !o.comments.some(c => c.issueId === parentId && c.authorAgentId === rileyId) &&
      !o.documents.filter(d => d.issueId === parentId).some(d => d.revisions.some(r => r.createdByAgentId === rileyId)),
      "The independent reviewer must deliver on its own task without parent writes.");
  }
  document(parent, leadId, expected, "parent");
  check("handoff-before-parent-completion", !!parent && children.every(c => time(parent.completedAt) >= time(c.completedAt)),
    "Parent completion must follow completion of every delegated deliverable.");
  const parentReplies = o.comments.filter(c => c.issueId === parentId && c.authorAgentId === leadId && typeof c.body === "string");
  check("visible-result-link", parentReplies.some(c => [...String(c.body).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].some(match => {
    try {
      const url = new URL(match[1]!, input.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      const issueIndex = parts.indexOf("issues");
      if (issueIndex < 0) return false;
      const id = parts[issueIndex + 1];
      return url.origin === new URL(input.origin).origin && url.hash === "#document-result" && [parent?.id, parent?.identifier].includes(id);
    } catch { return false; }
  })),
    "The lead must publish a clickable link to the saved result.");
  const parallelOffered = caseId === "parallel" && alex.length === 1 && riley.length === 1
    ? Math.max(time(alex[0].createdAt), time(riley[0].createdAt)) < Math.min(time(alex[0].completedAt), time(riley[0].completedAt)) : null;
  // Scheduling opportunity is reported separately from correctness. Host/provider
  // serialization does not turn correct independently owned work into failure.
  return { schema: PLAN_GRADER, passed: checks.every(c => c.passed), checks,
    measurements: { childCount: children.length, unnecessaryChildCount: Math.max(0, children.length - expectedChildren),
      runCount: o.runs.length, parallelOfferedBeforeFirstCompletion: parallelOffered } };
}
