import type { linkedQuestionBinding } from "./chat-linked-question.js";
export type Input = Parameters<typeof linkedQuestionBinding>[0];
export function valid(): Input {
  const task = { id: "launch-task", identifier: "RUN-1", companyId: "company", title: "Landing page", priority: "medium", projectId: "launch" };
  const other = { ...task, id: "experiment-task", identifier: "RUN-2", projectId: "experiments" };
  const query = "Mark the landing-page task as high priority.";
  return { origin: "https://fixture.test", pageUrl: "https://fixture.test/RUN/chats/ceo", companyPrefix: "RUN", sourceId: "source", leadId: "ceo", query, tasks: [task, other],
    comments: [{ id: "human", companyId: "company", issueId: "source", body: query, authorUserId: "person", authorAgentId: null }],
    observation: { scenarioId: "tasks.ambiguous-task", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task, otherTask: other },
      tasks: [structuredClone(task), structuredClone(other)], projects: [], goals: [], comments: [], documents: [], revisions: [], links: [], reply: "", humanQueries: [query],
      runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "source" }, startedAt: "2026-10-28T12:00:00Z", finishedAt: "2026-10-28T12:01:00Z" }],
      activity: [{ id: "action", companyId: "company", action: "issue.thread_interaction_created", entityType: "issue", entityId: "source", actorType: "agent", actorId: "ceo", agentId: "ceo", runId: "run", details: { interactionId: "question", interactionKind: "ask_user_questions" } } as never] },
    interactions: [{ id: "question", companyId: "company", issueId: "source", kind: "ask_user_questions", status: "pending", createdByAgentId: "ceo", createdByUserId: null,
      sourceRunId: "run", originCommentIds: ["human"], addresseeUserId: "person", addresseeAgentId: null, effectiveResolverPolicy: "human_only", createdAt: "2026-10-28T12:00:30Z",
      payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", description: "Choose [Launch Landing page](/RUN/issues/RUN-1) or [Experiments Landing page](/RUN/issues/experiment-task) for High priority.",
        questions: [{ id: "which-task", prompt: "Which Landing page task should be High priority?", answerMode: "text", required: true }] } } } as never] };
}
export function dom() {
  return `<main data-testid="task-chat-thread"><div id="comment-human">Mark the landing-page task as high priority.</div>
    <div data-thread-anchor="question" data-thread-item-kind="interaction"><button id="interaction-question" data-testid="task-chat-unanswered-question" aria-label="Answer question: Which Landing page task should be High priority?">Unanswered question</button></div>
    <section data-testid="task-chat-composer-takeover"><div data-testid="task-chat-composer-takeover-body">
      <div role="region" aria-label="Question context">Choose <a href="/RUN/issues/RUN-1">Launch Landing page</a> or <a href="/RUN/issues/experiment-task">Experiments Landing page</a> for High priority.</div>
      <p id="question-which-task-prompt">Which Landing page task should be High priority?</p><div data-testid="question-text-answer-composer" aria-labelledby="question-which-task-prompt"></div><button>Submit answers</button>
    </div></section></main>`;
}
