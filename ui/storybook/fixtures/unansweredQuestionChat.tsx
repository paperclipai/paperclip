import { useState } from "react";
import type { AskUserQuestionsInteraction, IssueComment, IssueThreadInteraction } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { TaskChatThread } from "@/components/TaskChatThread";
import { pendingAskUserQuestionsInteraction, genericPendingRequestConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "./paperclipData";

export const question: AskUserQuestionsInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "unanswered-color", title: "Welcome note preference", sourceRunId: "original-run",
  createdAt: new Date("2026-04-01T12:01:00Z"),
  payload: { version: 1, runtimeRequestId: "color-request", questions: [{ id: "color", prompt: "Which color should the welcome note use?",
    selectionMode: "single", required: true, options: [{ id: "blue", label: "Blue" }, { id: "green", label: "Green" }] }] },
};
const otherQuestion: AskUserQuestionsInteraction = {
  ...question, id: "unanswered-tone", sourceRunId: "second-run", title: "Welcome note tone",
  createdAt: new Date("2026-04-01T12:03:00Z"),
  payload: { version: 1, questions: [{ id: "tone", prompt: "Which tone should the welcome note use?",
    selectionMode: "single", required: true, options: [{ id: "friendly", label: "Friendly" }, { id: "formal", label: "Formal" }] }] },
};
function comment(id: string, body: string, at: string, agent = false): IssueComment {
  return { id, companyId: question.companyId, issueId: question.issueId, body, authorType: agent ? "agent" : "user",
    authorAgentId: agent ? question.createdByAgentId ?? null : null, authorUserId: agent ? null : "user-board",
    presentation: null, metadata: null, createdAt: new Date(at), updatedAt: new Date(at) };
}
export function QuestionChat({ movedOn = false, multiple = false, answered = false, conversationMode = true, review = false }: { review?: boolean; movedOn?: boolean; multiple?: boolean; answered?: boolean; conversationMode?: boolean }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    // This conversation has no plan. Keep the real thread's plan query local
    // to the fixture rather than requesting an API from the static publisher.
    client.setQueryData([...queryKeys.issues.documents(conversationMode ? question.issueId : "task-unanswered-questions-demo"), "plan"], null);
    return client;
  });
  const [interactions, setInteractions] = useState<IssueThreadInteraction[]>([
    ...(review ? [{ ...genericPendingRequestConfirmationInteraction, id: "completion-review", title: "Review requested", summary: "Provide app configuration to finish integration.", payload: { version: 1 as const, prompt: "Provide app configuration to finish integration.", acceptLabel: "Approve completion", rejectLabel: "Continue work", target: { type: "custom" as const, key: "native_completion_review", label: "Completion decision" } } }] : []),
    ...(review ? [] : [answered ? { ...question, status: "answered" as const, resolvedAt: new Date("2026-04-01T12:06:00Z"), result: { version: 1 as const, answers: [{ questionId: "color", optionIds: ["blue"] }] } } : question]),
    ...(multiple ? [otherQuestion] : []),
  ]);
  const [comments, setComments] = useState<IssueComment[]>([
    comment("start", review ? "Finish the app integration and verify it." : "Help me plan a welcome note for our garden club.", "2026-04-01T12:00:00Z"),
    ...(movedOn || multiple || answered ? [
      comment("move-on", "Let's leave those choices for later. What can Paperclip tasks track?", "2026-04-01T12:04:00Z"),
      comment("reply", "Tasks track ownership, progress, and the work needed to reach a goal.", "2026-04-01T12:05:00Z", true),
    ] : []),
    ...(answered ? [comment("late-answer", "Blue it is. I'll use that preference when we return to the welcome note.", "2026-04-01T12:07:00Z", true)] : []),
  ]);
  return <QueryClientProvider client={queryClient}><div className="flex h-screen flex-col bg-background text-foreground">
    <TaskChatThread conversationMode={conversationMode} comments={comments} interactions={interactions} issueId={conversationMode ? question.issueId : "task-unanswered-questions-demo"}
      issueStatus="in_review" currentUserId="user-board" agentMap={storybookAgentMap} enableLiveTranscriptPolling={false}
      threadHeader={<div className="p-4"><h1 className="text-xl font-semibold">{review ? "Finish the app integration" : conversationMode ? "Garden club chat" : "Draft the garden club welcome note"}</h1><p className="text-sm text-muted-foreground">Requests can wait. Open a request in history whenever you're ready.</p></div>}
      onAdd={async body => {
        setComments(rows => [...rows, comment(`user-${rows.length}`, body, new Date().toISOString()),
          comment(`agent-${rows.length}`, "We can come back to that question later. What would you like to work on next?", new Date(Date.now() + 1).toISOString(), true)]);
      }}
      onDismissInteraction={async interaction => {
        setInteractions(rows => rows.map(row => row.id === interaction.id ? { ...row, dismissedAt: new Date(), dismissedByUserId: "user-board" } : row));
      }}
      onAcceptInteraction={async interaction => {
        setInteractions(rows => rows.map(row => row.id === interaction.id && row.kind === "request_confirmation" ? { ...row, status: "accepted", resolvedAt: new Date(), result: { version: 1, outcome: "accepted" } } : row));
      }}
      onRejectInteraction={async interaction => {
        setInteractions(rows => rows.map(row => row.id === interaction.id && row.kind === "request_confirmation" ? { ...row, status: "rejected", resolvedAt: new Date(), result: { version: 1, outcome: "rejected" } } : row));
      }}
      onSubmitInteractionAnswers={async (interaction, answers) => {
        setInteractions(rows => rows.map(row => row.id === interaction.id && row.kind === "ask_user_questions" ? { ...row, status: "answered", resolvedAt: new Date(), result: { version: 1, answers } } : row));
        setComments(rows => [...rows, comment(`answer-${rows.length}`, "Thanks, I've received your answer to the earlier question.", new Date().toISOString(), true)]);
      }}
    />
  </div></QueryClientProvider>;
}
