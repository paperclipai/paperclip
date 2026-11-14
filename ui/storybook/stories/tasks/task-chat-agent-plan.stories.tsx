import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueThreadInteraction, IssueWorkMode } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import {
  issueThreadInteractionFixtureMeta,
  pendingAskUserQuestionsInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import {
  TaskChatTurnStatusIsland,
  taskChatTurnPlanSegment,
  type TaskChatTurnStatusModel,
} from "@/components/task-chat/TaskChatTurnStatusIsland";
import type { TaskChatProtocolStep } from "@/components/task-chat/task-chat-model";
import { composerAgentAppearance, composerAgents } from "../../prototypes/composer-model-picker/fixtures";
import { storybookAgentMap } from "../../fixtures/paperclipData";

type Status = TaskChatProtocolStep["status"];

const FIX_STEPS = [
  "Reproduce the duplicate webhook delivery",
  "Trace the retry path in the delivery worker",
  "Make delivery idempotent on the event id",
  "Add a regression test for retried deliveries",
  "Run the webhook test suite",
];

function steps(labels: readonly string[], statuses: readonly Status[]): TaskChatProtocolStep[] {
  return labels.map((label, index) => ({ id: `step-${index + 1}`, label, status: statuses[index] ?? "pending" }));
}

function planModel(planSteps: TaskChatProtocolStep[], diff?: { files: number; additions: number; deletions: number }): TaskChatTurnStatusModel {
  return {
    segments: [
      taskChatTurnPlanSegment(planSteps),
      ...(diff ? [{ kind: "workspace_diff" as const, ...diff }] : []),
    ],
  };
}

const LONG_STEPS = [
  "Read the migration guide for the new SDK",
  "Inventory every call site of the legacy client",
  "Update the auth handshake",
  "Port the streaming reader",
  "Port the batch uploader",
  "Replace retry helpers with SDK retries",
  "Update fixtures for the new response shape",
  "Fix type errors across the server package",
  "Run unit tests",
  "Run the end-to-end smoke suite",
  "Remove the legacy client dependency",
  "Write the upgrade note",
];

const STATES = {
  planned: planModel(steps(FIX_STEPS, ["pending", "pending", "pending", "pending", "pending"])),
  inProgress: planModel(steps(FIX_STEPS, ["completed", "in_progress", "pending", "pending", "pending"])),
  withDiff: planModel(
    steps(FIX_STEPS, ["completed", "completed", "completed", "in_progress", "pending"]),
    { files: 3, additions: 48, deletions: 12 },
  ),
  blocked: planModel(steps(FIX_STEPS, ["completed", "completed", "completed", "completed", "blocked"]), {
    files: 3,
    additions: 61,
    deletions: 12,
  }),
  complete: planModel(steps(FIX_STEPS, ["completed", "completed", "completed", "completed", "completed"]), {
    files: 3,
    additions: 61,
    deletions: 12,
  }),
  long: planModel(steps(LONG_STEPS, LONG_STEPS.map((_, index) => (index < 6 ? "completed" : index === 6 ? "in_progress" : "pending")))),
  singleStep: planModel(steps(["Answer the question about the billing export"], ["in_progress"])),
  diffOnly: { segments: [{ kind: "workspace_diff" as const, files: 2, additions: 14, deletions: 3 }] },
} satisfies Record<string, TaskChatTurnStatusModel>;

const agentMap = new Map(composerAgents.map((agent) => [agent.id, {
  id: agent.id,
  name: agent.name,
  appearance: composerAgentAppearance(agent.id),
}]));
const assignees = composerAgents.map((agent) => ({ id: `agent:${agent.id}`, label: agent.name }));

const environmentQuestion = {
  ...pendingAskUserQuestionsInteraction,
  id: "interaction-plan-environment",
  title: "Question",
  payload: {
    ...pendingAskUserQuestionsInteraction.payload,
    title: "Question",
    questions: [{
      ...pendingAskUserQuestionsInteraction.payload.questions[0],
      id: "smoke-environment",
      prompt: "Which environment should I run the webhook suite against?",
      helpText: undefined,
      options: [
        { id: "staging", label: "Staging" },
        { id: "local", label: "Local" },
      ],
    }],
  },
} satisfies IssueThreadInteraction;

/**
 * The production composer dock with the production composer, mirroring the
 * order in TaskChatThread: turn status island, then the composer stack. A
 * pending question uses the composer's own takeover, as in the live thread.
 */
function Dock({ children, question = false, mobile = false }: { children: ReactNode; question?: boolean; mobile?: boolean }) {
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [questionOpen, setQuestionOpen] = useState(question);
  const takeoverContent = (
    <TaskChatInteractionCard
      item={{ id: `interaction:${environmentQuestion.id}`, kind: "interaction", interaction: environmentQuestion }}
      presentation="takeover"
      agentMap={storybookAgentMap}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
      onSubmitInteractionAnswers={async () => setQuestionOpen(false)}
    />
  );
  return (
    <TaskChatComposerDock mobile={mobile} streamlined={false}>
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
        issueStatus="in_progress"
        mobile={mobile}
        takeover={questionOpen ? {
          id: environmentQuestion.id,
          label: environmentQuestion.title ?? "Question",
          pendingCount: 1,
          content: takeoverContent,
          onDismiss: () => setQuestionOpen(false),
          onSkip: () => setQuestionOpen(false),
          inlineSkip: true,
        } : null}
      />
    </TaskChatComposerDock>
  );
}

function StateCard({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      {children}
    </section>
  );
}

function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className={narrow ? "mx-auto w-full max-w-sm" : "mx-auto w-full max-w-2xl"}>{children}</div>
    </div>
  );
}

