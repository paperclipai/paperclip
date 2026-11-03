import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { expect, it } from "vitest";
import { currentWorkerTaskPlan } from "./task-plan-instructions.js";
import { gradeAttachmentBrief, taskAttachmentCases } from "./internal-task-attachment.js";
import { completionDelivery } from "../completion-updates.js";
import { gradeDelegation, runtimeDelegationCases } from "./runtime-delegation.js";

function actualDocumentProjection(body: string) {
  const source = readFileSync(new URL("../../../server/src/services/documents.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function mapIssueDocumentRow(");
  const end = source.indexOf("export const issueDocumentSelect", start);
  const compiled = stripTypeScriptTypes(source.slice(start, end).replace("export function", "function"), { mode: "strip" });
  const context: { mapper?: (row: object, includeBody: boolean) => object } = {};
  runInNewContext(`${compiled};globalThis.mapper=mapIssueDocumentRow;`, context);
  const dto = context.mapper!({ id: "plan", companyId: "company", issueId: "work", key: "plan", format: "markdown",
    latestBody: body, latestRevisionId: "revision", latestRevisionNumber: 1, createdByAgentId: "ceo", updatedByAgentId: "ceo",
    createdAt: new Date("2026-11-03T10:00:01Z"), updatedAt: new Date("2026-11-03T10:00:01Z") }, true);
  return JSON.parse(JSON.stringify(dto)) as { id: string; companyId: string; issueId: string; key: string; body: string; latestRevisionId: string; latestRevisionNumber: number; createdByAgentId: string; updatedByAgentId: string; updatedAt: string; sourceTrust: { disposition: string } | null };
}
function fixture(kind: "147" | "599") {
  const body = kind === "147" ? "Turn [the attached brief](/api/attachments/brief/content) into a website."
    : "Implement [the brief](/api/attachments/brief/content) for Launch. Report back here when the page is ready.";
  const document = actualDocumentProjection(body), workerDocument = structuredClone(document);
  const revision = { id: "revision", documentId: "plan", issueId: "work", companyId: "company", key: "plan", revisionNumber: 1,
    body, createdByAgentId: "ceo", createdByRunId: "canonical", createdAt: "2026-11-03T10:00:01Z" };
  const task = { id: "work", companyId: "company", title: "Acorn implementation", description: null as string | null,
    assigneeAgentId: "morgan", parentId: "launch", status: "done", completedAt: "2026-11-03T10:00:04Z" };
  const creatorRun = { id: "canonical", companyId: "company", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "source" }, startedAt: "2026-11-03T10:00:00Z" };
  const workerRun = { id: "worker", companyId: "company", agentId: "morgan", status: "succeeded", contextSnapshot: { issueId: "work" }, startedAt: "2026-11-03T10:00:02Z" };
  const workerTask = structuredClone(task), worker = { id: "morgan" };
  const returnRun = { ...creatorRun, id: "return", contextSnapshot: { issueId: "source", chatCompletionUpdates: [{ id: "work", status: "done" }] } };
  const sourceComment = { id: "response", companyId: "company", issueId: "source", authorAgentId: "ceo", createdByRunId: "return", createdAt: "2026-11-03T10:00:05Z", body: "Morgan completed the page; the actual result is ready." };
  const delivery = completionDelivery({ sourceId: "source", worker: task, marker: "proof", documents: [{ id: "output", issueId: "work", key: "website-delivery", body: "proof" }],
    comments: [sourceComment], runs: [returnRun], renderedLinks: [{ commentId: sourceComment.id, href: "/issues/work" }] });
  const proof = { document, revision, workerDocument, workerTask };
  const receipt = { id: "brief", companyId: "company", issueId: kind === "147" ? "source" : "launch", createdByUserId: "human", createdByAgentId: null,
    issueCommentId: "human-brief", sha256: "original-hash", contentPath: "/api/attachments/brief/content" };
  const common = { scenarioId: kind === "147" ? "tasks.attachment-brief" : "task-coordination.delegate-with-context", origin: "https://fixture.test", companyId: "company", leadId: "ceo", projects: [], goals: [], comments: [], revisions: [], documents: [document], agents: [], links: ["/issues/work"], humanQueries: [], reply: "Morgan has the implementation task.",
    activity: [{ id: "created", action: "issue.created", entityId: "work", agentId: "ceo", runId: "canonical" }] };
  const observation: Record<string, unknown> = kind === "147" ? { ...common, ...proof, sourceId: "source", tasks: [task], runs: [creatorRun, workerRun],
    state: { worker, briefAttachment: receipt, briefHash: "original-hash" }, sourceAttachments: [receipt], originalBytesHash: "original-hash", workAttachments: [], workDocuments: [document],
    durablePath: receipt.contentPath, workerTaskStatus: 200, workerDownloadStatus: 200, workerDownloadedHash: "original-hash" }
    : { ...common, tasks: [{ id: "launch" }, task], runs: [{ ...creatorRun, id: "context" }, creatorRun, workerRun, returnRun],
      state: { sourceId: "source", parent: { id: "launch" }, task, worker, taskPlanRead: proof, humanId: "human", briefCommentId: "human-brief", briefHash: "original-hash", briefDownloadedHash: "original-hash", briefAttachment: receipt,
        parentOwnedByCeo: true, parentContextRetained: true, createdFromSource: true, childHasBrief: true, linkedToLaunch: false,
        workerBriefReadStatus: 200, workerBriefHash: "original-hash", briefContextKind: "direct-attachment-reference", workerTaskReadStatus: 200,
        workerWasReallyWaiting: true, actualWebsiteArtifact: true, sourceReturnComments: [sourceComment], delivery } };
  return { observation, task, document, revision, workerDocument, workerTask, creatorRun, workerRun, returnRun, sourceComment, delivery, grade: kind === "147" ? gradeAttachmentBrief : gradeDelegation };
}
for (const kind of ["147", "599"] as const) {
  it(`${kind} accepts obligations from the actual producer-shaped current worker-readable pre-dispatch plan`, () => {
    const f = fixture(kind); expect(f.task.description).toBeNull(); expect(f.grade(f.observation).passed).toBe(true);
  });
  for (const fault of ["foreign-company", "wrong-task", "old-revision", "board-only", "worker-output", "post-start", "quarantined", "wrong-creator-run", "wrong-worker", "missing-obligation", "parent-only"] as const) {
    it(`${kind} refuses ${fault} as instruction evidence`, () => {
      const f = fixture(kind);
      if (fault === "foreign-company") f.document.companyId = "foreign";
      if (fault === "wrong-task" || fault === "parent-only") f.document.issueId = "launch";
      if (fault === "old-revision") f.document.latestRevisionId = "newer-revision";
      if (fault === "board-only") f.workerDocument.body = "";
      if (fault === "worker-output") { f.document.key = "website-delivery"; f.document.createdByAgentId = "morgan"; }
      if (fault === "post-start") { f.document.updatedAt = "2026-11-03T10:00:03Z"; f.workerDocument.updatedAt = f.document.updatedAt; }
      if (fault === "quarantined") f.document.sourceTrust = { disposition: "quarantined" };
      if (fault === "wrong-creator-run") f.revision.createdByRunId = "other-source-turn";
      if (fault === "wrong-worker") f.workerTask.assigneeAgentId = "other-worker";
      if (fault === "missing-obligation") { f.document.body = "Read the brief."; f.workerDocument.body = f.document.body; f.revision.body = f.document.body; }
      expect(f.grade(f.observation).passed).toBe(false);
    });
  }
}
it("requires source-bound creator and actual worker clocks instead of post-hoc text", () => {
  const f = fixture("147");
  const input = { ...f, companyId: "company", sourceId: "source", leadId: "ceo", workerId: "morgan" };
  expect(currentWorkerTaskPlan(input)).toBe(f.document.body);
  expect(currentWorkerTaskPlan({ ...input, creatorRun: { ...f.creatorRun, contextSnapshot: { issueId: "other-source" } } })).toBe("");
  expect(currentWorkerTaskPlan({ ...input, workerRun: { ...f.workerRun, startedAt: undefined } })).toBe("");
});

