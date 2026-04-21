import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent, FeedbackVote, IssueComment } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { CommentThread } from "@/components/CommentThread";
import { IssueChatThread } from "@/components/IssueChatThread";
import { RunChatSurface } from "@/components/RunChatSurface";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import type { MentionOption } from "@/components/MarkdownEditor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "@/lib/issue-chat-messages";
import type { IssueTimelineEvent } from "@/lib/issue-timeline-events";
import { storybookAgentMap, storybookAgents } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const projectId = "project-board-ui";
const issueId = "issue-chat-comments";
const currentUserId = "user-board";

type StoryComment = IssueComment & {
  runId?: string | null;
  runAgentId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
};

const codexAgent = storybookAgents.find((agent) => agent.id === "agent-codex") ?? storybookAgents[0]!;
const qaAgent = storybookAgents.find((agent) => agent.id === "agent-qa") ?? storybookAgents[1]!;
const ctoAgent = storybookAgents.find((agent) => agent.id === "agent-cto") ?? storybookAgents[2]!;

const boardUserLabels = new Map<string, string>([
  ["user-board", "Riley Board"],
  ["user-product", "Mara Product"],
]);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="paperclip-story__label">{eyebrow}</div>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function ScenarioCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function createComment(overrides: Partial<StoryComment>): StoryComment {
  const createdAt = overrides.createdAt ?? new Date("2026-04-20T14:00:00.000Z");
  return {
    id: "comment-default",
    companyId,
    issueId,
    authorAgentId: null,
    authorUserId: currentUserId,
    body: "",
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

function createSystemEvent(overrides: Partial<IssueTimelineEvent>): IssueTimelineEvent {
  return {
    id: "event-default",
    createdAt: new Date("2026-04-20T14:00:00.000Z"),
    actorType: "system",
    actorId: "paperclip",
    statusChange: {
      from: "todo",
      to: "in_progress",
    },
    ...overrides,
  };
}

const mentionOptions: MentionOption[] = [
  {
    id: `agent:${codexAgent.id}`,
    name: codexAgent.name,
    kind: "agent",
    agentId: codexAgent.id,
    agentIcon: codexAgent.icon,
  },
  {
    id: `agent:${qaAgent.id}`,
    name: qaAgent.name,
    kind: "agent",
    agentId: qaAgent.id,
    agentIcon: qaAgent.icon,
  },
  {
    id: `project:${projectId}`,
    name: "Board UI",
    kind: "project",
    projectId,
    projectColor: "#0f766e",
  },
];

const reassignOptions: InlineEntityOption[] = [
  {
    id: `agent:${codexAgent.id}`,
    label: codexAgent.name,
    searchText: `${codexAgent.name} engineer codex`,
  },
  {
    id: `agent:${qaAgent.id}`,
    label: qaAgent.name,
    searchText: `${qaAgent.name} qa browser review`,
  },
  {
    id: `agent:${ctoAgent.id}`,
    label: ctoAgent.name,
    searchText: `${ctoAgent.name} architecture review`,
  },
  {
    id: `user:${currentUserId}`,
    label: "Riley Board",
    searchText: "board operator",
  },
];

const singleComment = [
  createComment({
    id: "comment-single-board",
    body: "Please make the issue chat states reviewable in Storybook before the next UI pass.",
    createdAt: new Date("2026-04-20T13:12:00.000Z"),
  }),
];

const longThreadComments = [
  createComment({
    id: "comment-long-board",
    body: "The chat surface should show the operator request first, then agent progress, then review follow-up. Keep the density close to the issue page.",
    createdAt: new Date("2026-04-20T13:02:00.000Z"),
  }),
  createComment({
    id: "comment-long-agent",
    authorAgentId: codexAgent.id,
    authorUserId: null,
    body: "I found the existing `IssueChatThread` and `RunChatSurface` components and am building the stories around those props.",
    createdAt: new Date("2026-04-20T13:08:00.000Z"),
    runId: "run-comment-thread-01",
    runAgentId: codexAgent.id,
  }),
  createComment({
    id: "comment-long-product",
    authorUserId: "user-product",
    body: "Also include the old comment timeline so we can compare it with the assistant-style issue chat.",
    createdAt: new Date("2026-04-20T13:16:00.000Z"),
  }),
  createComment({
    id: "comment-long-qa",
    authorAgentId: qaAgent.id,
    authorUserId: null,
    body: "QA note: the thread should stay readable with long markdown and when a queued operator reply is visible.",
    createdAt: new Date("2026-04-20T13:24:00.000Z"),
    runId: "run-comment-thread-02",
    runAgentId: qaAgent.id,
  }),
];

const markdownComments = [
  createComment({
    id: "comment-markdown-board",
    body: [
      "Acceptance criteria:",
      "",
      "- Cover empty, single, and long comment states",
      "- Show a code block in a comment",
      "- Include a link to [the issue guide](/issues/PAP-1676)",
      "",
      "```ts",
      "const success = stories.some((story) => story.includes(\"IssueChatThread\"));",
      "```",
    ].join("\n"),
    createdAt: new Date("2026-04-20T13:28:00.000Z"),
  }),
  createComment({
    id: "comment-mentions-agent",
    authorAgentId: codexAgent.id,
    authorUserId: null,
    body: "@QAChecker I added the fixture coverage. Please focus browser review on links, code blocks, and the queued comment treatment.",
    createdAt: new Date("2026-04-20T13:35:00.000Z"),
    runId: "run-markdown-01",
    runAgentId: codexAgent.id,
  }),
];

const queuedComment = createComment({
  id: "comment-queued-board",
  body: "@CodexCoder after this run finishes, add a compact embedded variant too.",
  createdAt: new Date("2026-04-20T13:39:00.000Z"),
  clientId: "client-queued-storybook",
  clientStatus: "queued",
  queueState: "queued",
  queueTargetRunId: "run-live-chat-01",
});

const commentTimelineEvents: IssueTimelineEvent[] = [
  createSystemEvent({
    id: "event-system-checkout",
    createdAt: new Date("2026-04-20T13:04:00.000Z"),
    actorType: "system",
    actorId: "paperclip",
    statusChange: {
      from: "todo",
      to: "in_progress",
    },
  }),
  createSystemEvent({
    id: "event-board-reassign",
    createdAt: new Date("2026-04-20T13:18:00.000Z"),
    actorType: "user",
    actorId: currentUserId,
    assigneeChange: {
      from: { agentId: codexAgent.id, userId: null },
      to: { agentId: qaAgent.id, userId: null },
    },
    statusChange: undefined,
  }),
];

const commentLinkedRuns = [
  {
    runId: "run-comment-thread-01",
    status: "succeeded",
    agentId: codexAgent.id,
    createdAt: new Date("2026-04-20T13:07:00.000Z"),
    startedAt: new Date("2026-04-20T13:07:00.000Z"),
    finishedAt: new Date("2026-04-20T13:11:00.000Z"),
  },
  {
    runId: "run-comment-thread-02",
    status: "running",
    agentId: qaAgent.id,
    createdAt: new Date("2026-04-20T13:22:00.000Z"),
    startedAt: new Date("2026-04-20T13:22:00.000Z"),
    finishedAt: null,
  },
];

const feedbackVotes: FeedbackVote[] = [
  {
    id: "feedback-chat-comment-01",
    companyId,
    issueId,
    targetType: "issue_comment",
    targetId: "comment-issue-agent",
    authorUserId: currentUserId,
    vote: "up",
    reason: null,
    sharedWithLabs: false,
    sharedAt: null,
    consentVersion: null,
    redactionSummary: null,
    createdAt: new Date("2026-04-20T13:52:00.000Z"),
    updatedAt: new Date("2026-04-20T13:52:00.000Z"),
  },
];

const liveRun: LiveRunForIssue = {
  id: "run-live-chat-01",
  status: "running",
  invocationSource: "manual",
  triggerDetail: "comment",
  createdAt: "2026-04-20T13:40:00.000Z",
  startedAt: "2026-04-20T13:40:02.000Z",
  finishedAt: null,
  agentId: codexAgent.id,
  agentName: codexAgent.name,
  adapterType: "codex_local",
  issueId,
};

const liveRunTranscript: TranscriptEntry[] = [
  {
    kind: "assistant",
    ts: "2026-04-20T13:40:08.000Z",
    text: "I am wiring the chat and comments Storybook coverage now.",
  },
  {
    kind: "thinking",
    ts: "2026-04-20T13:40:12.000Z",
    text: "Need fixtures that exercise MarkdownBody, assistant-ui messages, and the embedded run transcript path without reaching the API.",
  },
  {
    kind: "tool_call",
    ts: "2026-04-20T13:40:18.000Z",
    name: "rg",
    toolUseId: "tool-live-rg",
    input: {
      query: "IssueChatThread",
      cwd: "ui/src",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-04-20T13:40:20.000Z",
    toolUseId: "tool-live-rg",
    content: "ui/src/components/IssueChatThread.tsx\nui/src/components/RunChatSurface.tsx",
    isError: false,
  },
  {
    kind: "assistant",
    ts: "2026-04-20T13:40:31.000Z",
    text: [
      "The live run should render code blocks as part of the assistant response:",
      "",
      "```tsx",
      "<RunChatSurface run={run} transcript={entries} hasOutput />",
      "```",
    ].join("\n"),
  },
  {
    kind: "tool_call",
    ts: "2026-04-20T13:40:44.000Z",
    name: "apply_patch",
    toolUseId: "tool-live-patch",
    input: {
      file: "ui/storybook/stories/chat-comments.stories.tsx",
      action: "add fixtures",
    },
  },
  {
    kind: "tool_result",
    ts: "2026-04-20T13:40:49.000Z",
    toolUseId: "tool-live-patch",
    content: "Added Storybook scenarios for comment thread, run chat, and issue chat.",
    isError: false,
  },
];

const issueChatComments: IssueChatComment[] = [
  createComment({
    id: "comment-issue-board",
    body: "Please turn the comment thread into a reviewable chat surface. I need to see operator messages, agent output, system events, and live run progress together.",
    createdAt: new Date("2026-04-20T13:44:00.000Z"),
  }),
  createComment({
    id: "comment-issue-agent",
    authorAgentId: codexAgent.id,
    authorUserId: null,
    body: "I kept the existing component contracts and added fixtures with realistic Paperclip work: checkout, comments, linked runs, and review feedback.",
    createdAt: new Date("2026-04-20T13:50:00.000Z"),
    runId: "run-issue-chat-01",
    runAgentId: codexAgent.id,
  }),
  createComment({
    id: "comment-issue-queued",
    body: "@QAChecker please do a quick visual pass after the Storybook build is green.",
    createdAt: new Date("2026-04-20T13:56:00.000Z"),
    clientId: "client-issue-queued",
    clientStatus: "queued",
    queueState: "queued",
    queueTargetRunId: liveRun.id,
  }),
];

const issueTimelineEvents: IssueTimelineEvent[] = [
  createSystemEvent({
    id: "event-issue-checkout",
    createdAt: new Date("2026-04-20T13:42:00.000Z"),
    actorType: "system",
    actorId: "paperclip",
    statusChange: {
      from: "todo",
      to: "in_progress",
    },
  }),
  createSystemEvent({
    id: "event-issue-assignee",
    createdAt: new Date("2026-04-20T13:43:00.000Z"),
    actorType: "user",
    actorId: currentUserId,
    statusChange: undefined,
    assigneeChange: {
      from: { agentId: null, userId: null },
      to: { agentId: codexAgent.id, userId: null },
    },
  }),
];

const issueLinkedRuns: IssueChatLinkedRun[] = [
  {
    runId: "run-issue-chat-01",
    status: "succeeded",
    agentId: codexAgent.id,
    agentName: codexAgent.name,
    adapterType: "codex_local",
    createdAt: new Date("2026-04-20T13:46:00.000Z"),
    startedAt: new Date("2026-04-20T13:46:00.000Z"),
    finishedAt: new Date("2026-04-20T13:51:00.000Z"),
    hasStoredOutput: true,
  },
];

const issueTranscriptsByRunId = new Map<string, readonly IssueChatTranscriptEntry[]>([
  [
    "run-issue-chat-01",
    [
      {
        kind: "thinking",
        ts: "2026-04-20T13:46:10.000Z",
        text: "Checking the existing Storybook organization before adding a new product group.",
      },
      {
        kind: "tool_call",
        ts: "2026-04-20T13:46:16.000Z",
        name: "read_file",
        toolUseId: "tool-issue-read",
        input: {
          path: "ui/storybook/stories/overview.stories.tsx",
        },
      },
      {
        kind: "tool_result",
        ts: "2026-04-20T13:46:19.000Z",
        toolUseId: "tool-issue-read",
        content: "The coverage map already lists Chat & comments as a planned section.",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-04-20T13:49:00.000Z",
        text: "Added the story file and kept every fixture local to the story so product data fixtures stay stable.",
      },
      {
        kind: "diff",
        ts: "2026-04-20T13:49:04.000Z",
        changeType: "file_header",
        text: "diff --git a/ui/storybook/stories/chat-comments.stories.tsx b/ui/storybook/stories/chat-comments.stories.tsx",
      },
      {
        kind: "diff",
        ts: "2026-04-20T13:49:05.000Z",
        changeType: "add",
        text: "+export const FullSurfaceMatrix: Story = {};",
      },
    ],
  ],
  [liveRun.id, liveRunTranscript],
]);

function ThreadProps({
  comments,
  queuedComments = [],
  timelineEvents = [],
}: {
  comments: StoryComment[];
  queuedComments?: StoryComment[];
  timelineEvents?: IssueTimelineEvent[];
}) {
  return (
    <CommentThread
      comments={comments}
      queuedComments={queuedComments}
      linkedRuns={commentLinkedRuns}
      timelineEvents={timelineEvents}
      companyId={companyId}
      projectId={projectId}
      issueStatus="in_progress"
      agentMap={storybookAgentMap}
      currentUserId={currentUserId}
      onAdd={async () => {}}
      enableReassign
      reassignOptions={reassignOptions}
      currentAssigneeValue={`agent:${codexAgent.id}`}
      suggestedAssigneeValue={`agent:${codexAgent.id}`}
      mentions={mentionOptions}
      onInterruptQueued={async () => {}}
    />
  );
}

function CommentThreadMatrix() {
  return (
    <Section eyebrow="CommentThread" title="Timeline comments across empty, single, long, markdown, and queued states">
      <div className="grid gap-5 xl:grid-cols-2">
        <ScenarioCard title="Empty thread" description="No timeline entries yet, with the composer ready for the first comment.">
          <ThreadProps comments={[]} />
        </ScenarioCard>
        <ScenarioCard title="Single board comment" description="A minimal operator request with timestamp and composer controls.">
          <ThreadProps comments={singleComment} />
        </ScenarioCard>
        <ScenarioCard title="Long mixed-author thread" description="Board, product, agent, linked run, and system timeline entries in one stack.">
          <ThreadProps comments={longThreadComments} timelineEvents={commentTimelineEvents} />
        </ScenarioCard>
        <ScenarioCard title="Markdown, code, mentions, and links" description="Markdown rendering with code fences, @mentions, links, and a queued reply.">
          <ThreadProps comments={markdownComments} queuedComments={[queuedComment]} />
        </ScenarioCard>
      </div>
    </Section>
  );
}

function RunChatMatrix() {
  return (
    <Section eyebrow="RunChatSurface" title="Live run chat with streaming output, tools, and code blocks">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-lg border border-border bg-background/70 p-4">
          <RunChatSurface
            run={liveRun}
            transcript={liveRunTranscript}
            hasOutput
            companyId={companyId}
          />
        </div>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>Run fixture shape</CardTitle>
            <CardDescription>Streaming transcript entries mixed into the same chat renderer used by issue chat.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Status</span>
              <Badge variant="secondary">running</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Tool calls</span>
              <span className="font-mono text-xs">rg, apply_patch</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Transcript entries</span>
              <span className="font-mono text-xs">{liveRunTranscript.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}

function IssueChatMatrix() {
  return (
    <Section eyebrow="IssueChatThread" title="Issue-specific chat with timeline events, linked runs, and live output">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="rounded-lg border border-border bg-background/70 p-4">
          <IssueChatThread
            comments={issueChatComments}
            linkedRuns={issueLinkedRuns}
            timelineEvents={issueTimelineEvents}
            liveRuns={[liveRun]}
            feedbackVotes={feedbackVotes}
            feedbackDataSharingPreference="allowed"
            companyId={companyId}
            projectId={projectId}
            issueStatus="in_progress"
            agentMap={storybookAgentMap}
            currentUserId={currentUserId}
            userLabelMap={boardUserLabels}
            onAdd={async () => {}}
            onVote={async () => {}}
            onStopRun={async () => {}}
            enableReassign
            reassignOptions={reassignOptions}
            currentAssigneeValue={`agent:${codexAgent.id}`}
            suggestedAssigneeValue={`agent:${codexAgent.id}`}
            mentions={mentionOptions}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueTranscriptsByRunId}
            hasOutputForRun={(runId) => issueTranscriptsByRunId.has(runId)}
            includeSucceededRunsWithoutOutput
            onInterruptQueued={async () => {}}
            onCancelQueued={() => undefined}
          />
        </div>
        <div className="space-y-5">
          <ScenarioCard title="Empty issue chat" description="The standalone empty state before an operator or agent posts.">
            <IssueChatThread
              comments={[]}
              timelineEvents={[]}
              linkedRuns={[]}
              liveRuns={[]}
              companyId={companyId}
              projectId={projectId}
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              onAdd={async () => {}}
              enableLiveTranscriptPolling={false}
              emptyMessage="No chat yet. The first operator note will start the issue conversation."
            />
          </ScenarioCard>
          <ScenarioCard title="Disabled composer" description="Review state where the conversation remains readable but input is paused.">
            <IssueChatThread
              comments={singleComment}
              timelineEvents={[]}
              linkedRuns={[]}
              liveRuns={[]}
              companyId={companyId}
              projectId={projectId}
              agentMap={storybookAgentMap}
              currentUserId={currentUserId}
              onAdd={async () => {}}
              showJumpToLatest={false}
              enableLiveTranscriptPolling={false}
              composerDisabledReason="This issue is in review. Request changes or approve it from the review controls."
            />
          </ScenarioCard>
        </div>
      </div>
    </Section>
  );
}

function ChatCommentsStories() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Chat & Comments</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Threaded work conversations</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Fixture-backed coverage for classic issue comments, embedded run chat, and the assistant-style issue chat
            surface. The scenarios use Paperclip operational content with mixed authors, system timeline events,
            markdown, code blocks, @mentions, links, queued comments, tool calls, and streaming run output.
          </p>
        </section>

        <CommentThreadMatrix />
        <RunChatMatrix />
        <IssueChatMatrix />
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Chat & Comments",
  component: ChatCommentsStories,
  parameters: {
    docs: {
      description: {
        component:
          "Chat and comments stories exercise CommentThread, RunChatSurface, and IssueChatThread across empty, single, long, markdown, mention, timeline, queued, linked-run, and streaming transcript states.",
      },
    },
  },
} satisfies Meta<typeof ChatCommentsStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullSurfaceMatrix: Story = {};

export const CommentThreads: Story = {
  render: () => (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <CommentThreadMatrix />
      </main>
    </div>
  ),
};

export const LiveRunChat: Story = {
  render: () => (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <RunChatMatrix />
      </main>
    </div>
  ),
};

export const IssueChatWithTimeline: Story = {
  render: () => (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <IssueChatMatrix />
      </main>
    </div>
  ),
};
