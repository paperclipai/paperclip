import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { TaskChatPresentationProvider } from "@/components/task-chat/presentation-mode";
import { ContextUsageMeter, type ContextCompactState, type ContextUsage } from "@/components/ContextUsageMeter";
import { IssueProperties } from "@/components/IssueProperties";
import { ScrollArea } from "@/components/ui/scroll-area";
import { queryKeys } from "@/lib/queryKeys";
import type {
  TaskChatItem,
  TaskChatMarkerItem,
  TaskChatMessageItem,
  TaskChatToolItem,
} from "@/components/task-chat/task-chat-model";
import {
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookIssueLabels,
  storybookIssues,
  storybookProjects,
} from "../../fixtures/paperclipData";

/** Codex gpt-5 class session: 272k window, auto-compacts around 245k. */
const CODEX_WINDOW = 272_000;
const CODEX_COMPACT = 244_800;

const USAGE = {
  fresh: {
    usedTokens: 18_400,
    contextWindow: CODEX_WINDOW,
    autoCompactTokens: CODEX_COMPACT,
    totals: { inputTokens: 21_300, cachedInputTokens: 9_800, outputTokens: 1_240 },
    lastTurn: { inputTokens: 18_400, outputTokens: 1_240 },
  },
  working: {
    usedTokens: 174_100,
    contextWindow: CODEX_WINDOW,
    autoCompactTokens: CODEX_COMPACT,
    totals: { inputTokens: 1_480_000, cachedInputTokens: 1_310_000, outputTokens: 31_800, reasoningOutputTokens: 12_400 },
    lastTurn: { inputTokens: 174_100, outputTokens: 2_150 },
  },
  nearCompaction: {
    usedTokens: 229_500,
    contextWindow: CODEX_WINDOW,
    autoCompactTokens: CODEX_COMPACT,
    totals: { inputTokens: 3_920_000, cachedInputTokens: 3_610_000, outputTokens: 58_200, reasoningOutputTokens: 21_900 },
    lastTurn: { inputTokens: 229_500, outputTokens: 1_870 },
  },
  afterCompaction: {
    usedTokens: 38_200,
    contextWindow: CODEX_WINDOW,
    autoCompactTokens: CODEX_COMPACT,
    totals: { inputTokens: 4_310_000, cachedInputTokens: 3_840_000, outputTokens: 63_900, reasoningOutputTokens: 23_100 },
    lastTurn: { inputTokens: 38_200, outputTokens: 940 },
    compactions: 1,
  },
  claudeNearlyFull: {
    usedTokens: 191_300,
    contextWindow: 200_000,
    totals: { inputTokens: 2_640_000, cachedInputTokens: 2_410_000, outputTokens: 44_700 },
    costUsd: 3.18,
  },
  claudeWithCost: {
    usedTokens: 61_900,
    contextWindow: 200_000,
    totals: { inputTokens: 412_000, cachedInputTokens: 366_000, outputTokens: 9_300 },
    costUsd: 0.47,
  },
  windowOnly: { usedTokens: 96_000, contextWindow: 200_000 },
} satisfies Record<string, ContextUsage>;


const compactedMarker: TaskChatMarkerItem = {
  id: "compacted-1",
  kind: "marker",
  variant: "context_compacted",
  label: "Context compacted",
  detail: "230k → 38k tokens",
};

const autoCompactedClaude: TaskChatMarkerItem = {
  id: "compacted-claude",
  kind: "marker",
  variant: "context_compacted",
  label: "Context compacted",
  detail: "188k → 24k tokens · requested by you",
};

const unknownSizes: TaskChatMarkerItem = {
  id: "compacted-unknown",
  kind: "marker",
  variant: "context_compacted",
  label: "Context compacted",
};

const request: TaskChatMessageItem = {
  id: "request",
  kind: "message",
  author: "human",
  authorName: "Alex",
  isCurrentUser: true,
  text: "Port the billing exporter to the new SDK and keep the CSV output byte-identical.",
  timestamp: "2:04 PM",
};

const tool = (id: string, name: string, target: string): TaskChatToolItem => ({
  id, kind: "tool", name, target, status: "completed",
});

