import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueDocument, IssueThreadInteraction, IssueWorkMode } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { TaskChatPlanPreviewCard } from "@/components/task-chat/TaskChatPlanPreviewCard";
import {
  TaskChatTurnStatusIsland,
  taskChatTurnPlanSegment,
} from "@/components/task-chat/TaskChatTurnStatusIsland";
import type { TaskChatProtocolStep, TaskChatProviderActivityItem } from "@/components/task-chat/task-chat-model";
import { issueThreadInteractionFixtureMeta } from "@/fixtures/issueThreadInteractionFixtures";
import { composerAgentAppearance, composerAgents } from "../../prototypes/composer-model-picker/fixtures";
import { storybookAgentMap, storybookIssueDocuments } from "../../fixtures/paperclipData";

/*
 * Proposed plans that can be approved (harness signal #9).
 *
 * A task in Plan mode runs the harness in its own plan mode (Codex
 * collaborationMode "plan", Claude permission mode "plan"). The harness's
 * proposed-plan document (Codex `plan` item, Claude ExitPlanMode) becomes the
 * issue's `plan` document, and the existing plan request_confirmation drives the
 * Approve / Request changes decision in the composer takeover.
 */

const ISSUE_ID = issueThreadInteractionFixtureMeta.issueId;

const PROPOSED_PLAN = [
  "# Stop duplicate webhook deliveries",
  "",
  "## Findings",
  "- The delivery worker retries on any 5xx, including after the receiver already committed the event.",
  "- `deliveries.event_id` has no unique constraint, so a retry inserts a second delivery row.",
  "",
  "## Steps",
  "1. Add a unique index on `(endpoint_id, event_id)` with a migration that keeps the newest row.",
  "2. Make `enqueueDelivery` an upsert keyed on the event id.",
  "3. Send an `Idempotency-Key` header so receivers can dedupe on their side.",
  "4. Add a regression test that retries a delivery after a 502.",
  "",
  "## Out of scope",
  "- Changing the retry backoff schedule.",
].join("\n");

/** The proposal as it streams: the first N non-empty lines of the markdown. */
function partialPlan(lineCount: number) {
  return PROPOSED_PLAN.split("\n").filter(Boolean).slice(0, lineCount).join("\n\n");
}

const planDocument: IssueDocument = {
  ...storybookIssueDocuments[0]!,
  issueId: ISSUE_ID,
  body: PROPOSED_PLAN,
  latestRevisionId: "revision-plan-1",
  latestRevisionNumber: 1,
};

function liveDraft(lineCount: number): TaskChatProviderActivityItem {
  return {
    id: "provider-activity:plan-proposal",
    kind: "protocol",
    surface: "provider_activity",
    family: "plan",
    eventType: "plan.proposed",
    status: "running",
    title: "Plan",
    details: [],
    steps: [],
    links: [],
    children: [],
    output: partialPlan(lineCount),
  };
}

const basePlanConfirmation = {
  id: "interaction-proposed-plan",
  companyId: issueThreadInteractionFixtureMeta.companyId,
  issueId: ISSUE_ID,
  kind: "request_confirmation" as const,
  title: "Review plan revision 1",
  summary: "Review the synchronized Paperclip plan.",
  status: "pending" as const,
  continuationPolicy: "wake_assignee" as const,
  sourceRunId: "run-plan-1",
  createdByAgentId: "agent-codex",
  createdByUserId: null,
  resolvedByAgentId: null,
  resolvedByUserId: null,
  createdAt: new Date("2026-11-05T15:02:00.000Z"),
  updatedAt: new Date("2026-11-05T15:02:00.000Z"),
  resolvedAt: null,
  payload: {
    version: 1 as const,
    prompt: "Approve plan revision 1?",
    detailsMarkdown: "The completed provider plan has been synchronized to the canonical Plan document.",
    acceptLabel: "Approve plan",
    rejectLabel: "Request changes",
    rejectRequiresReason: true,
    supersedeOnUserComment: false,
    target: {
      type: "issue_document" as const,
      issueId: ISSUE_ID,
      documentId: planDocument.id,
      key: "plan",
      revisionId: "revision-plan-1",
      revisionNumber: 1,
      label: "Plan v1",
    },
  },
  result: null,
} as IssueThreadInteraction;

const acceptedPlanConfirmation = {
  ...basePlanConfirmation,
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-11-05T15:04:00.000Z"),
  result: { version: 1, outcome: "accepted" },
} as IssueThreadInteraction;

