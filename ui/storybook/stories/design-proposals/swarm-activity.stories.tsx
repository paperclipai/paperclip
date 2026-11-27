import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import type { TaskChatActivityPhaseItem } from "@/components/task-chat/task-chat-model";
import {
  GoogleOnlyExtras,
  InlineDirection,
  SidePanel,
  SourceLegend,
  SummaryCard,
  SwarmTurn,
} from "../../support/design-proposals/swarm-activity/SwarmViews";
import type { SwarmView } from "../../support/design-proposals/swarm-activity/swarm-model";
import {
  TODAY_STEPS,
  completed,
  failed,
  longSwarm,
  refused,
  running,
  runningWithBlocked,
  starting,
  stopped,
  stopping,
} from "../../support/design-proposals/swarm-activity/swarm-variants";

function Thread({ request, children, narrow, wide }: { request: string; children: ReactNode; narrow?: boolean; wide?: boolean }) {
  const width = narrow ? "max-w-sm px-4" : wide ? "max-w-6xl px-6" : "max-w-3xl px-6";
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className={`mx-auto flex w-full flex-col gap-6 py-8 ${width}`}>
        <div className="self-end rounded-xl bg-muted px-4 py-3 text-sm">/swarm {request}</div>
        {children}
      </main>
    </div>
  );
}

function Legend() {
  return <div className="rounded-md border border-border p-3"><SourceLegend /></div>;
}

function TodayView() {
  const phase: TaskChatActivityPhaseItem = {
    id: "today",
    kind: "activity_phase",
    summary: "",
    active: false,
    items: TODAY_STEPS.map((step, index) => ({ id: `today-${index}`, kind: "tool", name: "Swarm", rawName: "swarm", toolKind: "other", status: "completed", description: step, target: step })),
  };
  const view = completed();
  return (
    <Thread request={view.request}>
      <SwarmTurn view={view}><TaskChatRunnerActivityGroup item={phase} defaultExpanded /></SwarmTurn>
    </Thread>
  );
}

function Inline({ view, narrow }: { view: SwarmView; narrow?: boolean }) {
  return <Thread request={view.request} narrow={narrow}><Legend /><InlineDirection view={view} /></Thread>;
}

function Panel({ view, tab, google }: { view: SwarmView; tab?: string; google?: boolean }) {
  return (
    <Thread request={view.request} wide>
      <Legend />
      <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-5">
        <div className="min-w-0 md:col-span-3">
          <SwarmTurn view={view}>
            <p className="text-sm text-foreground">I split this into {view.helpers.length} helpers. Follow them in the swarm panel.</p>
          </SwarmTurn>
        </div>
        <div className="min-w-0 md:col-span-2"><SidePanel view={view} defaultTab={tab} googleExtras={google ? <GoogleOnlyExtras /> : undefined} /></div>
      </div>
    </Thread>
  );
}

function Summary({ view, open, narrow }: { view: SwarmView; open?: boolean; narrow?: boolean }) {
  return (
    <Thread request={view.request} narrow={narrow}>
      <Legend />
      <SwarmTurn view={view}><SummaryCard view={view} defaultOpen={open} /></SwarmTurn>
    </Thread>
  );
}

function NarrowBoth() {
  const blocked = runningWithBlocked();
  const view = running();
  return (
    <Thread request={view.request} narrow>
      <SwarmTurn view={blocked}><SummaryCard view={blocked} annotate={false} /></SwarmTurn>
      <InlineDirection view={view} annotate={false} />
    </Thread>
  );
}

const STATES: Array<[string, () => SwarmView]> = [
  ["Starting", starting],
  ["Running", running],
  ["Helper blocked", runningWithBlocked],
  ["Stopping after Stop", stopping],
  ["Stopped", stopped],
  ["Failed", failed],
  ["Not available here", refused],
  ["Finished", completed],
];

function StateMatrix() {
  return (
    <Thread request={running().request}>
      <Legend />
      {STATES.map(([label, make]) => (
        <section key={label} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
          <SummaryCard view={make()} annotate={false} />
        </section>
      ))}
    </Thread>
  );
}

function Compare() {
  const view = running();
  return (
    <Thread request={view.request} wide>
      <Legend />
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="flex min-w-0 flex-col gap-2"><h3 className="text-xs font-medium text-muted-foreground">1 · Inline helpers</h3><InlineDirection view={view} annotate={false} /></section>
        <section className="flex min-w-0 flex-col gap-2"><h3 className="text-xs font-medium text-muted-foreground">2 · Swarm panel</h3><SidePanel view={view} annotate={false} /></section>
        <section className="flex min-w-0 flex-col gap-2"><h3 className="text-xs font-medium text-muted-foreground">3 · Summary card</h3><SummaryCard view={view} annotate={false} /></section>
      </div>
    </Thread>
  );
}

