import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatRunnerHeader } from "@/components/task-chat/TaskChatRunnerTurn";
import { TaskChatExpansionState } from "@/components/task-chat/expansion-state";
import {
  TaskChatSubagentCard,
  TaskChatSubagentTree,
  type TaskChatSubagent,
  type TaskChatSubagentStatus,
} from "@/components/task-chat/TaskChatSubagentCard";
import type { TaskChatActivityPhaseItem, TaskChatToolStatus } from "@/components/task-chat/task-chat-model";

type Activity = TaskChatActivityPhaseItem["items"][number];

const NOW = Date.now();

function tool(id: string, name: string, target: string, status: TaskChatToolStatus = "completed", detail?: string): Activity {
  return { id, kind: "tool", name, rawName: name, target, status, detail };
}

const RETRY_PATH_TOOLS: Activity[] = [
  tool("a1", "Grep", "scheduleRetry", "completed", "server/src/services/webhook-delivery.ts:142\nserver/src/services/webhook-delivery.ts:211"),
  tool("a2", "Read", "server/src/services/webhook-delivery.ts"),
  tool("a3", "Read", "server/src/services/webhook-retry-policy.ts"),
  tool("a4", "Grep", "deliveryAttempts"),
  tool("a5", "Read", "packages/db/src/schema/webhook_deliveries.ts", "in_progress"),
];

const TEST_TOOLS: Activity[] = [
  tool("b1", "Glob", "server/src/**/__tests__/*webhook*"),
  tool("b2", "Read", "server/src/__tests__/webhook-delivery.test.ts"),
  tool("b3", "Grep", "fakeTimers"),
];

const PROVIDER_TOOLS: Activity[] = [
  tool("c1", "WebFetch", "docs.stripe.com/webhooks/best-practices"),
  tool("c2", "WebSearch", "idempotency key webhook redelivery"),
  tool("c3", "WebFetch", "docs.github.com/webhooks/using-webhooks/handling-webhook-deliveries"),
  tool("c4", "WebFetch", "svix.com/resources/webhook-best-practices/retries"),
];

function subagent(
  id: string,
  agentType: string,
  description: string,
  status: TaskChatSubagentStatus,
  activity: Activity[],
  extra: Partial<TaskChatSubagent> = {},
): TaskChatSubagent {
  const settled = status !== "running";
  return {
    id,
    agentType,
    description,
    status,
    activity: settled
      ? activity.map((item) => (item.kind === "tool" && item.status === "in_progress" ? { ...item, status: status === "failed" ? "failed" : "completed" } : item))
      : activity,
    startedAtMs: NOW - 48_000,
    finishedAtMs: settled ? NOW - 4_000 : null,
    ...extra,
  };
}

const RETRY_PROMPT =
  "Find every place a webhook delivery gets retried. I need the scheduling function, the backoff policy, and where the attempt counter is stored. Report file paths with line numbers and say whether a retry reuses the original event id.";

const RETRY_RESULT = `Retries are scheduled in **\`scheduleRetry\`** (\`server/src/services/webhook-delivery.ts:142\`) with exponential backoff from \`webhook-retry-policy.ts\` (5 attempts, 30s base).

- The attempt counter lives on \`webhook_deliveries.attempt_count\`.
- A retry **creates a new delivery row** and does not copy \`event_id\`, which explains the duplicate deliveries.`;

const parallelLive = [
  subagent("sa-retry", "Explore", "Trace the webhook retry path", "running", RETRY_PATH_TOOLS, {
    prompt: RETRY_PROMPT,
    model: "claude-haiku-5-5",
    progressSummary: "Found scheduleRetry and the backoff policy; checking where attempt_count is stored",
  }),
  subagent("sa-tests", "Explore", "Find existing webhook delivery tests", "completed", TEST_TOOLS, {
    prompt: "List the tests that cover webhook delivery and how they fake time.",
    result: "Two suites: `webhook-delivery.test.ts` (fake timers via `vi.useFakeTimers`) and `webhook-routes.test.ts` (HTTP only). Neither covers a retried delivery.",
    startedAtMs: NOW - 48_000,
    finishedAtMs: NOW - 21_000,
  }),
  subagent("sa-docs", "general-purpose", "Check how providers dedupe redeliveries", "running", PROVIDER_TOOLS, {
    prompt: "Read Stripe, GitHub and Svix guidance on webhook redelivery and summarize how receivers are expected to dedupe.",
    progressSummary: "Stripe and GitHub both send a stable delivery id; reading Svix retry guidance",
  }),
];

