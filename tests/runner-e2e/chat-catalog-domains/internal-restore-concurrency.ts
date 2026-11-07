import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { projectMarkdownToText } from "../../../packages/shared/src/document-anchors.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { checks, entity, observation, observeInternal, sameTask, hasLink, type Entity, type InternalObservation } from "./internal-support.js";
interface Revision extends Entity { createdByUserId?: string | null }
interface ConcurrentRestore extends InternalObservation { phaseReply: string }
function identifiesRevision(reply: string, doc: Entity) { return !!doc.latestRevisionId && reply.includes(doc.latestRevisionId)
  || Number.isSafeInteger(doc.latestRevisionNumber) && new RegExp(`\\b(?:revision|version|v)\\s*#?${doc.latestRevisionNumber}\\b`, "i").test(reply); }
export function gradeConcurrentRestore(value: unknown, initialGrade: ChatCatalogCase["grade"]) {
  const c = checks(); const o = observation(value) as ConcurrentRestore | undefined;
  c.add("actual-restoration-and-concurrent-context", !!o && typeof o.phaseReply === "string" && !!o.state.firstRestore && !!o.state.readCheckpoint && !!o.state.interveningRevision,
    "The independently graded original restoration, fresh read and actual other-person revision must all be saved."); if (!o || typeof o.phaseReply !== "string") return c.result();
  const first = observation(o.state.firstRestore); const read = observation(o.state.readCheckpoint); const initialDoc = first?.documents.find(row => row.key === "plan");
  c.add("canonical-restoration-complete-before-variant", !!first && initialGrade(first).passed && !!initialDoc && identifiesRevision(first.reply, initialDoc),
    "The unchanged first query restores the exact selected history through its revision path and identifies the resulting current revision before any variant edits.");
  const readReply = o.state.readReply as Entity | undefined; const checkpoint = o.state.preReadRevision as Revision | undefined; const changed = o.state.interveningRevision as Revision | undefined;
  c.add("fresh-read-before-other-editor-change", !!read && !!checkpoint && !!changed && read.reply.includes(String(o.state.readMarker)) && read.reply.includes(checkpoint.id)
    && read.documents.some(row => row.latestRevisionId === checkpoint.id && row.body === checkpoint.body)
    && read.runs.length === 2 && read.runs.every(run => run.agentId === o.leadId && run.status === "succeeded")
    && !!readReply && readReply.authorAgentId === o.leadId && (readReply.body ?? "").includes(String(o.state.readMarker)) && (readReply.body ?? "").includes(checkpoint.id)
    && read.runs.some(run => run.id === readReply.createdByRunId) && !first?.runs.some(run => run.id === readReply.createdByRunId)
    && o.revisions.some(row => row.id === checkpoint.id && row.body === checkpoint.body && (row as Revision).createdByUserId === o.state.editorId)
    && o.revisions.some(row => row.id === changed.id && row.body === changed.body && (row as Revision).createdByUserId === o.state.editorId)
    && Date.parse(changed.createdAt ?? "") >= Date.parse(readReply.createdAt ?? ""),
    "A genuine read reports the unpredictable saved human checkpoint, followed by a different authenticated person's optimistic document edit.");
  const originals = (o.state.originalRevisions as Entity[] | undefined) ?? []; const wanted = originals[1]; const current = o.documents.find(row => row.key === "plan");
  const earlierRunIds = new Set(read?.runs.map(run => run.id) ?? []); const finalRunIds = new Set(o.runs.filter(run => run.agentId === o.leadId && !earlierRunIds.has(run.id)).map(run => run.id));
  const restored = !!current && !!wanted && current.body === wanted.body && current.latestRevisionId !== changed?.id && current.latestRevisionId !== checkpoint?.id
    && o.revisions.some(row => row.id === current.latestRevisionId && row.createdByAgentId === o.leadId && row.body === wanted.body)
    && o.activity.some(row => row.action === "issue.document_restored" && row.entityId === entity(o.state, "task").id && row.agentId === o.leadId
      && row.details?.restoredFromRevisionId === wanted.id && finalRunIds.has((row as Entity & { runId?: string }).runId ?? ""))
    && identifiesRevision(o.phaseReply, current) && /\b(?:restored|restoring)\b/i.test(o.phaseReply);
  const preservedForClarification = current?.latestRevisionId === changed?.id && current?.body === changed?.body
    && /\?|\b(?:confirm|clarif|conflict|pause|before I|cannot|can't|need your|which)\b/i.test(o.phaseReply)
    && !o.activity.some(row => row.action === "issue.document_restored" && finalRunIds.has((row as Entity & { runId?: string }).runId ?? ""));
  c.add("explicitly-handled-actual-intervening-edit", /\bCasey\b/.test(o.phaseReply) && /\boffline\b|\bwithout (?:a )?network\b/i.test(o.phaseReply)
    && /\bprototype\b/i.test(o.phaseReply) && /\b(?:edit|change|revision|version)\b/i.test(o.phaseReply) && (restored || preservedForClarification),
    "Only the final phase may acknowledge Casey's actual offline-prototype edit and either explain an intentional historical restore or retain it while asking for clarification.");
  c.add("all-human-and-original-history-retained", originals.length === 3 && originals.every(old => o.revisions.some(row => row.id === old.id && row.body === old.body))
    && !!initialDoc && o.revisions.some(row => row.id === initialDoc.latestRevisionId && row.body === initialDoc.body)
    && !!checkpoint && !!changed && o.revisions.some(row => row.id === changed.id && row.body === changed.body)
    && o.activity.some(row => row.action === "issue.document_updated" && row.entityId === entity(o.state, "task").id && row.actorType === "user" && row.actorId === o.state.editorId
      && row.details?.revisionNumber === changed.latestRevisionNumber), "The exact three original revisions, initial restoration and both saved human edits remain inspectable with the intervening editor's actual audit attribution.");
  const falseApproval = o.phaseReply.split(/[.\n;]|,\s*but\s*/).some(part => /\b(?:approved|approval granted|rewound|reset execution|rolled back execution)\b/i.test(part)
    && !/\b(?:not|cannot|can't|no|without|doesn't|didn't)\b/i.test(part));
  c.add("no-retroactive-approval-or-execution-rewind", sameTask(entity(o.state, "task"), o.tasks.find(row => row.id === entity(o.state, "task").id)) && !falseApproval
    && !o.activity.some(row => row.agentId === o.leadId && /approval\.approved|issue\.interaction_accepted/.test(row.action ?? "")),
    "Restoring document text neither changes executed task state nor invents an approval of historical work.");
  return c.result();
}
export function withRestoreConcurrency(primary: ChatCatalogCase): ChatCatalogCase {
  let editor: Awaited<ReturnType<typeof createAuthenticatedPerson>> | undefined;
  const humanWrite = async (ctx: ChatCatalogContext, state: Record<string, unknown>, body: string, baseRevisionId: string) => {
    if (!editor) throw new Error("Missing distinct authenticated editor");
    const response = await editor.request(`/api/issues/${entity(state, "task").id}/documents/plan`, "PUT", { title: "Website implementation plan", format: "markdown", body, baseRevisionId });
    if (!response.ok) { await response.body?.cancel(); throw new Error("The other editor's actual optimistic document write was not accepted"); }
    const doc = await response.json() as Entity; const rows = await ctx.input.api.get<Revision[]>(`/api/issues/${entity(state, "task").id}/documents/plan/revisions`);
    const revision = rows.find(row => row.id === doc.latestRevisionId); if (!revision || revision.createdByUserId !== editor.id || revision.body !== body) throw new Error("Other-person edit lacks actual revision attribution");
    return { ...revision, latestRevisionNumber: doc.latestRevisionNumber };
  };
  return { ...primary, authentication: "human-session", coverageGaps: [], expectedRunCount: 3, minimumRunCount: 3, expectedHumanMessageCount: 3, attemptTimeoutMs: 660000,
    sourceFiles: [...primary.sourceFiles, "chat-catalog-domains/internal-restore-concurrency.ts", "chat-catalog-domains/identity-auth.ts"],
    async setup(ctx) { const browser = ctx.input.page.context().browser(); if (!browser || !ctx.input.privateSecrets) throw new Error("Concurrent editor context requires actual authenticated people and private credential redaction");
      editor = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Casey" });
      try { await enrollPrerequisitePerson(ctx, editor, "operator"); return { ...await primary.setup(ctx), editorId: editor.id }; }
      catch (error) { await editor.dispose(); editor = undefined; throw error; } },
    grade: value => gradeConcurrentRestore(value, primary.grade),
    async act(ctx, state) {
      const first = await pollUntil({ label: "Independently valid initial canonical restoration", deadlineAt: Date.now() + 150000,
        load: () => observeInternal(ctx, state), accept: o => o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" && primary.grade(o).passed
          && o.documents.some(doc => doc.key === "plan" && identifiesRevision(o.reply, doc)) });
      state.firstRestore = { ...first, state: structuredClone(state) }; const restored = first.documents.find(doc => doc.key === "plan")!;
      const readMarker = `Human checkpoint ${randomUUID()}`; state.readMarker = readMarker;
      state.preReadRevision = await humanWrite(ctx, state, `${restored.body}\n\n${readMarker}. This is Casey's saved reading checkpoint.\n`, restored.latestRevisionId!);
      const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, "Read the current plan and report its current revision identifier and full text. Do not change it; wait for my next request.");
      const read = await pollUntil({ label: "Actual read of the unpredictable other-editor checkpoint", deadlineAt: Date.now() + 150000,
        load: () => observeInternal(ctx, state), accept: o => o.runs.length === 2 && o.runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting"
          && o.reply.includes(readMarker) && o.reply.includes(entity(state, "preReadRevision").id) });
      const sourceComments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
      state.readReply = sourceComments.find(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.body?.includes(readMarker) && row.body.includes(entity(state, "preReadRevision").id)
        && read.runs.some(run => run.id === row.createdByRunId) && !first.runs.some(run => run.id === row.createdByRunId));
      if (!state.readReply) throw new Error("Fresh document read lacks its exact attributed persisted reply");
      state.readCheckpoint = { ...read, state: structuredClone(state) }; state.readObservedAt = Date.now();
      state.interveningRevision = await humanWrite(ctx, state, `${restored.body}\n\nCasey's concurrent edit: the offline research prototype must remain testable. ${randomUUID()}\n`, entity(state, "preReadRevision").id);
      await ctx.input.evidence("chat-catalog-real-other-editor-concurrent-plan.json", { firstRestore: state.firstRestore, preReadRevision: state.preReadRevision, readCheckpoint: state.readCheckpoint, readObservedAt: state.readObservedAt, interveningRevision: state.interveningRevision, editorId: state.editorId });
      const wanted = (state.originalRevisions as Entity[])[1]!;
      await sendChatMessage(ctx.input.page, `Restore the originally selected historical plan revision ${wanted.id} again. If another editor changed the current plan since your read, explicitly explain how you handle that saved edit while retaining revision history.`);
    },
    async observe(ctx, state): Promise<ConcurrentRestore> { const o = await observeInternal(ctx, state); const prior = observation(state.readCheckpoint); const ids = new Set(prior?.runs.map(run => run.id) ?? []);
      const comments = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
      return { ...o, phaseReply: comments.filter(row => row.authorAgentId === o.leadId && !ids.has(row.createdByRunId ?? "") && o.runs.some(run => run.id === row.createdByRunId)).map(row => row.body ?? "").join("\n") }; },
    async verifyResult(ctx, state, value) {
      const o = value as ConcurrentRestore; const t = entity(state, "task"); const doc = o.documents.find(row => row.key === "plan");
      if (!doc?.latestRevisionNumber || typeof doc.body !== "string") throw new Error("Missing actual current document revision"); const source = ctx.input.page.url();
      const current = await ctx.input.api.get<Entity>(`/api/issues/${t.id}/documents/plan`);
      if (current.id !== doc.id || current.issueId !== t.id || current.key !== "plan" || current.latestRevisionId !== doc.latestRevisionId
        || current.latestRevisionNumber !== doc.latestRevisionNumber || current.body !== doc.body) throw new Error("Current task document identity, revision or bytes changed before UI verification");
      const returned = o.links.find(href => hasLink({ ...o, links: [href] }, "issues", t));
      try {
        const target = new URL(returned ?? `/${ctx.input.fixtures.company.issuePrefix}/issues/${t.identifier ?? t.id}`, o.origin); target.hash = "#document-plan";
        await ctx.input.page.goto(target.href, { waitUntil: "domcontentloaded" });
        await expect(ctx.input.page.getByRole("heading", { name: t.title!, exact: true }).first()).toBeVisible();
        const plan = ctx.input.page.getByTestId("issue-plan-document"); await expect(plan).toBeVisible();
        await expect(plan.getByText(new RegExp(`^Revision ${doc.latestRevisionNumber}\\b`)).first()).toBeVisible();
        await expect(plan).toContainText(projectMarkdownToText(doc.body).text);
        await ctx.input.evidence("chat-catalog-concurrent-plan-current-revision-opened.json", { taskId: t.id, revisionId: doc.latestRevisionId, revisionNumber: doc.latestRevisionNumber, url: ctx.input.page.url() });
      } finally { await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); }
    },
    async cleanup(ctx, state) { try { await primary.cleanup?.(ctx, state); } finally { await editor?.dispose(); editor = undefined; } },
  };
}