const meta = {
  id: "design-antigravity-swarm-activity",
  title: "Design proposals/Patterns/Antigravity swarm activity",
  component: Compare,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: [
          "How a Google Antigravity swarm could appear inside a Paperclip task. Every story is built from one real swarm run (CLI 1.5.15, auto mode): `ui/storybook/fixtures/antigravity-swarm.sample.json`. The fixture is a normalised extract of that run: the ACP updates as received, plus the swarm's `plan.json`, `members.json` and `board.jsonl` and a summary of each helper transcript, stored under short keys with paths redacted. Two parts are not from this run. The blocked post is adapted from an earlier recorded run of the same CLI (a helper's write outside the task folder timed out): the wording is the recorded wording, but the helper name and path are changed. The long swarm is synthetic and uses the same shapes.",
          "Each element is tagged with where it comes from. **Live**: sent over ACP while the coordinator works (the request, swarm title, each helper's name and brief, the goal, tasks and threads from the coordinator's plan, the coordinator's own messages, finish and stop, and one usage total). **Swarm files**: read from the board, roster and helper transcripts that the CLI writes in Paperclip's private state folder (helper state, current step, helper messages with numbers, in review and done, progress, models and per-helper tokens). Google never forwards these over ACP. **Needs Google**: not available today; shown only in the labelled variant.",
          "Today renders the driver's current step titles for this run. The shipped driver would actually stop this run at the coordinator's plan write, because the plan file is outside the task folder. The plan is the source of the Goal and Threads shown here.",
          "Directions: 1 · Inline helpers reuses the shipped subagent tree. That tree has no blocked status (only running, done, failed and stopped), so this direction shows blocked helpers in a separate Needs attention row above it; doing it properly needs a blocked status in the shared card. 2 · Swarm panel follows Antigravity's Overview, Members and Board tabs. 3 · Summary card is one compact card that expands.",
        ].join("\n\n"),
      },
    },
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"],
      status: "proposed",
      home: "design-proposals",
      exception: "Design exploration for showing an Antigravity swarm in a task; not wired to the backend.",
      implementation: "prototype",
      boundary: "fixtures",
      notes: "Fixture-driven exploration built from shipped task-chat parts: runner header, activity group, subagent tree, status glyphs, tabs and badges. Uses one real recorded swarm run, plus one synthetic long swarm. Helper state, current step and helper messages need a reader for the CLI's private swarm files, which does not exist yet.",
    },
  },
  render: () => <Compare />,
} satisfies Meta<typeof Compare>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompareDirections: Story = { name: "00 · Compare directions · running", render: () => <Compare /> };
export const Today: Story = { name: "01 · Today · driver step titles", render: () => <TodayView /> };
export const InlineRunning: Story = { name: "02 · Inline helpers · running", render: () => <Inline view={running()} /> };
export const InlineBlocked: Story = { name: "03 · Inline helpers · helper blocked", render: () => <Inline view={runningWithBlocked()} /> };
export const InlineFinished: Story = { name: "04 · Inline helpers · finished", render: () => <Inline view={completed()} /> };
export const PanelOverview: Story = { name: "05 · Swarm panel · overview", render: () => <Panel view={running()} /> };
export const PanelHelpers: Story = { name: "06 · Swarm panel · helpers", render: () => <Panel view={completed()} tab="helpers" /> };
export const PanelMessages: Story = { name: "07 · Swarm panel · messages", render: () => <Panel view={completed()} tab="messages" /> };
export const SummaryCollapsed: Story = { name: "08 · Summary card · collapsed", render: () => <Summary view={running()} /> };
export const SummaryExpanded: Story = { name: "09 · Summary card · expanded", render: () => <Summary view={running()} open /> };
export const States: Story = { name: "10 · States · starting to finished", render: () => <StateMatrix /> };
export const LongSwarmInline: Story = { name: "11 · Long swarm · inline", render: () => <Inline view={longSwarm()} /> };
export const LongSwarmPanel: Story = { name: "12 · Long swarm · panel messages", render: () => <Panel view={longSwarm()} tab="messages" /> };
export const LongSwarmSummary: Story = { name: "13 · Long swarm · summary expanded", render: () => <Summary view={longSwarm()} open /> };
export const Narrow: Story = { name: "14 · Narrow · summary and inline", render: () => <NarrowBoth /> };
export const NeedsGoogle: Story = { name: "15 · Would need Google to expose", render: () => <Panel view={longSwarm()} tab="helpers" google /> };
