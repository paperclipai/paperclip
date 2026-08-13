import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, IssueComment } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "@/api/heartbeats";
import { AssistantChatView } from "@/components/AssistantChat";
import type { IssueChatComment, IssueChatTranscriptEntry } from "@/lib/issue-chat-messages";
import { pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgents } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const projectId = "project-board-ui";
const issueId = "issue-selected-agent-chat";
const currentUserId = "user-board";

/** Conference-room CEO target — the real selected agent (no concierge persona). */
const ceoAgent: Agent = {
  ...storybookAgents[0]!,
  id: "agent-ceo",
  name: "Sarah Okafor",
  urlKey: "sarah-okafor",
  role: "ceo",
  title: "Chief Executive",
  icon: "rocket",
  status: "active",
};

const chatAgents: Agent[] = [ceoAgent, ...storybookAgents];

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const createdAt = overrides.createdAt ?? new Date("2026-06-14T15:00:00.000Z");
  const authorAgentId = overrides.authorAgentId ?? null;
  return {
    id: "comment-default",
    companyId,
    issueId,
    authorAgentId: null,
    authorUserId: authorAgentId ? null : currentUserId,
    body: "",
    authorType: authorAgentId ? "agent" : "user",
    presentation: null,
    metadata: null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  } as IssueChatComment;
}

const conversationComments: IssueChatComment[] = [
  createComment({
    id: "c-user-1",
    body: "How is the MCP connector work going? Anything I should worry about?",
    createdAt: new Date("2026-06-14T15:00:00.000Z"),
  }),
  createComment({
    id: "c-ceo-1",
    authorAgentId: ceoAgent.id,
    body:
      "**Report.** The MCP connector work is on track. Two of three connectors are live and " +
      "verified; the third (Sheets) is waiting on a Google API key.\n\n" +
      "**What I checked**\n" +
      "- The connector health dashboard (all green except Sheets)\n" +
      "- The open issues under the integrations project\n\n" +
      "**Recommendation.** Unblock the Sheets connector by providing the API key, or I can have " +
      "the team ship the first two now and follow with Sheets.",
    createdAt: new Date("2026-06-14T15:01:30.000Z"),
  }),
];

const runningActiveRun: ActiveRunForIssue = {
  id: "run-ceo-active",
  status: "running",
  invocationSource: "automation",
  triggerDetail: "system",
  startedAt: "2026-06-14T15:05:00.000Z",
  finishedAt: null,
  createdAt: "2026-06-14T15:05:00.000Z",
  agentId: ceoAgent.id,
  agentName: ceoAgent.name,
  adapterType: "claude_code",
  issueId,
};

const runningLiveRun: LiveRunForIssue = {
  id: runningActiveRun.id,
  status: "running",
  invocationSource: "automation",
  triggerDetail: "system",
  startedAt: "2026-06-14T15:05:00.000Z",
  finishedAt: null,
  createdAt: "2026-06-14T15:05:00.000Z",
  agentId: ceoAgent.id,
  agentName: ceoAgent.name,
  adapterType: "claude_code",
  issueId,
};

const runningTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>([
  [
    runningActiveRun.id,
    [
      {
        kind: "thinking",
        ts: "2026-06-14T15:05:03.000Z",
        text: "Checking recent connector status, open task blockers, and whether the Sheets API key is still the gating item.",
      },
      {
        kind: "tool_call",
        ts: "2026-06-14T15:05:07.000Z",
        name: "search_issues",
        toolUseId: "tool-ceo-active-1",
        input: { q: "MCP connector Sheets blocked" },
      },
      {
        kind: "tool_result",
        ts: "2026-06-14T15:05:09.000Z",
        toolUseId: "tool-ceo-active-1",
        content: "Found two connector tasks complete and one Sheets task blocked on missing Google API credentials.",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-06-14T15:05:12.000Z",
        text: "I am checking the team status now and will summarize the blocker and recommended next step.",
      },
    ],
  ],
]);

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story__frame mx-auto flex h-[640px] w-full max-w-3xl flex-col overflow-hidden">
      {children}
    </div>
  );
}

/** Stateful wrapper so the agent switcher is interactive in the canvas. */
function ChatHarness(
  props: Omit<React.ComponentProps<typeof AssistantChatView>, "targetAgentId" | "onTargetAgentChange">,
) {
  const [targetAgentId, setTargetAgentId] = useState<string>(ceoAgent.id);
  return (
    <Frame>
      <AssistantChatView
        {...props}
        targetAgentId={targetAgentId}
        onTargetAgentChange={setTargetAgentId}
      />
    </Frame>
  );
}

const baseProps = {
  agents: chatAgents,
  companyId,
  projectId,
  issueId,
  currentUserId,
  onSend: async () => {},
} satisfies Partial<React.ComponentProps<typeof AssistantChatView>>;

const meta: Meta<typeof AssistantChatView> = {
  title: "Chat & Comments/Assistant Chat",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof AssistantChatView>;

/** Empty / idle — composer ready, default CEO target, switcher available. */
export const EmptyIdle: Story = {
  render: () => <ChatHarness {...baseProps} comments={[]} />,
};

/** Loading — first comments fetch in flight. */
export const Loading: Story = {
  render: () => <ChatHarness {...baseProps} comments={[]} loading />,
};

/** Durable history — user message + a finished real-agent report. */
export const History: Story = {
  render: () => <ChatHarness {...baseProps} comments={conversationComments} />,
};

/** Active run — the CEO is working; live-run row + "view live run" surface. */
export const ActiveRun: Story = {
  render: () => (
    <ChatHarness
      {...baseProps}
      comments={[conversationComments[0]!]}
      activeRun={runningActiveRun}
      liveRuns={[runningLiveRun]}
      transcriptsByRunId={runningTranscriptsByRunId}
    />
  ),
};

/** Status report + next-step options rendered as a real suggest_tasks card. */
export const StatusReportWithOptions: Story = {
  render: () => (
    <ChatHarness
      {...baseProps}
      comments={conversationComments}
      interactions={[pendingSuggestedTasksInteraction]}
    />
  ),
};

/** Error — delivery failed; message preserved as draft with Try again (CR8). */
export const DeliveryError: Story = {
  render: () => (
    <ChatHarness
      {...baseProps}
      comments={conversationComments}
      errorText="The message couldn't be delivered to Sarah Okafor (network error)."
      onRetry={() => {}}
    />
  ),
};
