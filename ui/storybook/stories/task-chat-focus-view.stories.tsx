import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import {
  saveTaskChatViewMode,
  TASK_CHAT_VIEW_MODE_STORAGE_KEY,
  TaskChatViewModeProvider,
  TaskChatViewModeToggle,
  type TaskChatViewMode,
} from "@/components/task-chat/focus-mode";
import type { TaskChatItem } from "@/components/task-chat/task-chat-model";
import { i18n } from "@/i18n";

// A settled runner turn: reasoning and tool rows that Focus view folds, a
// decided runtime request it keeps visible, and the final response. Pending
// requests render above the composer, not in the turn timeline.
const settledRunItems: TaskChatItem[] = [
  {
    id: "reasoning-plan",
    kind: "thinking",
    lines: ["Reading the failing test before changing the adapter."],
    streaming: false,
    channel: "summary",
    transcriptIndex: 1,
  },
  {
    id: "tool-read",
    kind: "tool",
    name: "Read",
    rawName: "read_file",
    target: "ui/src/components/task-chat/task-chat-adapter.ts",
    status: "completed",
  },
  {
    id: "tool-edit",
    kind: "tool",
    name: "Edit",
    rawName: "edit_file",
    target: "ui/src/components/task-chat/task-chat-adapter.ts",
    status: "completed",
  },
  {
    id: "tool-test",
    kind: "tool",
    name: "Bash",
    rawName: "bash",
    target: "pnpm exec vitest run ui/src/components/task-chat",
    status: "completed",
  },
  {
    id: "runtime-approval",
    kind: "protocol",
    surface: "runtime_request",
    runId: "storybook-focus-run",
    requestId: "runtime-approval",
    requestKind: "command_approval",
    turnId: "storybook-focus-turn",
    requestType: "permission",
    status: "resolved",
    prompt: "Allow the agent to run git push origin feat/adapter-fix?",
    choices: [
      { key: "accept", label: "Allow" },
      { key: "decline", label: "Decline" },
    ],
    fields: [],
    resolvedAction: "accept",
  },
  {
    id: "final-response",
    kind: "message",
    author: "agent",
    text: "The adapter test passes again and the branch is pushed.",
    channel: "final",
  },
];

function LocaleFrame({ locale, children }: { locale: string; children: ReactNode }) {
  const [ready, setReady] = useState(i18n.language === locale);
  useLayoutEffect(() => {
    const previous = i18n.language;
    void i18n.changeLanguage(locale).then(() => setReady(true));
    return () => {
      void i18n.changeLanguage(previous);
    };
  }, [locale]);
  return ready ? <>{children}</> : null;
}

function FocusViewReview({
  initialMode,
  locale = "en",
}: {
  initialMode: TaskChatViewMode;
  locale?: string;
}) {
  // Like TaskChatThread, a stored choice wins over the story default and
  // survives a reload. Each visual test starts with empty storage.
  const [mode, setMode] = useState<TaskChatViewMode>(() => {
    const stored = localStorage.getItem(TASK_CHAT_VIEW_MODE_STORAGE_KEY);
    return stored === "full" || stored === "focus" ? stored : initialMode;
  });
  const changeMode = (next: TaskChatViewMode) => {
    setMode(next);
    saveTaskChatViewMode(next);
  };
  return (
    <LocaleFrame locale={locale}>
      <div className="flex max-w-xl flex-col gap-2 rounded-lg border border-border bg-background p-4">
        <TaskChatViewModeProvider mode={mode}>
          <TaskChatViewModeToggle mode={mode} onChange={changeMode} />
          <TaskChatRunnerTurn
            runId="storybook-focus-run"
            agentName="CodexRunner"
            items={settledRunItems}
            status="succeeded"
            startedAtMs={Date.now() - 38_000}
            finishedAtMs={Date.now()}
          />
        </TaskChatViewModeProvider>
      </div>
    </LocaleFrame>
  );
}

const meta = {
  title: "Tasks/Task chat focus view",
  component: FocusViewReview,
  parameters: { layout: "padded" },
  args: { initialMode: "full", locale: "en" },
} satisfies Meta<typeof FocusViewReview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullView: Story = {};

export const FocusView: Story = {
  args: { initialMode: "focus" },
};

export const FullViewFrench: Story = {
  args: { initialMode: "full", locale: "fr" },
};

export const FocusViewFrench: Story = {
  args: { initialMode: "focus", locale: "fr" },
};
