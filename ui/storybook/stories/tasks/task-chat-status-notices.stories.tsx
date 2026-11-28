import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatProviderActivityItem,
  TaskChatToolItem,
} from "@/components/task-chat/task-chat-model";

type RunStatus = "running" | "succeeded" | "failed";

function tool(id: string, name: string, target: string, status: TaskChatToolItem["status"] = "completed"): TaskChatToolItem {
  return { id, kind: "tool", name, rawName: name.toLowerCase(), target, status };
}

/**
 * The same shape the live transcript adapter builds from a canonical
 * `provider.notice.recorded` event: payload keys become title-cased details.
 */
function notice(
  id: string,
  fields: { category: string; severity: "info" | "warning" | "error"; recoverable: boolean; summary?: string },
  extra: Record<string, string> = {},
): TaskChatProviderActivityItem {
  return {
    id,
    kind: "protocol",
    surface: "provider_activity",
    family: "provider_notice",
    eventType: "provider.notice.recorded",
    status: fields.severity === "error" && !fields.recoverable ? "failed" : "informational",
    title: "Provider notice",
    summary: fields.summary,
    details: [
      { label: "Severity", value: fields.severity },
      { label: "Category", value: fields.category },
      { label: "Scope", value: "turn" },
      { label: "Recoverable", value: String(fields.recoverable) },
      ...(fields.summary ? [{ label: "Summary", value: fields.summary }] : []),
      ...Object.entries(extra).map(([label, value]) => ({ label, value })),
    ],
    steps: [],
    links: [],
    children: [],
  };
}

function progress(id: string, text: string): TaskChatMessageItem {
  return { id, kind: "message", author: "agent", channel: "progress", interstitial: true, text };
}

function final(id: string, text: string): TaskChatMessageItem {
  return { id, kind: "message", author: "agent", channel: "final", interstitial: false, text, timestamp: "2:41 PM" };
}

const compactingNow = notice("compaction-1", { category: "context_compaction", severity: "info", recoverable: true }, { Phase: "running" });
const compacted = notice("compaction-1", { category: "context_compaction", severity: "info", recoverable: true }, { Phase: "completed" });
const compactionFailed = notice("compaction-1", {
  category: "context_compaction", severity: "warning", recoverable: true,
  summary: "Conversation too long to summarize; continuing with the full context.",
}, { Phase: "failed" });

const overloadRetry = notice("retry-1", {
  category: "provider_retry", severity: "warning", recoverable: true,
  summary: "We're currently experiencing high demand, which may cause temporary errors.",
}, { Reason: "serverOverloaded", Attempt: "2", "Max attempts": "5" });

const streamRetry = notice("retry-2", {
  category: "provider_retry", severity: "warning", recoverable: true,
  summary: "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
}, { Reason: "responseStreamDisconnected", Attempt: "1", "Max attempts": "5" });

const fallback = notice("fallback-1", {
  category: "model_fallback", severity: "warning", recoverable: true,
  summary: "claude-opus-5-5 declined this request; retried with claude-sonnet-5-5. The session will continue on claude-sonnet-5-5.",
}, { "Original model": "claude-opus-5-5", "Fallback model": "claude-sonnet-5-5", Reason: "declined the request (cyber)" });

const hookWarning = notice("info-1", {
  category: "provider_informational", severity: "warning", recoverable: true,
  summary: "Stop hook blocked continuation: lint must pass before finishing (pnpm lint exited 1).",
});

const fatal = notice("error-1", {
  category: "error", severity: "error", recoverable: false,
  summary: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 4:12 PM.",
}, { "Codex error": "usageLimitExceeded" });

const reading = [
  tool("t1", "Read", "server/src/services/webhooks/delivery-worker.ts"),
  tool("t2", "Search", "\"deliverWebhook\" in server/src"),
  tool("t3", "Read", "server/src/services/webhooks/retry-policy.ts"),
];
const editing = [
  tool("t4", "Edit", "server/src/services/webhooks/delivery-worker.ts"),
  tool("t5", "Bash", "pnpm vitest run server/src/services/webhooks"),
];

const ANSWER = "Deliveries are now idempotent on the event id: the worker records the id before sending and skips ids it has already delivered. I added a regression test that retries the same event twice and asserts a single POST. The webhook suite passes (14 tests).";

interface Scenario {
  title: string;
  rule: string;
  agent: string;
  status: RunStatus;
  items: TaskChatItem[];
}