const parallelDone = [
  subagent("sa-retry", "Explore", "Trace the webhook retry path", "completed", RETRY_PATH_TOOLS, {
    prompt: RETRY_PROMPT,
    model: "claude-haiku-5-5",
    result: RETRY_RESULT,
  }),
  parallelLive[1]!,
  subagent("sa-docs", "general-purpose", "Check how providers dedupe redeliveries", "completed", PROVIDER_TOOLS, {
    prompt: parallelLive[2]!.prompt,
    result: "All three send a stable id per event (`Stripe-Signature` timestamp + `evt_` id, `X-GitHub-Delivery`, `svix-id`) and expect receivers to dedupe on it.",
    finishedAtMs: NOW - 9_000,
  }),
];

const parallelFailed = [
  parallelDone[0]!,
  parallelDone[1]!,
  subagent("sa-docs", "general-purpose", "Check how providers dedupe redeliveries", "failed", PROVIDER_TOOLS.slice(0, 2), {
    prompt: parallelLive[2]!.prompt,
    result: "WebFetch was denied for `docs.stripe.com`: the agent's network policy blocks external hosts.",
  }),
];

const singleLive = subagent("sa-plan", "Plan", "Design an idempotent delivery fix", "running", [
  tool("p1", "Read", "server/src/services/webhook-delivery.ts"),
  tool("p2", "Read", "packages/db/src/schema/webhook_deliveries.ts"),
  tool("p3", "Grep", "uniqueIndex", "in_progress"),
], {
  prompt: "Using the findings below, propose the smallest change that makes retried deliveries reuse the original event id. Include the migration.",
  progressSummary: "Weighing a unique index on (endpoint_id, event_id) against an upsert in scheduleRetry",
});

function phase(id: string, items: Activity[], active: boolean, interstitial?: string): TaskChatActivityPhaseItem {
  return {
    id,
    kind: "activity_phase",
    items,
    summary: "",
    active,
    interstitial: interstitial ? { id: `${id}:msg`, kind: "message", author: "agent", text: interstitial, channel: "progress", interstitial: true } : undefined,
  };
}

/** Mirrors TaskChatRunnerTurn's timeline: header, then rows with gap-2. */
function Turn({ status, children, final }: { status: string; children: ReactNode; final?: string }) {
  return (
    <div className="flex min-w-0 flex-col" data-testid="task-chat-runner-turn">
      <TaskChatRunnerHeader runId="story-run" agentName="Engineer" agentIcon="code" status={status} startedAtMs={NOW - 62_000} finishedAtMs={status === "running" ? null : NOW} />
      <div className="flex min-w-0 flex-col gap-2 py-1">{children}</div>
      {final ? (
        <TaskChatBubble item={{ id: "final", kind: "message", author: "agent", text: final, channel: "final", authorName: "Engineer" }} animateEntry={false} hideAgentIdentity />
      ) : null}
    </div>
  );
}

function Thread({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  const memory = useMemo(() => new Map<string, boolean>(), []);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className={narrow ? "mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-8" : "mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8"}>
        <div className="self-end rounded-xl bg-muted px-4 py-3 text-sm">
          Customers are getting the same webhook twice after a timeout. Can you find out why and fix it?
        </div>
        <TaskChatExpansionState.Provider value={memory}>{children}</TaskChatExpansionState.Provider>
      </main>
    </div>
  );
}

const OPENING = phase("open", [tool("o1", "Grep", "webhook", "completed"), tool("o2", "Read", "server/src/services/webhook-delivery.ts")], false,
  "I'll split this up: one subagent traces the retry path, one finds the existing tests, and one checks how providers expect receivers to dedupe.");

function ParallelLive({ narrow }: { narrow?: boolean }) {
  return (
    <Thread narrow={narrow}>
      <Turn status="running">
        <TaskChatRunnerActivityGroup item={OPENING} />
        <TaskChatSubagentTree subagents={parallelLive} />
      </Turn>
    </Thread>
  );
}

function SingleExpanded() {
  return (
    <Thread>
      <Turn status="running">
        <TaskChatRunnerActivityGroup item={phase("after", [], false, "The retry path creates a new row without the event id. I'll have a planning subagent design the fix.")} />
        <TaskChatSubagentCard subagent={singleLive} defaultExpanded />
      </Turn>
    </Thread>
  );
}