it("147 does not mistake worker-output text for the brief's initial instruction reference", () => {
  const f = fixture("147"); f.document.body = "Build a website."; f.workerDocument.body = f.document.body; f.revision.body = f.document.body;
  (f.observation.workDocuments as object[]).push({ id: "output", key: "website-delivery", body: "/api/attachments/brief/content" });
  expect(f.grade(f.observation).passed).toBe(false);
});




it("599 accepts an actual source-return obligation without prescribed report words in the task", async () => {
  const f = fixture("599"); f.document.body = "Implement [the approved brief](/api/attachments/brief/content) for Launch.";
  f.workerDocument.body = f.document.body; f.revision.body = f.document.body;
  const source = readFileSync(new URL("../../../server/src/services/chat-completion-delivery.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function recordAcceptedChatHandoff(");
  const end = source.indexOf("/** Must run on the same transaction", start);
  const code = stripTypeScriptTypes(source.slice(start, end).replaceAll("export async function", "async function"), { mode: "strip" });
  const stored: object[] = [];
  const run = { ...f.creatorRun, nativeIssueId: "source", contextSnapshot: { issueId: "source", conversationSessionGeneration: 1 } };
  const conversation = { id: "source", companyId: "company", conversationAgentId: "ceo", conversationSessionGeneration: 1 };
  const rows = [[run], [conversation]];
  const tx = { select: () => ({ from: () => ({ where: async () => rows.shift() }) }),
    insert: () => ({ values: (value: object) => ({ onConflictDoNothing: async () => { stored.push(value); } }) }) };
  const context: { record?: (tx: unknown, task: unknown, runId: string) => Promise<void> } = {};
  Object.assign(context, { heartbeatRuns: {}, issues: {}, handoffs: {}, and: (...values: unknown[]) => values, eq: (...values: unknown[]) => values,
    forbidden: (message: string) => new Error(message) });
  runInNewContext(`${code};globalThis.record=recordChatHandoff;`, context);
  await context.record!(tx, { ...f.task, createdByAgentId: "ceo", conversationAgentId: null }, run.id);
  expect(stored).toEqual([{ taskId: f.task.id, companyId: "company", conversationId: "source", agentId: "ceo", sessionGeneration: 1 }]);
  expect(f.grade(f.observation).passed).toBe(true);
});
for (const fault of ["wrong-task", "wrong-source", "wrong-ceo", "wrong-run", "missing-comment", "empty-checks", "failed-update", "early-response", "foreign-company"] as const) {
  it(`599 refuses ${fault} final return even when task prose requests reporting`, () => {
    const f = fixture("599");
    if (fault === "wrong-task") f.returnRun.contextSnapshot.chatCompletionUpdates[0]!.id = "other-task";
    if (fault === "wrong-source") f.sourceComment.issueId = "other-source";
    if (fault === "wrong-ceo") f.sourceComment.authorAgentId = "other-agent";
    if (fault === "wrong-run") f.sourceComment.createdByRunId = "other-run";
    if (fault === "missing-comment") (f.observation.state as Record<string, unknown>).sourceReturnComments = [];
    if (fault === "empty-checks") f.delivery.checks.splice(0);
    if (fault === "failed-update") f.returnRun.contextSnapshot.chatCompletionUpdates[0]!.status = "failed";
    if (fault === "early-response") f.sourceComment.createdAt = "2026-11-03T10:00:03Z";
    if (fault === "foreign-company") f.returnRun.companyId = "other-company";
    expect(f.grade(f.observation).passed).toBe(false);
  });
}

for (const definition of [...taskAttachmentCases, ...runtimeDelegationCases]) {
  it(`${definition.scenarioId} retains exact declared source and accounting metadata`, () => {
    const rows = JSON.parse(readFileSync(new URL("../chat-catalog-descriptors.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    const row = rows.find(value => value.scenarioId === definition.scenarioId)!;
    for (const key of ["oracleVersion", "sourceFiles", "expectedRunCount", "attemptTimeoutMs", "turnTimeoutMs"] as const)
      expect(row[key]).toEqual(definition[key]);
  });
}
