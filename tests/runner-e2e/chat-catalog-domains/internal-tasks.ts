import { savedDesignInstruction, withRenderedCommentReference, validRenderedCommentReference } from "./internal-comment-reference.js";
import { linkedQuestionTakeover, observeLinkedTaskQuestion } from "../chat-linked-question.js";
import { withEditOwnership } from "./internal-edit-ownership.js";
import { verifyDistinctTaskFixtures } from "./internal-distinct-fixtures.js";
import { delegatedTaskCases } from "./internal-task-creation.js";
import { taskPrivacyCases } from "./internal-privacy.js";
import { taskInventoryCases } from "./internal-task-inventory.js";
import { taskAttachmentCases } from "./internal-task-attachment.js";
import { taskCompletionCases } from "./internal-task-completion.js";
import { privateDelegationCases } from "./internal-private-delegation.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { project, task, goal, putDocument, entity, observation, checks, hasLink, sameTask, type Entity, type InternalObservation } from "./internal-support.js";
import { makeDefinition, retryDefinition, fixtureWorker } from "./internal-definition.js";

export function grade_tasks(value: unknown) {
  const c = checks(); const o = observation(value);
  c.add("complete-independent-observation", !!o, "Missing API, document, audit or rendered-link evidence cannot pass.");
  if (!o) return c.result();
  const before = o.state.task ? entity(o.state, "task") : undefined;
  const current = before && o.tasks.find(row => row.id === before.id);
  const savedProject = o.state.project ? entity(o.state, "project") : undefined;
  const projectNow = savedProject && o.projects.find(row => row.id === savedProject.id);
  const authored = (action: string, id: string) => o.activity.some(row => row.action === action && row.entityId === id && row.agentId === o.leadId);
  const linkedTask = () => !!current && hasLink(o, "issues", current);
  switch (o.scenarioId) {
    case "tasks.edit-properties": {
      const worker = entity(o.state, "worker");
      c.add("exact-priority-assignee", !!current && current.priority === "high" && current.assigneeAgentId === worker.id, "The intended landing-page task has one eligible owner and High priority.");
      c.add("no-unrequested-changes", !!before && sameTask(before, current, ["priority", "assigneeAgentId"]) && o.tasks.length === 1, "Task context and execution state remain intact; no workaround duplicate exists.");
      c.add("saved-attribution", !!current && authored("issue.updated", current.id), "A real CEO-attributed mutation changed the requested task.");
      c.add("task-link", linkedTask(), "The reply links to the edited task.");
      break;
    }
    case "tasks.ambiguous-task": {
      const other = entity(o.state, "otherTask");
      const first = observation(o.state.clarification);
      c.add("clarify-before-write", !!first && !!before && sameTask(before, first.tasks.find(row => row.id === before.id))
        && sameTask(other, first.tasks.find(row => row.id === other.id)) && /\?|\b(?:which|choose|select|clarify)\b/i.test(first.reply)
        && hasLink(first, "issues", before) && hasLink(first, "issues", other),
        "The first real turn asks which of both linked tasks before changing either priority.");
      c.add("only-selected-task-changed", !!before && current?.priority === "high" && sameTask(before, current, ["priority"])
        && sameTask(other, o.tasks.find(row => row.id === other.id)) && o.tasks.length === 2,
        "After the explicit Launch selection, only that task's requested priority changes.");
      c.add("attributed-selection", !!current && authored("issue.updated", current.id)
        && !o.activity.some(row => row.entityId === other.id && row.agentId === o.leadId), "The selected mutation is attributed to the CEO and the other task has no agent changes.");
      c.add("selected-result-link", linkedTask(), "The final conversation retains usable access to the exact changed task.");
      break;
    }
    case "tasks.comment-with-reference": {
      const design = entity(o.state, "design");
      const added = o.comments.filter(row => row.authorAgentId === o.leadId && row.createdByRunId && o.runs.some(run => run.id === row.createdByRunId));
      c.add("one-attributed-note", added.length === 1 && savedDesignInstruction(o, added[0]?.body ?? "", design) && validRenderedCommentReference(o, added[0]!, design), "One CEO-authored note retains a usable reference to the actual approved design task.");
      c.add("records-preserved", !!before && sameTask(before, current) && sameTask(design, o.tasks.find(row => row.id === design.id)) && o.tasks.length === 2,
        "The note neither changes either task nor creates another task.");
      c.add("task-link", linkedTask(), "The original conversation links back to the task containing the note.");
      break;
    }
    default: c.add("implemented-scenario", false, "No independent oracle is implemented for this scenario.");
  }
  return c.result();
}