function Completed({ failed }: { failed?: boolean }) {
  return (
    <Thread>
      <Turn
        status={failed ? "succeeded" : "succeeded"}
        final={failed
          ? "Retries create a new delivery row without the original `event_id`. I couldn't read provider docs (network policy), so the fix below follows the GitHub pattern I already know: dedupe on a stable delivery id."
          : "Retries created a new delivery row without the original `event_id`, so receivers couldn't dedupe. `scheduleRetry` now reuses the event id and a unique index on `(endpoint_id, event_id)` stops duplicate rows. Added a regression test with fake timers."}
      >
        <TaskChatRunnerActivityGroup item={OPENING} />
        <TaskChatSubagentTree subagents={failed ? parallelFailed : parallelDone} />
        <TaskChatRunnerActivityGroup item={phase("fix", [
          tool("f1", "Edit", "server/src/services/webhook-delivery.ts"),
          tool("f2", "Write", "packages/db/src/migrations/0412_webhook_event_dedupe.sql"),
          tool("f3", "Bash", "pnpm vitest run webhook-delivery"),
        ], false, "Retries drop the event id. I'll reuse it and add a unique index.")} />
      </Turn>
    </Thread>
  );
}

/** Subagents start, report progress and finish on a loop. */
function LiveSimulation() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => (value + 1) % 14), 1500);
    return () => window.clearInterval(timer);
  }, []);
  const stage = (start: number, done: number, all: Activity[], base: TaskChatSubagent, doneVersion: TaskChatSubagent, summaries: string[]): TaskChatSubagent | null => {
    if (tick < start) return null;
    if (tick >= done) return doneVersion;
    const step = tick - start;
    const activity = all.slice(0, Math.min(all.length, step + 1)).map((item, index, list) =>
      item.kind === "tool" ? { ...item, status: (index === list.length - 1 ? "in_progress" : "completed") as TaskChatToolStatus } : item);
    return { ...base, activity, progressSummary: summaries[Math.min(summaries.length - 1, Math.floor(step / 2))] };
  };
  const children = [
    stage(1, 9, RETRY_PATH_TOOLS, parallelLive[0]!, parallelDone[0]!, ["Searching for retry scheduling", "Reading webhook-delivery.ts", "Found scheduleRetry and the backoff policy; checking where attempt_count is stored"]),
    stage(1, 5, TEST_TOOLS, { ...parallelLive[1]!, status: "running" }, parallelDone[1]!, ["Listing webhook tests", "Reading webhook-delivery.test.ts"]),
    stage(2, 11, PROVIDER_TOOLS, parallelLive[2]!, parallelDone[2]!, ["Reading Stripe guidance", "Stripe sends a stable event id; checking GitHub", "Stripe and GitHub both send a stable delivery id; reading Svix retry guidance"]),
  ].filter((value): value is TaskChatSubagent => value !== null);
  return (
    <Thread>
      <p className="text-xs text-muted-foreground">Simulated: subagents start, stream progress summaries every few seconds and finish; the loop restarts.</p>
      <Turn status="running">
        <TaskChatRunnerActivityGroup item={OPENING} />
        {children.length > 0 ? <TaskChatSubagentTree subagents={children} /> : null}
      </Turn>
    </Thread>
  );
}

const meta = {
  id: "product-task-chat-subagents",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Subagents",
  component: TaskChatSubagentTree,
  args: { subagents: parallelLive },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Delegated subagents inside a runner turn. A Claude `Task`/`Agent` call (or a Codex collab child thread) becomes a collapsible card with the subagent type, prompt, live progress summary, nested tool rows and result. Parallel subagents dispatched together render as a small tree with status dots.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the shipped subagent card and tree inside the production runner header, activity groups and final bubble with fixture subagents. In the app the rows come from canonical delegation events and tool events carrying parentItemId; live provider event delivery is not exercised here."
    },
  },
  render: () => <ParallelLive />,
} satisfies Meta<typeof TaskChatSubagentTree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ParallelRunning: Story = { name: "01 · Parallel subagents · running", render: () => <ParallelLive /> };
export const SingleRunningExpanded: Story = { name: "02 · One subagent · expanded", render: () => <SingleExpanded /> };
export const ParallelCompleted: Story = { name: "03 · Completed turn", render: () => <Completed /> };
export const ParallelOneFailed: Story = { name: "04 · One subagent failed", render: () => <Completed failed /> };
export const LiveRun: Story = { name: "05 · Live simulation · animated", render: () => <LiveSimulation /> };
export const Mobile: Story = { name: "06 · Mobile", render: () => <ParallelLive narrow /> };
export const Light: Story = { name: "07 · Light", render: () => <ParallelLive />, globals: { theme: "light" } };
