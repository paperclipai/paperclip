import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatQueuedMessages } from "@/components/task-chat/TaskChatQueuedMessages";

const LONG_BODIES = [
  "Before you continue, please double-check that the storefront hero copy matches the brand brief we agreed on and that the call to action points at the right collection page.",
  "Also make sure the mobile navigation collapses into a single menu button below the tablet breakpoint, and that the cart badge stays visible while the menu is closed.",
  "Use the GitHub connection for the repository and post the preview link in Slack once the first deploy finishes so the team can review it together.",
  "If the product grid feels sparse, add two more placeholder tees with the same price tier so the layout reads as a real catalogue instead of a demo.",
  "Please keep the checkout flow out of scope for this pass; a clickable stub is enough as long as it explains that payments are coming later.",
  "When you are done, summarise what changed, what is still open, and which follow-up tasks you think should be created for Brand & Design.",
  "One more thing: the footer links should open the policy pages in the same tab, not a new window.",
  "And finally, confirm the favicon renders on a dark browser tab bar as well as a light one.",
];

function queuedEntry(body: string, index: number): IssueQueuedCommentEntry {
  return {
    comment: {
      id: `queued-${index + 1}`,
      companyId: "storybook",
      issueId: "coordinator-dock-queue-story",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "storybook-user",
      body,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-11-05T11:40:00Z"),
      updatedAt: new Date("2026-11-05T11:40:00Z"),
    },
    position: index,
    canEdit: true,
    canDiscard: true,
  };
}

const TRANSCRIPT = [
  "Here’s the plan for the storefront prototype. I’ll start with the brand brief and wireframes, then build the clickable prototype in the GitHub repository.",
  "Brand & Design finished the brief and wireframes. Frontend Engineer is now building the storefront prototype.",
  "GitHub is connected, so the continuation run can push the prototype branch.",
  "I’m wiring the product grid and the hero section now. I’ll post a preview link once the first deploy finishes.",
];

function CoordinatorDockQueue({ count, mobile }: { count: number; mobile: boolean }) {
  const [entries, setEntries] = useState(() =>
    Array.from({ length: count }, (_, index) => queuedEntry(LONG_BODIES[index % LONG_BODIES.length], index)),
  );
  const queue: IssueQueuedCommentQueue = {
    issueId: "coordinator-dock-queue-story",
    queueId: "queue-story",
    state: "deferred",
    targetRunId: "active-run",
    revision: "story-revision",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries,
  };
  const remove = (id: string) => setEntries((current) => current.filter((entry) => entry.comment.id !== id));

  return (
    <div className="coordinator-workspace flex h-dvh flex-col bg-background text-foreground">
      <header data-testid="story-task-header" className="shrink-0 border-b border-border px-4 py-3 text-sm font-medium">
        ONB-1 · Paperclip onboarding
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div data-testid="task-chat-thread" className="relative flex min-h-0 flex-1 flex-col">
          <div data-testid="task-chat-scroller" className="min-h-0 flex-1 overflow-y-auto">
            <div className="paperclip-mobile-thread mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col gap-4 px-4 pt-4 text-sm">
              {TRANSCRIPT.map((text, index) => (
                <p
                  key={index}
                  data-testid={index === TRANSCRIPT.length - 1 ? "story-latest-message" : undefined}
                  className="rounded-lg bg-card px-4 py-3"
                >
                  {text}
                </p>
              ))}
            </div>
          </div>
          <TaskChatComposerDock mobile={mobile} streamlined={false}>
            <div className="relative isolate flex flex-col" data-testid="task-chat-composer-stack">
              <TaskChatQueuedMessages
                queue={queue}
                onEdit={() => undefined}
                onReorder={async () => undefined}
                onSteer={async (id) => remove(id)}
                onDiscard={async (id) => remove(id)}
              />
              <div className="relative z-10">
                <TaskChatComposer onAdd={async () => undefined} workMode="standard" onStop={async () => undefined} mobile={mobile} />
              </div>
            </div>
          </TaskChatComposerDock>
        </div>
      </main>
    </div>
  );
}

const meta = {
  id: "coordinator-dock-queued-messages",
  title: "Tasks and conversations/Steering and queued messages/Composer/Coordinator dock with many queued messages",
  component: CoordinatorDockQueue,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The production queued-message strip inside the production Coordinator composer dock with many long queued messages. The strip must scroll within a bounded height so the transcript above it stays readable." } },
    paperclip: {
      "capabilities": [
        "steering/queue"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  args: { count: 8, mobile: false },
} satisfies Meta<typeof CoordinatorDockQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ManyQueuedMessages: Story = {};
export const ManyQueuedMessagesDark: Story = { globals: { theme: "dark" } };
export const ManyQueuedMessagesPhone: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
