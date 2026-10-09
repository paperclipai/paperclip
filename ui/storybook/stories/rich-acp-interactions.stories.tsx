import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { PaperclipQuestionSet, TranscriptEntry } from "@paperclipai/adapter-utils";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { TaskChatCompactInteractionCard } from "@/components/task-chat/TaskChatCompactInteractionCard";
import { TaskChatProtocolActivityRow } from "@/components/task-chat/TaskChatProtocolActivityRow";
import { TaskChatProtocolCard } from "@/components/task-chat/TaskChatProtocolCard";
import type { TaskChatRuntimeRequestDecision } from "@/components/task-chat/task-chat-model";
import { paperclipRunnerUIAdapter } from "@/adapters/paperclip-runner";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import {
  issueThreadInteractionFixtureMeta,
  pendingAskUserQuestionsInteraction,
  pendingRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  RequestConfirmationInteraction,
} from "@/lib/issue-thread-interactions";
import { storybookAgentMap } from "../fixtures/paperclipData";

// Production components and production projection, with callbacks kept in memory.
// No provider, runner, or control-plane mutation is made by these stories.
function Frame({ children }: { children: ReactNode }) {
  return <div className="paperclip-story"><main className="paperclip-story__inner space-y-6">{children}</main></div>;
}

const questionSet: PaperclipQuestionSet = {
  schema: "paperclip.question_set.v1",
  title: "Deployment details",
  questions: [
    {
      id: "regions", prompt: "Which deployment regions should be enabled?", required: true,
      answerMode: "multi_select",
      options: [
        { id: "provider-region-eu", label: "Production", description: "Europe — Frankfurt" },
        { id: "provider-region-us", label: "Production", description: "United States — Virginia" },
        { id: "provider-region-test", label: "Preview", description: "Temporary test environment" },
      ],
    },
    {
      id: "replicas", prompt: "How many replicas should run?", required: true,
      helpText: "Enter a whole number from 1 to 8.", answerMode: "text",
      textValidation: { inputType: "integer", minimum: 1, maximum: 8 },
    },
    {
      id: "budget", prompt: "What is the hourly budget?", required: true,
      helpText: "Enter a number from 0.5 to 25.", answerMode: "text",
      textValidation: { inputType: "number", minimum: 0.5, maximum: 25 },
    },
    {
      id: "enabled", prompt: "Enable health checks?", required: true, answerMode: "single_select",
      options: [{ id: "true", label: "Yes" }, { id: "false", label: "No" }],
    },
    {
      id: "instructions", prompt: "What should the operator do during rollout?", required: true,
      helpText: "Include both the verification and rollback instructions.", answerMode: "text",
      textValidation: { inputType: "text", minLength: 12, maxLength: 500 },
    },
  ],
};

function Questions() {
  const [interaction, setInteraction] = useState<AskUserQuestionsInteraction>({
    ...pendingAskUserQuestionsInteraction,
    id: "rich-acp-questions", title: questionSet.title!,
    payload: { ...pendingAskUserQuestionsInteraction.payload, questionSet },
  });
  const [receipt, setReceipt] = useState<AskUserQuestionsAnswer[] | "cancelled" | null>(null);
  return <Frame>
    <TaskChatCompactInteractionCard
      interaction={interaction}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      agentMap={storybookAgentMap}
      onSubmitInteractionAnswers={(_, answers) => {
        setReceipt(answers);
        setInteraction(current => ({ ...current, status: "answered", result: { version: 1, answers } }));
      }}
      onCancelInteraction={() => {
        setReceipt("cancelled");
        setInteraction(current => ({ ...current, status: "cancelled", result: { version: 1, answers: [], cancellationReason: "Cancelled by the operator." } }));
      }}
    />
    <output data-testid="question-receipt" className="block whitespace-pre-wrap font-mono text-xs text-muted-foreground">{receipt == null ? "No answer submitted" : JSON.stringify(receipt, null, 2)}</output>
  </Frame>;
}