const progress: TaskChatMessageItem = {
  id: "progress",
  kind: "message",
  author: "agent",
  authorName: "Codex",
  channel: "progress",
  interstitial: true,
  text: "Mapped all 41 call sites of the legacy client. Porting the streaming reader next.",
  timestamp: "2:19 PM",
};

const afterCompaction: TaskChatMessageItem = {
  id: "after",
  kind: "message",
  author: "agent",
  authorName: "Codex",
  channel: "progress",
  interstitial: true,
  text: "Picking up from the summary: streaming reader is ported, batch uploader is next.",
  timestamp: "2:31 PM",
};

const THREAD: TaskChatItem[] = [
  request,
  tool("t1", "Search", "legacyClient\\."),
  tool("t2", "Read", "server/src/billing/exporter.ts"),
  progress,
  tool("t3", "Edit", "server/src/billing/stream-reader.ts"),
  tool("t4", "Run", "pnpm vitest billing"),
  compactedMarker,
  afterCompaction,
  tool("t5", "Read", "server/src/billing/batch-uploader.ts"),
];


const companyId = "company-storybook";
const issue = storybookIssues[0]!;

function StorybookData({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready] = useState(() => {
    queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
    queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
    queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
    queryClient.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
    queryClient.setQueryData(queryKeys.projects.list(companyId, { includeArchived: true }), storybookProjects);
    queryClient.setQueryData(queryKeys.issues.list(companyId), storybookIssues);
    queryClient.setQueryData(queryKeys.issues.labels(companyId), storybookIssueLabels);
    queryClient.setQueryData(queryKeys.issues.liveRuns(issue.id), []);
    queryClient.setQueryData(queryKeys.issues.activeRun(issue.id), null);
    return true;
  });
  return ready ? children : null;
}

const COMPACT_AVAILABLE: ContextCompactState = { status: "available", onCompact: () => {} };
const COMPACT_UNAVAILABLE: ContextCompactState = {
  status: "unavailable",
  reason: "Available while the agent is working on this task.",
};

/** Compact now flips to pending, then the usage drops and a compaction is counted. */
function useCompactDemo(initial: ContextUsage) {
  const [usage, setUsage] = useState(initial);
  const [pending, setPending] = useState(false);
  const compact: ContextCompactState = pending
    ? { status: "pending" }
    : {
        status: "available",
        onCompact: () => {
          setPending(true);
          setTimeout(() => {
            setPending(false);
            setUsage((current) => ({
              ...current,
              usedTokens: Math.round(current.usedTokens * 0.17),
              compactions: (current.compactions ?? 0) + 1,
            }));
          }, 1800);
        },
      };
  return { usage, compact };
}

function PropertiesPane({ usage, compact, defaultOpen }: { usage: ContextUsage; compact?: ContextCompactState | null; defaultOpen?: boolean }) {
  return (
    <StorybookData>
      <div className="flex h-(--sz-640px) w-80 flex-col overflow-hidden border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-sm font-medium">Properties</div>
        <ScrollArea className="flex-1">
          <div className="p-4">
            <IssueProperties
              issue={issue}
              childIssues={[]}
              onUpdate={() => undefined}
              contextUsage={<ContextUsageMeter usage={usage} compact={compact} defaultOpen={defaultOpen} />}
            />
          </div>
        </ScrollArea>
      </div>
    </StorybookData>
  );
}

function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className={narrow ? "mx-auto w-full max-w-sm" : "mx-auto w-full max-w-2xl"}>{children}</div>
    </div>
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

/** A Properties-style row without the full panel, for comparing states. */
function MeterRow({ usage, compact }: { usage: ContextUsage; compact?: ContextCompactState | null }) {
  return (
    <div className="flex w-80 items-center gap-3 rounded-md border border-border bg-card px-4 py-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">Context</span>
      <ContextUsageMeter usage={usage} compact={compact} />
    </div>
  );
}

function TaskPage() {
  const { usage, compact } = useCompactDemo(USAGE.nearCompaction);
  return (
    <div className="flex min-h-screen gap-6 bg-background p-6 text-foreground">
      <div className="min-w-0 flex-1">
        <h1 className="mb-4 text-xl font-semibold">Port billing exporter to the new SDK</h1>
        <TaskChatPresentationProvider mode="streamlined">
          <TaskChatThreadView items={THREAD} scroll={false} />
        </TaskChatPresentationProvider>
      </div>
      <div className="pl-72">
        <PropertiesPane usage={usage} compact={compact} />
      </div>
    </div>
  );
}