const define = (id: string, setup: ChatCatalogCase["setup"]) => makeDefinition(id, setup, grade_tasks);
export const tasksCases: readonly ChatCatalogCase[] = [
  ...delegatedTaskCases,
  ...taskPrivacyCases,
  ...taskInventoryCases,
  ...taskAttachmentCases,
  ...taskCompletionCases,
  ...privateDelegationCases,
  ambiguousTask(),
  withEditOwnership(define("tasks.edit-properties", async ctx => {
    const p = await project(ctx); const worker = await fixtureWorker(ctx);
    const t = await task(ctx, "Landing page", p.id, { description: "Build the Launch landing page; this work is saved for later." });
    return { project: p, worker, task: t };
  })),
  withRenderedCommentReference(define("tasks.comment-with-reference", async ctx => {
    const p = await project(ctx); const design = await task(ctx, "Approved design", p.id, { status: "done", description: "Approved design: semantic HTML, clear contrast, one primary signup action." });
    const t = await task(ctx, "Landing page", p.id, { description: "Build the launch website." });
    return { project: p, design, task: t };
  })),

];

function ambiguousTask(): ChatCatalogCase {
  const base = define("tasks.ambiguous-task", async ctx => {
    const p = await project(ctx); const otherProject = await project(ctx, "Experiments");
    const t = await task(ctx, "Landing page", p.id);
    // Public creation defaults to company-wide recent-title reuse, regardless of project.
    const otherTask = await task(ctx, "Landing page", otherProject.id, { allowDuplicate: true });
    await verifyDistinctTaskFixtures(ctx, [t, otherTask]);
    return { project: p, task: t, otherProject, otherTask };
  });
  return { ...base, sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-distinct-fixtures.ts", "chat-linked-question.ts"], expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 420_000,
    async act(ctx, state) {
      const plain = await pollUntil({ label: "Task ambiguity clarification", deadlineAt: Date.now() + 150_000,
        load: () => observeInternal(ctx, state), accept: o => o.runs.length === 1 && o.runs.every(row => row.status === "succeeded")
          && ctx.issue()?.conversationState === "waiting" });
      const first = await observeLinkedTaskQuestion(ctx, state, plain);
      state.clarification = { ...first, state: structuredClone(state) };
      await ctx.input.evidence("chat-catalog-task-clarification.json", state.clarification);
      const selected = entity(state, "task"); const other = entity(state, "otherTask");
      if (!sameTask(selected, first.tasks.find(row => row.id === selected.id)) || !sameTask(other, first.tasks.find(row => row.id === other.id)))
        throw new Error("Ambiguous task changed before the person chose a source");
      const answer = `The Landing page task in Launch (${selected.identifier ?? selected.id}).`;
      const card = first.linkedQuestionEvidence;
      if (card) {
        const fresh = (await observeLinkedTaskQuestion(ctx, state, plain)).linkedQuestionEvidence;
        if (!fresh || fresh.interactionId !== card.interactionId || fresh.questionId !== card.questionId || fresh.payloadDigest !== card.payloadDigest)
          throw new Error("The actual linked clarification question changed before the person's selection");
      }
      const answerRoot = card ? linkedQuestionTakeover(ctx.input.page, card) : ctx.input.page;
      const textInput = answerRoot.getByTestId("question-text-answer-composer").last();
      if (await textInput.isVisible()) {
        await textInput.locator('[contenteditable="true"],textarea').first().fill(answer);
        await answerRoot.getByRole("button", { name: /Submit answers|Submit|Continue/, exact: true }).last().click();
      } else {
        const otherChoice = answerRoot.getByRole("radio", { name: "Other", exact: true }).last();
        if (await otherChoice.isVisible()) {
          await otherChoice.click();
          await answerRoot.getByTestId("question-other-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(answer);
          await answerRoot.getByRole("button", { name: /Submit answers|Submit|Continue/, exact: true }).last().click();
        } else {
          if (card) throw new Error("The linked question has no supported explicit clarification input");
          const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, answer);
        }
      }
    },
  };
}
import { observeInternal } from "./internal-support.js";
import { pollUntil } from "../api.js";