const planStart = "# Roll out revision 7\n\nVerify each region before enabling traffic. Keep the rollback command available throughout deployment.\n\n## Verification appendix\n\n```text\n";
const planEnd = "\n```\n\n## Final acceptance\n\nPLAN-END-100000: Keep the previous release available until the final health check passes.";
const appendixLine = "Check replica health, verify request counts, confirm recovery metrics, and record the result before continuing.\n";
const appendixLength = 100_000 - planStart.length - planEnd.length;
const planAppendix = appendixLine.repeat(Math.ceil(appendixLength / appendixLine.length)).slice(0, appendixLength);
const fullPlan = planStart + planAppendix + planEnd;
const revisionId = "77777777-7777-4777-8777-777777777777";

// Cursor normalizeCursorPlanRequest({ toolCallId, plan: fullPlan, todos: [] }).
// This is the native runtime-question path, distinct from a synchronized plan document.
const cursorPlanRevision = "eedc589b367de4f6366ff76090d93676adb1e2238d4c5af280ac88393e1adef3";
const cursorPlanQuestionId = `plan-${cursorPlanRevision}`;
const cursorPlanQuestions: PaperclipQuestionSet = {
  schema: "paperclip.question_set.v1", title: "Review Cursor's plan", description: fullPlan, submitLabel: "Send decision",
  questions: [
    { id: cursorPlanQuestionId, prompt: "How should Cursor proceed with this plan?", required: true, answerMode: "single_select", options: [
      { id: "accept", label: "Accept plan" }, { id: "reject", label: "Reject plan" }, { id: "cancel", label: "Cancel plan request" },
    ] },
    { id: "reason", prompt: "Reason for rejecting the plan (optional)", required: false, answerMode: "text", textValidation: { maxLength: 4_000 } },
  ],
};

function NativeCursorPlan() {
  const [receipt, setReceipt] = useState<{ requestId: string; decision: TaskChatRuntimeRequestDecision } | null>(null);
  const entries = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
    type: "paperclip.prp.event", event: { eventType: "runtime_request.created", turnId: "cursor-plan-turn", payload: {
      request: { requestId: "cursor-create-plan-revision-7", requestKind: "runtime", type: "input", status: "pending", prompt: "Review Cursor's plan", input: cursorPlanQuestions },
    } },
  }), "2026-09-28T12:00:00.000Z");
  const items = transcriptToTaskChatItems(entries, { runId: "cursor-native-plan", running: true });
  return <Frame>
    <p className="text-xs text-muted-foreground" data-testid="plan-source-length">Complete source: {fullPlan.length} characters</p>
    <div data-testid="native-plan-review">{items.map(item => item.kind === "protocol" && item.surface === "runtime_request"
      ? <TaskChatProtocolCard key={item.id} item={receipt ? {
        ...item, status: receipt.decision.action === "cancel" ? "cancelled" : "resolved",
        resolvedAction: receipt.decision.action,
        response: "response" in receipt.decision ? receipt.decision.response : null,
      } : item} onRuntimeRequestDecision={(current, decision) => setReceipt({ requestId: current.requestId, decision })} /> : null)}</div>
    <output data-testid="native-plan-receipt" className="block whitespace-pre-wrap font-mono text-xs text-muted-foreground">{receipt == null ? "No decision submitted" : JSON.stringify(receipt, null, 2)}</output>
  </Frame>;
}

function PlanReview() {
  const [interaction, setInteraction] = useState<RequestConfirmationInteraction>({
    ...pendingRequestConfirmationInteraction,
    id: "rich-acp-plan-r7", title: "Review deployment plan revision 7",
    summary: "Review the complete plan before approving this revision.",
    payload: {
      ...pendingRequestConfirmationInteraction.payload,
      detailsMarkdown: fullPlan,
      target: { type: "issue_document", issueId: issueThreadInteractionFixtureMeta.issueId, key: "plan", revisionId, revisionNumber: 7 },
    },
  });
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  function resolve(current: RequestConfirmationInteraction, outcome: "accepted" | "rejected", reason?: string) {
    setReceipt({ interactionId: current.id, target: current.payload.target, outcome, ...(reason ? { reason } : {}) });
    setInteraction({ ...current, status: outcome, result: { version: 1, outcome, reason: reason ?? null } });
  }
  return <Frame>
    <p className="text-xs text-muted-foreground" data-testid="plan-source-length">Complete source: {fullPlan.length} characters</p>
    <div data-testid="full-plan-review">
      <IssueThreadInteractionCard interaction={interaction} agentMap={storybookAgentMap}
        currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        onAcceptInteraction={current => resolve(current as RequestConfirmationInteraction, "accepted")}
        onRejectInteraction={(current, reason) => resolve(current as RequestConfirmationInteraction, "rejected", reason)} />
    </div>
    <output data-testid="plan-receipt" className="block whitespace-pre-wrap font-mono text-xs text-muted-foreground">{receipt == null ? "Pending revision 7" : JSON.stringify(receipt, null, 2)}</output>
  </Frame>;
}