const SCENARIOS = {
  compacting: {
    title: "Compacting context (Claude)",
    rule: "A spinner chip while the harness summarizes earlier context. It never joins the answer text.",
    agent: "ClaudeCoder", status: "running",
    items: [progress("p1", "Tracing the retry path through the delivery worker."), ...reading, compactingNow],
  },
  compacted: {
    title: "Context compacted, work continues",
    rule: "The chip settles to a quiet receipt and later activity continues below it.",
    agent: "ClaudeCoder", status: "succeeded",
    items: [progress("p1", "Tracing the retry path through the delivery worker."), ...reading, compacted, ...editing, final("f1", ANSWER)],
  },
  compactionFailed: {
    title: "Compaction failed",
    rule: "Amber, with the harness's reason. The run keeps going.",
    agent: "ClaudeCoder", status: "running",
    items: [...reading, compactionFailed, tool("t4", "Edit", "server/src/services/webhooks/delivery-worker.ts", "in_progress")],
  },
  retrying: {
    title: "Retrying after overload (Codex)",
    rule: "Amber while the provider is retrying, with the attempt count and the provider's real message.",
    agent: "CodexCoder", status: "running",
    items: [...reading, overloadRetry],
  },
  recovered: {
    title: "Retry recovered",
    rule: "Once real work follows, the retry chip fades to “Recovered after retry”.",
    agent: "CodexCoder", status: "succeeded",
    items: [...reading, streamRetry, ...editing, final("f1", ANSWER)],
  },
  fallback: {
    title: "Model fallback (Claude)",
    rule: "Names the model the session moved to and why. Click for the full explanation.",
    agent: "ClaudeCoder", status: "succeeded",
    items: [...reading, fallback, ...editing, final("f1", ANSWER)],
  },
  hookWarning: {
    title: "Provider warning banner",
    rule: "Claude's bold “Warning:” banners become an amber chip instead of answer text.",
    agent: "ClaudeCoder", status: "running",
    items: [...reading, ...editing, hookWarning],
  },
  fatal: {
    title: "Fatal provider error",
    rule: "A red row with the provider's real message, not “Provider notice”.",
    agent: "CodexCoder", status: "failed",
    items: [...reading, overloadRetry, fatal],
  },
} satisfies Record<string, Scenario>;

function Thread({ scenario }: { scenario: Scenario }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TaskChatBubble
        item={{ id: "ask", kind: "message", author: "human", authorName: "Alex", isCurrentUser: true, text: "Webhooks are delivered twice when the worker retries. Please fix it and add a test.", timestamp: "2:30 PM" }}
        animateEntry={false}
      />
      <TaskChatRunnerTurn
        runId={`run-${scenario.title}`}
        agentName={scenario.agent}
        items={scenario.items}
        status={scenario.status}
        startedAtMs={Date.now() - 95_000}
        finishedAtMs={scenario.status === "running" ? undefined : Date.now() - 5_000}
        showHeader
      />
    </div>
  );
}

function Card({ scenario, children }: { scenario: Scenario; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{scenario.title}</h3>
        <p className="text-xs text-muted-foreground">{scenario.rule}</p>
      </div>
      <div className="rounded-lg border border-border bg-background p-4">{children}</div>
    </section>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">{children}</div>
    </main>
  );
}

function Gallery() {
  return (
    <Page>
      <header>
        <h2 className="text-lg font-semibold">Harness status notices</h2>
        <p className="text-sm text-muted-foreground">
          Compaction, retries, model fallback and provider banners render as chips between the turn&apos;s activity.
          They come from canonical <code className="font-mono text-xs">provider.notice.recorded</code> events with a
          status category, so they stay out of the answer and the issue comment.
        </p>
      </header>
      {Object.values(SCENARIOS).map((scenario) => (
        <Card key={scenario.title} scenario={scenario}><Thread scenario={scenario} /></Card>
      ))}
    </Page>
  );
}

function Single({ scenario }: { scenario: Scenario }) {
  return <Page><Card scenario={scenario}><Thread scenario={scenario} /></Card></Page>;
}

const meta = {
  id: "product-task-chat-status-notices",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Task chat/Status notices",
  component: Single,
  args: { scenario: SCENARIOS.retrying },
  parameters: {
    layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the shipped runner turn with fixture provider notices shaped like the live transcript adapter output. Live provider event delivery is not exercised."
    },
  },
} satisfies Meta<typeof Single>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStatesGallery: Story = { render: () => <Gallery /> };
export const CompactingContext: Story = { args: { scenario: SCENARIOS.compacting } };
export const ContextCompacted: Story = { args: { scenario: SCENARIOS.compacted } };
export const CompactionFailed: Story = { args: { scenario: SCENARIOS.compactionFailed } };
export const RetryingAfterOverload: Story = { args: { scenario: SCENARIOS.retrying } };
export const RetryRecovered: Story = { args: { scenario: SCENARIOS.recovered } };
export const ModelFallback: Story = { args: { scenario: SCENARIOS.fallback } };
export const ProviderWarningBanner: Story = { args: { scenario: SCENARIOS.hookWarning } };
export const FatalProviderError: Story = { args: { scenario: SCENARIOS.fatal } };
export const Light: Story = { render: () => <Gallery />, globals: { theme: "light" } };
