import { createHash } from "node:crypto";
import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { verifyDistinctTaskFixtures } from "./internal-distinct-fixtures.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatRun, ChatIssue } from "../chat-flow.js";
import { dropChatSendAcknowledgement } from "../lost-send.js";
import { pollUntil } from "../api.js";
import { makeDefinition, fixtureWorker } from "./internal-definition.js";
import { observeInternal, project, task, entity, observation, checks, hasLink, sameTask,
  type Entity, type InternalObservation } from "./internal-support.js";

interface Attachment extends Entity { contentType?: string; originalFilename?: string; filename?: string; byteSize?: number }
interface CreationObservation extends InternalObservation {
  source: ChatIssue | null;
  replies: Entity[];
  sourceComments: Array<Entity & { clientRequestId?: string }>;
  websiteFiles: Array<{ issueId: string; attachmentId: string; body: string; sha256: string; createdAt?: string }>;
}
function boundIssue(run: ChatRun) { return (run as ChatRun & { nativeIssueId?: string }).nativeIssueId ?? run.contextSnapshot?.issueId; }
function newTasks(o: InternalObservation) {
  const priorIds = Array.isArray(o.state.priorTasks) ? (o.state.priorTasks as Entity[]).map(row => row.id) : [];
  return o.tasks.filter(row => !priorIds.includes(row.id));
}
function creationObservation(value: unknown): CreationObservation | undefined {
  const o = observation(value) as CreationObservation | undefined;
  return o && Array.isArray(o.replies) && Array.isArray(o.sourceComments) && Array.isArray(o.websiteFiles) ? o : undefined;
}
export function gradeDelegatedCreation(value: unknown) {
  const c = checks(); const o = creationObservation(value);
  c.add("complete-creation-evidence", !!o, "Creation needs actual conversation, task, worker-run and delivered-file observations.");
  if (!o) return c.result();
  const created = newTasks(o); const saved = created[0]; const worker = entity(o.state, "worker");
  const launch = o.projects.filter(row => row.name === "Launch"); const p = launch[0];
  const workRuns = saved ? o.runs.filter(run => boundIssue(run) === saved.id) : [];
  c.add("one-ordinary-company-task", created.length === 1 && !!saved && saved.companyId === o.companyId
    && saved.assigneeAgentId === worker.id && saved.parentId == null && saved.projectId === p?.id && saved.id !== o.source?.id,
    "One ordinary task belongs to the intended Launch project and single eligible Morgan, separately from standing Chat.");
  c.add("requested-work-captured", !!saved && (o.scenarioId === "projects.project-work"
    ? /\bmobile\b/i.test(`${saved.title} ${saved.description ?? ""}`) && /\blayout\b/i.test(`${saved.title} ${saved.description ?? ""}`)
    : /\b(?:website|web site|landing.page)\b/i.test(`${saved.title} ${saved.description ?? ""}`)),
    "The actual new task captures the requested website or mobile-layout work.");
  c.add("one-launch-and-attribution", launch.length === 1 && p?.companyId === o.companyId && !!saved
    && o.activity.filter(row => row.action === "issue.created" && row.entityId === saved.id).length === 1
    && o.activity.some(row => row.action === "issue.created" && row.entityId === saved.id && row.agentId === o.leadId),
    "Exactly one intended Launch and one CEO-attributed task creation exist.");
  c.add("retained-chat-and-links", o.source?.assigneeAgentId === o.leadId && o.source.status === "in_review"
    && o.source.conversationState === "waiting" && !o.source.scheduledRetry && !o.source.activeRecoveryAction
    && !!saved && hasLink(o, "issues", saved) && !!p && (o.scenarioId !== "tasks.website-without-project" || hasLink(o, "projects", p)),
    "The original source remains a settled standing conversation and renders the actual saved result links.");
  c.add("separate-admitted-worker", o.scenarioId === "projects.project-work" && workRuns.length === 0 || workRuns.length === 1
    && workRuns[0]?.agentId === worker.id && ["queued", "running", "succeeded"].includes(workRuns[0]?.status ?? ""),
    "Requested execution is a separate Morgan run bound to the actual new task; project task creation may remain saved.");
  const readinessClaim = /\b(?:website|site|landing.page)\b(?!\s+task\b)[^.!?\n]{0,60}\b(?:is ready|is live|is built|is complete|has been built|has been deployed)\b/i;
  c.add("no-premature-website-success", o.replies.every(reply => !readinessClaim.test(reply.body ?? "") || !!saved && saved.status === "done"
    && workRuns.some(run => run.status === "succeeded") && o.websiteFiles.some(file => file.issueId === saved.id
      && /<html\b/i.test(file.body) && /<body\b/i.test(file.body) && /<h[1-6]\b/i.test(file.body)
      && Date.parse(file.createdAt ?? "") <= Date.parse(reply.createdAt ?? ""))),
    "A claimed finished website requires independently downloaded HTML from the executed task, rather than task creation alone.");
  const priorTasks = Array.isArray(o.state.priorTasks) ? o.state.priorTasks as Entity[] : [];
  c.add("existing-work-preserved", priorTasks.every(before => sameTask(before, o.tasks.find(row => row.id === before.id))),
    "Existing tasks, including similarly named work in other projects, remain unchanged.");
  if (o.scenarioId === "projects.project-work") {
    const open = priorTasks.filter(row => row.projectId === p?.id && !["done", "cancelled"].includes(row.status ?? ""));
    c.add("launch-leftover-summary", open.length > 0 && open.every(row => hasLink(o, "issues", row))
      && priorTasks.filter(row => row.projectId !== p?.id).every(row => !hasLink(o, "issues", row)),
      "The leftover-work summary is grounded in Launch's unfinished work and excludes the other project's distractor.");
  }
  if (o.scenarioId === "tasks.website-without-project") {
    const transport = o.state.transport as { commentId?: string; clientRequestId?: string; replayedCommentId?: string; firstTaskId?: string; firstProjectId?: string } | undefined;
    const requestRuns = transport ? o.runs.filter(run => run.contextSnapshot?.wakeCommentId === transport.commentId
      || Array.isArray(run.contextSnapshot?.wakeCommentIds) && run.contextSnapshot.wakeCommentIds.includes(transport.commentId)) : [];
    c.add("committed-lost-ack-recovery", !!transport && typeof transport.commentId === "string" && !!transport.commentId
      && typeof transport.clientRequestId === "string" && !!transport.clientRequestId && transport.commentId === transport.replayedCommentId
      && o.sourceComments.filter(row => row.clientRequestId === transport.clientRequestId).map(row => row.id).join() === transport.commentId
      && saved?.id === transport.firstTaskId && p?.id === transport.firstProjectId && requestRuns.length === 1,
      "A real lost HTTP acknowledgement and exact client-request replay retain one original comment, project, task and request-bound run.");
    c.add("new-project-is-agent-created", !!p && o.activity.some(row => row.action === "project.created" && row.entityId === p.id && row.agentId === o.leadId),
      "The harness did not seed the requested new project.");
  }
  return c.result();
}
async function observeCreation(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<CreationObservation> {
  const o = await observeInternal(ctx, state); const source = ctx.issue();
  const sourceComments = source ? await ctx.input.api.get<CreationObservation["sourceComments"]>(`/api/issues/${source.id}/comments?order=asc`) : [];
  const replies = sourceComments.filter(row => row.authorAgentId === o.leadId && o.runs.some(run => run.id === row.createdByRunId));
  const websiteFiles: CreationObservation["websiteFiles"] = [];
  for (const saved of newTasks(o)) {
    const attachments = await ctx.input.api.get<Attachment[]>(`/api/issues/${saved.id}/attachments`);
    for (const file of attachments.filter(row => /\.html?$/i.test(row.originalFilename ?? row.filename ?? "") || row.contentType === "text/html").slice(0, 3)) {
      if (file.byteSize !== undefined && file.byteSize > 1_048_576) continue;
      const content = await ctx.input.api.getAttachmentContent(file.id);
      const body = content.toString("utf8");
      if (Buffer.byteLength(body) <= 1_048_576) websiteFiles.push({ issueId: saved.id, attachmentId: file.id, body,
        sha256: createHash("sha256").update(body).digest("hex"), createdAt: file.createdAt });
    }
  }
  return { ...o, source: source ?? null, replies, sourceComments, websiteFiles };
}
function creationDefinition(scenarioId: string): ChatCatalogCase {
  let interception: Awaited<ReturnType<typeof dropChatSendAcknowledgement>> | undefined;
  const base = makeDefinition(scenarioId, async ctx => {
    const worker = await fixtureWorker(ctx); const priorTasks: Entity[] = [];
    if (scenarioId !== "tasks.website-without-project") {
      const p = await project(ctx, "Launch", { description: "Acorn Notes is a note-taking product for small research teams. The website should explain it and offer signup." });
      if (scenarioId === "projects.project-work") {
        priorTasks.push(await task(ctx, "Signup copy", p.id));
        priorTasks.push(await task(ctx, "Product brief", p.id, { status: "done" }));
        const other = await project(ctx, "Experiments"); priorTasks.push(await task(ctx, "Signup copy", other.id, { allowDuplicate: true }));
        await verifyDistinctTaskFixtures(ctx, priorTasks);
      }
    }
    if (scenarioId === "tasks.website-without-project") interception = await dropChatSendAcknowledgement(ctx.input.page, ctx.scenario.query);
    return { worker, priorTasks };
  }, gradeDelegatedCreation);
  return { ...base, observe: observeCreation, sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-task-creation.ts", "lost-send.ts"],
    expectedRunCount: 3, minimumRunCount: scenarioId === "projects.project-work" ? 1 : 2,
    runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
    async act(ctx, state) {
      if (scenarioId !== "tasks.website-without-project") return;
      if (!interception) throw new Error("Lost acknowledgement fixture was not armed");
      const sent = await interception.committed;
      const first = await pollUntil({ label: "Committed project and task before lost-ack replay", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
        load: () => observeCreation(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && newTasks(o).length === 1 && o.projects.filter(row => row.name === "Launch").length === 1
          && ctx.issue()?.conversationState === "waiting" });
      await interception.dispose();
      const replay = await ctx.input.api.post<{ id: string }>(sent.path, sent.data);
      state.transport = { commentId: sent.commentId, clientRequestId: String(sent.data.clientRequestId), replayedCommentId: replay.id,
        firstTaskId: newTasks(first)[0]!.id, firstProjectId: first.projects.find(row => row.name === "Launch")!.id };
      await ctx.input.evidence("chat-catalog-lost-ack-transport.json", { fault: "server committed; browser acknowledgement reset", ...state.transport as object,
        originalRequestBody: sent.data.body, retry: "Exact original production clientRequestId and request payload; no new human prompt." });
      await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    },
    async cleanup() { await interception?.dispose(); interception = undefined; },
  };
}
export const delegatedTaskCases: readonly ChatCatalogCase[] = [creationDefinition("tasks.website-task"), creationDefinition("tasks.website-without-project")];
export const projectWorkCases: readonly ChatCatalogCase[] = [creationDefinition("projects.project-work")];