const notice: TranscriptEntry = {
  kind: "provider_activity", ts: "2026-09-28T12:00:00.000Z", family: "provider_notice",
  eventType: "provider.notice.recorded", title: "Provider notice", status: "informational",
  summary: "The provider is retrying after a temporary capacity limit.",
  payload: {
    schema: "paperclip.provider.notice.v1", severity: "warning", category: "retry", scope: "turn",
    recoverable: true, userActionable: false, summary: "The provider is retrying after a temporary capacity limit.",
    details: [
      { name: "Provider", value: "pi / ACP" },
      { name: "Source event", value: "auto_retry_start" },
      { name: "Provenance", value: "Provider-reported; not a runner-verified result" },
      { name: "Retry attempt", value: "2 of 3" },
      { name: "Message", value: "Capacity is temporarily unavailable.\nRetry after 2 seconds.\nDETAIL-END" },
    ],
  },
};

function ProviderNotice() {
  const items = transcriptToTaskChatItems([notice], { runId: "rich-acp-notice", running: false });
  return <Frame>{items.map(item => item.kind === "protocol" && item.surface === "provider_activity"
    ? <TaskChatProtocolActivityRow key={item.id} item={item} /> : null)}</Frame>;
}

const meta = {
  title: "Chat & Comments/Rich ACP interactions",
  parameters: { layout: "fullscreen", docs: { description: { component: "Credential-free production UI fixtures. Callback receipts establish UI payload fidelity only; they do not claim provider execution or server persistence." } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const QuestionsPending: Story = { render: () => <Questions /> };
export const TypedQuestionsVerified: Story = {
  ...QuestionsPending,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", { name: /Europe/ }));
    await userEvent.click(canvas.getByRole("checkbox", { name: /United States/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    let input = within(await canvas.findByRole("group", { name: "How many replicas should run?" })).getByRole("textbox");
    await userEvent.type(input, "2.5");
    await expect(canvas.getByText("Enter a valid integer.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "9");
    await expect(canvas.getByText("Enter a value no greater than 8.")).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    input = within(await canvas.findByRole("group", { name: "What is the hourly budget?" })).getByRole("textbox");
    await userEvent.type(input, "0.25");
    await expect(canvas.getByText("Enter a value of at least 0.5.")).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, "2.75");
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await userEvent.click(canvas.getByRole("radio", { name: "Yes" }));
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    input = within(await canvas.findByRole("group", { name: "What should the operator do during rollout?" })).getByRole("textbox");
    await userEvent.type(input, "Verify health checks.{shift>}{enter}{/shift}Roll back if latency increases.");
    await userEvent.click(canvas.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(JSON.parse(canvas.getByTestId("question-receipt").textContent!)).toEqual([
      { questionId: "regions", optionIds: ["provider-region-eu", "provider-region-us"] },
      { questionId: "replicas", optionIds: [], otherText: "3" },
      { questionId: "budget", optionIds: [], otherText: "2.75" },
      { questionId: "enabled", optionIds: ["true"] },
      { questionId: "instructions", optionIds: [], otherText: "Verify health checks.\nRoll back if latency increases." },
    ]));
  },
};

export const QuestionCancellationVerified: Story = {
  ...QuestionsPending,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(canvas.getByTestId("question-receipt")).toHaveTextContent('"cancelled"');
    await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
  },
};

export const CompletePlanPending: Story = { name: "Semantic plan document pending", render: () => <PlanReview /> };
async function assertCompletePlan(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByTestId("plan-source-length")).toHaveTextContent("100000 characters");
  const appendix = canvas.getByTestId("full-plan-review").querySelector("pre code");
  await expect(appendix).not.toBeNull();
  await expect(appendix!.textContent).toBe(planAppendix + "\n");
  // Markdown may link the task-like sentinel; inspect its complete paragraph.
  await expect(canvas.getByText((_, element) => element?.tagName === "P" && element.textContent?.includes("PLAN-END-100000:") === true)).toBeVisible();
}
export const CompletePlanAcceptedVerified: Story = {
  ...CompletePlanPending,
  name: "Semantic plan document accepted verified",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await assertCompletePlan(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(JSON.parse(canvas.getByTestId("plan-receipt").textContent!)).toMatchObject({
      interactionId: "rich-acp-plan-r7", outcome: "accepted", target: { key: "plan", revisionId, revisionNumber: 7 },
    }));
  },
};
export const PlanRevisionCancelledThenRejectedVerified: Story = {
  ...CompletePlanPending,
  name: "Semantic plan revision cancelled then rejected verified",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await assertCompletePlan(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Revise…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send revision" }));
    await expect(canvas.getByText("Add a note describing the changes you want.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(canvas.getByTestId("plan-receipt")).toHaveTextContent("Pending revision 7");
    await userEvent.click(canvas.getByRole("button", { name: "Revise…" }));
    await userEvent.type(canvas.getByRole("textbox"), "Add a rollback verification in each region.");
    await userEvent.click(canvas.getByRole("button", { name: "Send revision" }));
    await waitFor(() => expect(JSON.parse(canvas.getByTestId("plan-receipt").textContent!)).toMatchObject({
      outcome: "rejected", reason: "Add a rollback verification in each region.", target: { key: "plan", revisionId, revisionNumber: 7 },
    }));
  },
};

export const NoticeDetails: Story = { render: () => <ProviderNotice /> };
export const NoticeDetailsVerified: Story = {
  ...NoticeDetails,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("The provider is retrying after a temporary capacity limit.")).toBeVisible();
    await userEvent.click(canvas.getByText("Details", { exact: true }));
    await expect(canvas.getByText("pi / ACP")).toBeVisible();
    await expect(canvas.getByText("auto_retry_start")).toBeVisible();
    await expect(canvas.getByText("Provider-reported; not a runner-verified result")).toBeVisible();
    await expect(canvas.getByText(/DETAIL-END/)).toBeVisible();
  },
};

export const NativeCursorPlanPending: Story = { render: () => <NativeCursorPlan /> };

function nativePlanVerification(choice: "accept" | "reject" | "cancel"): Story["play"] {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const context = canvas.getByRole("region", { name: "Question context" });
    await expect(context.querySelector("pre code")?.textContent).toBe(planAppendix + "\n");
    await expect(context.textContent).toContain("PLAN-END-100000:");
    const label = { accept: "Accept plan", reject: "Reject plan", cancel: "Cancel plan request" }[choice];
    await userEvent.click(canvas.getByRole("radio", { name: label }));
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    if (choice === "reject") await userEvent.type(canvas.getByRole("textbox"), "Add per-region rollback checks.");
    await userEvent.click(canvas.getByRole("button", { name: "Send decision" }));
    await waitFor(() => expect(JSON.parse(canvas.getByTestId("native-plan-receipt").textContent!)).toMatchObject({
      requestId: "cursor-create-plan-revision-7", decision: {
        action: "submit", response: { schema: "paperclip.question_response.v1", answers: {
          [cursorPlanQuestionId]: { selectedOptionIds: [choice] },
          ...(choice === "reject" ? { reason: { text: "Add per-region rollback checks." } } : {}),
        } },
      },
    }));
  };
}

export const NativeCursorPlanAcceptedVerified: Story = { ...NativeCursorPlanPending, play: nativePlanVerification("accept") };
export const NativeCursorPlanRejectedVerified: Story = { ...NativeCursorPlanPending, play: nativePlanVerification("reject") };
export const NativeCursorPlanCancelledVerified: Story = { ...NativeCursorPlanPending, play: nativePlanVerification("cancel") };