function AllStates() {
  return (
    <Page>
      <div className="flex flex-col gap-10">
        <header>
          <h2 className="text-lg font-semibold">Context window</h2>
          <p className="text-sm text-muted-foreground">
            A Context row in the task&apos;s Properties shows how full the assigned agent&apos;s context window is. Hover
            or tap it for the token breakdown and Compact now. Codex reports usage through{" "}
            <code className="font-mono text-xs">thread/tokenUsage/updated</code>, Claude through ACP{" "}
            <code className="font-mono text-xs">usage_update</code>.
          </p>
        </header>
        <StateCard title="Fresh session" rule="Neutral bar, percentage and window size.">
          <MeterRow usage={USAGE.fresh} compact={COMPACT_AVAILABLE} />
        </StateCard>
        <StateCard title="Working" rule="Bar fills as the conversation grows. Still neutral.">
          <MeterRow usage={USAGE.working} compact={COMPACT_AVAILABLE} />
        </StateCard>
        <StateCard title="Near auto-compaction" rule="Amber within 10 points of the harness's auto-compaction threshold.">
          <MeterRow usage={USAGE.nearCompaction} compact={COMPACT_AVAILABLE} />
        </StateCard>
        <StateCard title="Nearly full (Claude)" rule="Red at 95% or more.">
          <MeterRow usage={USAGE.claudeNearlyFull} compact={COMPACT_AVAILABLE} />
        </StateCard>
        <StateCard title="Hidden" rule="No Context row until the agent's harness has reported a context window for this task's session.">
          <p className="text-xs text-muted-foreground">(no row)</p>
        </StateCard>
        <StateCard title="Compaction divider" rule="A transcript rule marks the point where the agent's context was summarized, with before and after sizes when known.">
          <div className="flex flex-col gap-3">
            <TaskChatMarker item={compactedMarker} />
            <TaskChatMarker item={autoCompactedClaude} />
            <TaskChatMarker item={unknownSizes} />
          </div>
        </StateCard>
      </div>
    </Page>
  );
}

function Breakdown({ usage, compact }: { usage: ContextUsage; compact?: ContextCompactState | null }) {
  return (
    <div className="flex min-h-screen justify-end bg-background p-6 text-foreground">
      <PropertiesPane usage={usage} compact={compact} defaultOpen />
    </div>
  );
}

function InteractiveBreakdown() {
  const { usage, compact } = useCompactDemo(USAGE.nearCompaction);
  return <Breakdown usage={usage} compact={compact} />;
}

const meta = {
  id: "product-task-context-window",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Context window",
  component: ContextUsageMeter,
  args: { usage: USAGE.working, compact: COMPACT_AVAILABLE },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Context row in the task Properties panel with a hover breakdown and Compact now, plus the transcript divider recorded when the agent's context is compacted.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the context meter inside the production Issue Properties panel and the compaction divider in the production thread view, from fixture usage snapshots. Compact now is simulated locally; no agent session is contacted."
    },
  },
  render: (args) => (
    <div className="bg-background p-6 text-foreground"><MeterRow {...args} /></div>
  ),
} satisfies Meta<typeof ContextUsageMeter>;

export default meta;

type Story = StoryObj<typeof meta>;

export const InTask: Story = { render: () => <TaskPage /> };
export const AllStatesGallery: Story = { render: () => <AllStates /> };
export const BreakdownNearCompaction: Story = { render: () => <InteractiveBreakdown /> };
export const BreakdownWorking: Story = { render: () => <Breakdown usage={USAGE.working} compact={COMPACT_AVAILABLE} /> };
export const BreakdownClaudeWithCost: Story = { render: () => <Breakdown usage={USAGE.claudeWithCost} compact={COMPACT_AVAILABLE} /> };
export const BreakdownBetweenRuns: Story = { render: () => <Breakdown usage={USAGE.afterCompaction} compact={COMPACT_UNAVAILABLE} /> };
export const BreakdownCompacting: Story = { render: () => <Breakdown usage={USAGE.nearCompaction} compact={{ status: "pending" }} /> };