const rejectedPlanConfirmation = {
  ...basePlanConfirmation,
  status: "rejected",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-11-05T15:04:00.000Z"),
  result: {
    version: 1,
    outcome: "rejected",
    reason: "Keep the old rows. Dedupe at read time instead of deleting history in the migration.",
  },
} as IssueThreadInteraction;

const IMPLEMENT_STEPS: TaskChatProtocolStep[] = [
  "Add a unique index on (endpoint_id, event_id)",
  "Make enqueueDelivery an upsert keyed on the event id",
  "Send an Idempotency-Key header",
  "Add a regression test for retried deliveries",
].map((label, index) => ({ id: `impl-${index}`, label, status: index === 0 ? "in_progress" : "pending" }));

const agentMap = new Map(composerAgents.map((agent) => [agent.id, {
  id: agent.id,
  name: agent.name,
  appearance: composerAgentAppearance(agent.id),
}]));
const assignees = composerAgents.map((agent) => ({ id: `agent:${agent.id}`, label: agent.name }));

function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="ml-auto max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{children}</div>
  );
}

function AgentText({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 text-foreground">{children}</p>;
}

function Thread({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 px-1 pb-4">{children}</div>;
}

/** Production composer dock + composer, optionally with the plan decision takeover. */
function Dock({
  children,
  initialMode = "planning",
  review = false,
}: {
  children?: ReactNode;
  initialMode?: IssueWorkMode;
  review?: boolean;
}) {
  const [workMode, setWorkMode] = useState<IssueWorkMode>(initialMode);
  const [open, setOpen] = useState(review);
  const takeoverContent = (
    <TaskChatInteractionCard
      item={{ id: `interaction:${basePlanConfirmation.id}`, kind: "interaction", interaction: basePlanConfirmation }}
      presentation="takeover"
      planDocument={planDocument}
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      onAcceptInteraction={async () => setOpen(false)}
      onRejectInteraction={async () => setOpen(false)}
    />
  );
  return (
    <TaskChatComposerDock mobile={false} streamlined={false}>
      {children}
      <TaskChatComposer
        onAdd={async () => {}}
        onStop={async () => {}}
        workMode={workMode}
        onWorkModeChange={setWorkMode}
        enableReassign
        currentAssigneeValue="agent:codex"
        reassignOptions={assignees}
        agentMap={agentMap}
        issueStatus={review ? "in_review" : "in_progress"}
        takeover={open ? {
          id: basePlanConfirmation.id,
          label: "Review plan",
          pendingCount: 1,
          content: takeoverContent,
          onDismiss: () => setOpen(false),
          onSkip: () => setOpen(false),
          hideSkip: true,
        } : null}
      />
    </TaskChatComposerDock>
  );
}

function Stage({ step, title, rule, children }: { step: number; title: string; rule: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{step}. {title}</h3>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-3">{children}</div>
    </section>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
    </div>
  );
}

const ASK = "Webhook receivers are seeing the same event twice after timeouts. Plan the fix first.";

function Entered() {
  return (
    <>
      <Thread><UserMessage>{ASK}</UserMessage></Thread>
      <Dock initialMode="planning" />
    </>
  );
}

function Drafting() {
  return (
    <>
      <Thread>
        <UserMessage>{ASK}</UserMessage>
        <AgentText>Reading the delivery worker and the deliveries schema before proposing a fix.</AgentText>
        <TaskChatPlanPreviewCard source={{ kind: "live", activity: liveDraft(5) }} />
      </Thread>
      <Dock initialMode="planning" />
    </>
  );
}

function ReadyForReview() {
  return (
    <>
      <Thread>
        <UserMessage>{ASK}</UserMessage>
        <TaskChatPlanPreviewCard source={{ kind: "saved", document: planDocument }} testId="plan-review-preview" />
        <AgentText>Plan saved to the task. Waiting for your approval before changing any code.</AgentText>
      </Thread>
      <Dock initialMode="planning" review />
    </>
  );
}

function ChangesRequested() {
  return (
    <>
      <Thread>
        <UserMessage>{ASK}</UserMessage>
        <TaskChatPlanPreviewCard source={{ kind: "saved", document: planDocument }} />
        <TaskChatInteractionCard
          item={{ id: `interaction:${rejectedPlanConfirmation.id}`, kind: "interaction", interaction: rejectedPlanConfirmation }}
          planDocument={{ ...planDocument, latestRevisionId: "revision-plan-2", latestRevisionNumber: 2 }}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        />
        <TaskChatPlanPreviewCard source={{ kind: "live", activity: liveDraft(3) }} />
      </Thread>
      <Dock initialMode="planning" />
    </>
  );
}

function Approved() {
  return (
    <>
      <Thread>
        <UserMessage>{ASK}</UserMessage>
        <TaskChatInteractionCard
          item={{ id: `interaction:${acceptedPlanConfirmation.id}`, kind: "interaction", interaction: acceptedPlanConfirmation }}
          planDocument={planDocument}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
        />
        <AgentText>Starting on the approved plan.</AgentText>
      </Thread>
      <Dock initialMode="standard">
        <TaskChatTurnStatusIsland model={{ segments: [taskChatTurnPlanSegment(IMPLEMENT_STEPS)] }} />
      </Dock>
    </>
  );
}

/**
 * Proposed: the agent's own switch into plan mode in a Standard task (Claude
 * EnterPlanMode, or a Paperclip plan request from any harness). Prototype row.
 */
function ModeSwitchRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span>{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

const OPT_IN_ASK = "Fix the duplicate webhook deliveries.";

function AgentOptsIn() {
  return (
    <>
      <Thread>
        <UserMessage>{OPT_IN_ASK}</UserMessage>
        <AgentText>The fix needs a migration that rewrites delivery history, so I&apos;ll propose a plan before changing anything.</AgentText>
        <ModeSwitchRow>Codie switched to plan mode · read-only until you decide</ModeSwitchRow>
        <TaskChatPlanPreviewCard source={{ kind: "saved", document: planDocument }} />
      </Thread>
      <Dock initialMode="standard" review />
    </>
  );
}

function Journey() {
  return (
    <Page>
      <div className="flex flex-col gap-10">
        <header>
          <h2 className="text-lg font-semibold">Proposed plan approval</h2>
          <p className="text-sm text-muted-foreground">
            Plan mode on the task puts Codex or Claude into its own plan mode. The harness&apos;s proposed plan becomes
            the task&apos;s Plan document, and you approve it or request changes from the composer.
          </p>
        </header>
        <Stage step={1} title="Plan mode is on" rule="The task's work mode is Planning (composer add menu → Plan mode). The yellow chip shows it; the run is read-only.">
          <Entered />
        </Stage>
        <Stage step={2} title="Agent drafts the plan" rule="The harness's proposed-plan stream (Codex plan item, Claude ExitPlanMode) shows as a live plan card instead of plain transcript text.">
          <Drafting />
        </Stage>
        <Stage step={3} title="Ready for review" rule="The finished proposal is saved as Plan v1. The composer is taken over by Approve plan / Request changes; the task is In review.">
          <ReadyForReview />
        </Stage>
        <Stage step={4} title="Changes requested" rule="Request changes needs a reason. The agent wakes in Plan mode with the reason and drafts revision 2.">
          <ChangesRequested />
        </Stage>
        <Stage step={5} title="Approved" rule="Approve flips the task to Standard and wakes the agent to implement. The run's checklist takes over above the composer.">
          <Approved />
        </Stage>
        <Stage step={6} title="Agent opts in on a Standard task" rule="No Plan mode chip: the agent chose to stop and ask. Same plan document and approval; the task stays Standard, so Approve just resumes it.">
          <AgentOptsIn />
        </Stage>
      </div>
    </Page>
  );
}

const meta = {
  id: "product-task-chat-proposed-plan",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Proposed plan approval",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A harness-native proposed plan (Codex `plan` item, Claude ExitPlanMode) becomes the task's Plan document and is approved or sent back from the composer takeover.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "implementation": "mixed",
      "boundary": "fixtures",
      "notes": "Production plan preview card, interaction card, composer dock, composer takeover and turn-status island with fixture plan data. Transcript message bubbles and the agent mode-switch divider are simplified stand-ins. Provider event delivery and the approval round-trip are not exercised."
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullJourney: Story = { render: () => <Journey /> };
export const PlanModeOn: Story = { render: () => <Page><Entered /></Page> };
export const DraftingPlan: Story = { render: () => <Page><Drafting /></Page> };
export const ReadyForReviewTakeover: Story = { render: () => <Page><ReadyForReview /></Page> };
export const ChangesRequestedRevision: Story = { render: () => <Page><ChangesRequested /></Page> };
export const AgentOptsInStandardTask: Story = { render: () => <Page><AgentOptsIn /></Page> };
export const ApprovedImplementing: Story = { render: () => <Page><Approved /></Page> };