function AllStates() {
  return (
    <Page>
      <div className="flex flex-col gap-10">
        <header>
          <h2 className="text-lg font-semibold">Agent plan</h2>
          <p className="text-sm text-muted-foreground">
            The agent&apos;s own checklist for the current turn, docked above the composer. It comes from the
            provider-neutral <code className="font-mono text-xs">plan.updated</code> event, so Claude task tools, Codex
            plan updates, Cursor todos and any ACP <code className="font-mono text-xs">plan</code> update look the same.
          </p>
        </header>
        <StateCard title="Just planned" rule="Nothing started yet. The headline shows the first step as “Up next”.">
          <Dock><TaskChatTurnStatusIsland model={STATES.planned} /></Dock>
        </StateCard>
        <StateCard title="Working" rule="Done steps are checked and muted, the current step is highlighted with a spinner, upcoming steps are open circles.">
          <Dock><TaskChatTurnStatusIsland model={STATES.inProgress} /></Dock>
        </StateCard>
        <StateCard title="Working, with file changes" rule="File-change totals join the header instead of a second pill.">
          <Dock><TaskChatTurnStatusIsland model={STATES.withDiff} /></Dock>
        </StateCard>
        <StateCard title="Blocked" rule="A blocked or failed step becomes the headline and the progress bar turns red.">
          <Dock><TaskChatTurnStatusIsland model={STATES.blocked} /></Dock>
        </StateCard>
        <StateCard title="All done, final answer still streaming" rule="Collapses on its own once every step is done. Click the header to reopen it. The card disappears when the run ends.">
          <Dock><TaskChatTurnStatusIsland model={STATES.complete} /></Dock>
        </StateCard>
        <StateCard title="Long plan" rule="Plans over 7 steps show a window around the current step, with rows for earlier and remaining steps. Click either to show all.">
          <Dock><TaskChatTurnStatusIsland model={STATES.long} /></Dock>
        </StateCard>
        <StateCard title="Single step" rule="A one-step list adds nothing, so only the header shows.">
          <Dock><TaskChatTurnStatusIsland model={STATES.singleStep} /></Dock>
        </StateCard>
        <StateCard title="Waiting on the viewer" rule="While a question or approval is open, the plan shrinks to its header so the decision stays in focus.">
          <Dock question>
            <TaskChatTurnStatusIsland model={STATES.inProgress} compact />
          </Dock>
        </StateCard>
        <StateCard title="No plan, file changes only" rule="Without a plan, the existing file-change pill still shows.">
          <Dock><TaskChatTurnStatusIsland model={STATES.diffOnly} /></Dock>
        </StateCard>
        <StateCard title="Hidden" rule="Nothing renders when the turn has no plan steps and no file changes, or once the run has finished, failed or been cancelled.">
          <Dock>{null}</Dock>
        </StateCard>
      </div>
    </Page>
  );
}

/** Advances through the plan the way a live run would. */
function LiveRun() {
  const [tick, setTick] = useState(0);
  const total = FIX_STEPS.length;
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => (value + 1) % (total * 2 + 3)), 1400);
    return () => clearInterval(timer);
  }, [total]);
  const completed = Math.min(total, Math.floor(tick / 2));
  const statuses: Status[] = FIX_STEPS.map((_, index) =>
    index < completed ? "completed" : index === completed && tick % 2 === 1 ? "in_progress" : "pending",
  );
  const model = planModel(steps(FIX_STEPS, statuses), completed > 1 ? { files: completed, additions: completed * 13, deletions: completed * 2 } : undefined);
  return (
    <Page>
      <p className="mb-4 text-xs text-muted-foreground">Simulated live run: plan updates arrive every 1.4 s and the loop restarts after the plan finishes.</p>
      <Dock><TaskChatTurnStatusIsland model={model} /></Dock>
    </Page>
  );
}

const meta = {
  id: "product-task-chat-agent-plan",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Agent plan",
  component: TaskChatTurnStatusIsland,
  args: { model: STATES.inProgress },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The agent's checklist for the current turn, docked above the composer. It is built from canonical `plan.updated` provider events, so every harness that reports a native plan renders the same way.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the shipped turn-status island inside the production composer dock, composer, and question takeover with fixture plan snapshots. Live provider event delivery is not exercised."
    },
  },
  render: (args) => (
    <Page>
      <Dock><TaskChatTurnStatusIsland {...args} /></Dock>
    </Page>
  ),
} satisfies Meta<typeof TaskChatTurnStatusIsland>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllStatesGallery: Story = { render: () => <AllStates /> };
export const LiveRunSimulation: Story = { render: () => <LiveRun /> };
export const JustPlanned: Story = { args: { model: STATES.planned } };
export const Working: Story = { args: { model: STATES.inProgress } };
export const WorkingWithFileChanges: Story = { args: { model: STATES.withDiff } };
export const Blocked: Story = { args: { model: STATES.blocked } };
export const AllDoneCollapsed: Story = { args: { model: STATES.complete } };
export const LongPlanWindowed: Story = { args: { model: STATES.long } };
export const SingleStepHeaderOnly: Story = { args: { model: STATES.singleStep } };
export const WaitingOnViewer: Story = {
  args: { model: STATES.inProgress, compact: true },
  render: (args) => (
    <Page>
      <Dock question><TaskChatTurnStatusIsland {...args} /></Dock>
    </Page>
  ),
};
export const MobileStartsCollapsed: Story = {
  args: { model: STATES.withDiff, defaultCollapsed: true },
  render: (args) => (
    <Page narrow>
      <Dock mobile><TaskChatTurnStatusIsland {...args} /></Dock>
    </Page>
  ),
};
