import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AskUserQuestionsInteraction, IssueAttachment, IssueComment } from "@paperclipai/shared";
import { TaskChatThread } from "@/components/TaskChatThread";
import { DocumentCard } from "@/components/artifacts/RichArtifactCards";
import { Button } from "@/components/ui/button";
import { pendingAskUserQuestionsInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "../../../fixtures/paperclipData";

const companyId = "company-storybook";
const taskId = "grok-comparison-task";
const proactiveTaskId = "grok-investigation-task";
const agent: Agent = { ...storybookAgents[0]!, id: "agent-night-shift", name: "Night Shift", urlKey: "night-shift",
  role: "researcher", adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot", allowUnmeteredProvider: true } };
const agentMap = new Map([[agent.id, agent]]);
const stages = ["First assignment", "Question and answer", "Result and review", "Proactive work", "Broken connection", "Recovery"];
const question: AskUserQuestionsInteraction = { ...pendingAskUserQuestionsInteraction, id: "grok-comparison-scope", issueId: taskId,
  sourceRunId: "grok-comparison-run", createdByAgentId: agent.id, title: "Comparison scope", summary: "Choose the audience for the comparison.",
  createdAt: new Date("2026-10-13T12:02:00Z"), updatedAt: new Date("2026-10-13T12:02:00Z"),
  payload: { version: 1, runtimeRequestId: "grok-scope-question", questions: [{ id: "audience", prompt: "Which audience should I compare competitors for?",
    required: true, selectionMode: "single", options: [{ id: "small-teams", label: "Small teams" }, { id: "enterprise", label: "Enterprise" }] }] } };
const file: IssueAttachment = { id: "grok-comparison-file", companyId, issueId: taskId, issueCommentId: null, originatingRunId: "grok-comparison-run",
  assetId: "grok-comparison-asset", provider: "local", objectKey: "synthetic-comparison.csv", contentType: "text/csv", byteSize: 144,
  sha256: "6d95ec3d56a080c952b111fe9daed945e584bf094354e84885968f4816a68612", originalFilename: "competitor-comparison.csv", createdByAgentId: agent.id, createdByUserId: null,
  createdAt: new Date("2026-10-13T12:04:00Z"), updatedAt: new Date("2026-10-13T12:04:00Z"), contentPath: "/storybook/grok-comparison.csv" };
const report = "## Comparison for small teams\n\nThese are fictional companies for the guided fixture.\n\n| Competitor | Strength | Limitation |\n| --- | --- | --- |\n| Acorn | Simple setup | Fewer controls |\n| Birch | Flexible workflows | More setup |\n| Cedar | Detailed reporting | Higher complexity |\n\nAcorn best fits the setup requirement. The CSV contains the same three observations.";
function comment(id: string, body: string, minute: number, issueId = taskId, human = false): IssueComment {
  const at = new Date(`2026-10-13T12:${String(minute).padStart(2, "0")}:00Z`);
  return { id, companyId, issueId, authorType: human ? "user" : "agent", authorAgentId: human ? null : agent.id,
    authorUserId: human ? "user-board" : null, body, presentation: null, metadata: null, createdAt: at, updatedAt: at };
}

/** Local fixture state only. No provider, authority, persistence or recovery proof. */
export function GrokWorkJourney() {
  const [stage, setStage] = useState(0);
  const [answered, setAnswered] = useState<AskUserQuestionsInteraction | null>(null);
  const [proactive, setProactive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    for (const id of [taskId, proactiveTaskId]) cache.setQueryData([...queryKeys.issues.documents(id), "plan"], null);
    return cache;
  });
  const comments = stage === 3 ? proactive ? [comment("proactive", "I created this task from our Grok conversation and accepted its Paperclip work session. I am checking the three observations for follow-up questions.", 6, proactiveTaskId)] : [] : [
    comment("request", "Research three competitors and write a comparison.", 0, taskId, true),
    comment("progress", "I accepted the assignment and retrieved its current context. I have three candidates and need to confirm the audience.", 1),
    ...(answered ? [comment("answer-received", "Your answer resumed the same task. I am writing the comparison and CSV now.", 3)] : []),
    ...(stage >= 2 ? [comment("completion", "The comparison document and CSV are ready for review. I submitted the completion result to Paperclip.", 5)] : []),
  ];
  return <QueryClientProvider client={client}><main className="space-y-4 p-6">
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Night Shift in Paperclip</h1><p className="text-sm text-muted-foreground">Runs in Grok Bot · Usage not reported</p></div>
      <Button disabled={stage === stages.length - 1 || stage === 1 && !answered} onClick={() => setStage(stage + 1)}>Next</Button></div>
    <p className="text-xs text-muted-foreground">Guided fixture: task state, provider replies, admission and recovery are simulated. No Grok routine or Paperclip API is called.</p>
    <h2 className="text-lg font-medium">{stages[stage]}</h2>
    {stage <= 3 ? <>
      {stage === 0 && <p role="status" className="text-sm text-muted-foreground">Assignment delivered · Night Shift acknowledged · Working</p>}
      {stage === 1 && <p role="status" className="text-sm text-muted-foreground">{answered ? "Answer received · Continuation delivered" : "Waiting for your answer"}</p>}
      {stage === 2 && <p role="status" className="text-sm text-muted-foreground">Reported completion · Awaiting normal review</p>}
      {stage === 3 && <div className="space-y-2"><p className="text-sm">In Grok, ask: “Track this investigation in Paperclip.” The existing request admits one task without sending the same initial assignment back.</p><Button disabled={proactive} onClick={() => setProactive(true)}>{proactive ? "One task admitted" : "Simulate Bot-initiated work"}</Button></div>}
      <div className="flex h-screen flex-col rounded-lg border bg-background text-foreground">
        <TaskChatThread key={stage === 3 ? proactiveTaskId : taskId} conversationMode={false} comments={comments}
          interactions={stage >= 1 && stage <= 2 ? [answered ?? question] : []} attachments={stage === 2 ? [file] : []}
          issueId={stage === 3 ? proactiveTaskId : taskId} issueStatus={stage === 2 ? "in_review" : "in_progress"}
          issueAssigneeAgentId={agent.id} currentUserId="user-board" agentMap={agentMap} enableLiveTranscriptPolling={false} showComposer={stage === 1}
          threadHeader={<div className="p-4"><h3 className="text-lg font-semibold">{stage === 3 ? "Track the competitor investigation" : "Research three competitors and write a comparison"}</h3></div>}
          onAdd={async () => {}} onSubmitInteractionAnswers={async (interaction, answers) => {
            setAnswered({ ...interaction, status: "answered", resolvedAt: new Date("2026-10-13T12:03:00Z"), result: { version: 1, answers } } as AskUserQuestionsInteraction);
          }} />
      </div>
      {stage === 2 && <DocumentCard title="Competitor comparison" author="Night Shift" updatedAt="Oct 13, 2026" filename="competitor-comparison.md" revision={1} summary="" body={report} />}
    </> : <section className="space-y-3 rounded-lg border p-4">
      <p role="alert" className="text-sm">{recovered ? "Fresh exchange verified. Ready for the next task." : "Recovery needed. Delivery is uncertain; Paperclip will not resend it automatically."}</p>
      <p className="text-sm text-muted-foreground">{stopped ? "Paperclip work-session authority revoked. Remote Grok execution remains unknown." : "Open the Grok Bot desktop app to inspect Night Shift’s activity."}</p>
      {!stopped && <Button onClick={() => setStopped(true)}>Stop Paperclip work</Button>}
      {stage === 5 && stopped && !recovered && <Button onClick={() => setRecovered(true)}>Simulate inspection and fresh verification</Button>}
    </section>}
  </main></QueryClientProvider>;
}
