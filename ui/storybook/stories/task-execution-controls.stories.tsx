import { QueryClient } from "@tanstack/react-query";
import { __liveUpdatesTestUtils } from "@/context/LiveUpdatesProvider";
import { useToastActions } from "@/context/ToastContext";
import { ToastViewport } from "@/components/ToastViewport";
import { queryKeys } from "@/lib/queryKeys";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Bot, MoreHorizontal } from "lucide-react";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import {
  TaskPauseNotice,
  TaskTreeControlDialog,
  TaskTreeControlMenuItems,
} from "@/components/TaskTreeControls";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { saveDraft, clearDraft } from "@/lib/composer-draft";

type ExampleProps = {
  initialState?: "running" | "idle" | "paused" | "stopping";
  draft?: string;
  parent?: boolean;
  menuOpen?: boolean;
  confirmation?: boolean;
  stopFails?: boolean;
  cancelFails?: boolean;
  previewLoading?: boolean;
  applying?: boolean;
  mobile?: boolean;
  resumeBlocked?: boolean;
  wakeFails?: boolean;
};

function TaskExecutionExample({
  initialState = "running",
  draft = "",
  parent = true,
  menuOpen = false,
  confirmation = false,
  stopFails = false,
  cancelFails = false,
  previewLoading = false,
  applying = false,
  mobile = false,
  resumeBlocked = false,
  wakeFails = false,
}: ExampleProps) {
  const { pushToast } = useToastActions();
  const [notificationCache] = useState(() => {
    const cache = new QueryClient();
    cache.setQueryData(queryKeys.issues.detail("PAP-204"), {
      id: "task-parent",
      identifier: "PAP-204",
      companyId: "demo",
      assigneeAgentId: "alex",
    });
    cache.setQueryData(queryKeys.issues.activeRun("PAP-204"), {
      id: "alex-run",
    });
    cache.setQueryData(
      queryKeys.issues.listByDescendantRoot("demo", "task-parent"),
      [
        {
          id: "task-child",
          assigneeAgentId: "child",
          executionRunId: "child-run",
        },
      ],
    );
    return cache;
  });
  function notifyRunCancelled(agentId: string) {
    const payload = {
      runId: `${agentId}-run`,
      agentId,
      status: "cancelled",
      error: "Cancelled by control plane",
    };
    if (
      __liveUpdatesTestUtils.shouldSuppressRunStatusToastForVisibleIssue(
        notificationCache,
        "/PAP/issues/PAP-204",
        payload,
        { isForegrounded: true },
      )
    )
      return;
    const toast = __liveUpdatesTestUtils.buildRunStatusToast(
      payload,
      () => "Other task",
    );
    if (toast) pushToast(toast);
  }
  const [state, setState] = useState(initialState);
  const [menu, setMenu] = useState(menuOpen);
  const [dialog, setDialog] = useState(confirmation);
  const [mode, setMode] = useState<"resume" | "cancel" | "restore">(
    resumeBlocked || wakeFails ? "resume" : "cancel",
  );
  const [wake, setWake] = useState(true);
  const [pending, setPending] = useState(applying);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [draftKey] = useState(() => {
    const key = "paperclip:storybook:composer-stop";
    clearDraft(key);
    if (draft) saveDraft(key, draft);
    return key;
  });
  const scope = parent ? "subtree" : "leaf";
  async function pause() {
    setMenu(false);
    setState("stopping");
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (stopFails) {
      setState("running");
      throw new Error("Unable to stop. Try again.");
    }
    notifyRunCancelled("alex");
    if (parent) notifyRunCancelled("child");
    setState("paused");
  }
  function openDialog(next: typeof mode) {
    setMode(next);
    setError(null);
    setMenu(false);
    setDialog(true);
  }
  async function apply() {
    setPending(true);
    await new Promise((resolve) => setTimeout(resolve, 750));
    setPending(false);
    if (cancelFails && mode === "cancel") {
      setError("Unable to cancel tasks. Try again.");
      return;
    }
    if (mode === "resume" && resumeBlocked && wake) {
      setError(
        "Cannot wake this task until its stopped execution is reconciled. Resume without waking agents, or review the stopped run first.",
      );
      return;
    }
    setDialog(false);
    if (mode === "resume" && wakeFails && wake)
      setError(
        "Pause released, but 1 task could not start. Agent unavailable. Check the affected agent and try starting it again.",
      );
    if (mode === "cancel") {
      setCancelled(true);
      setState("idle");
    } else {
      setCancelled(false);
      setState(wake && !wakeFails ? "running" : "idle");
    }
  }
  return (
    <div className={mobile ? "mx-auto max-w-sm" : "mx-auto max-w-3xl"}>
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <span className="font-mono text-xs text-muted-foreground">PAP-204</span>
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="More task actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            <TaskTreeControlMenuItems
              scope={scope}
              canPause={state !== "paused" && !cancelled}
              canResume={state === "paused"}
              canCancel={parent && !cancelled}
              canRestore={parent && cancelled}
              pending={state === "stopping" || pending}
              onPause={() => {
                void pause().catch((err: Error) => setError(err.message));
              }}
              onResume={() => openDialog("resume")}
              onCancel={() => openDialog("cancel")}
              onRestore={() => openDialog("restore")}
            />
          </PopoverContent>
        </Popover>
      </div>
      {state === "paused" ? (
        <TaskPauseNotice
          scope={scope}
          className="mt-3"
          onResume={() => openDialog("resume")}
        />
      ) : null}
      <div className="flex flex-col gap-6 py-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">
            Polish the task conversation
          </h1>
          <p className="text-sm text-muted-foreground">
            Make it easy to send a follow-up or pause work.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Bot className="h-4 w-4" />
          <span className="font-medium">Alex</span>
          <span role="status" className="text-muted-foreground">
            {cancelled
              ? "Cancelled"
              : state === "running"
                ? "Working"
                : state === "stopping"
                  ? "Stopping…"
                  : state === "paused"
                    ? "Paused"
                    : "Ready"}
          </span>
        </div>
        <p className="text-sm">
          I’m checking the composer and the task controls. Next I’ll verify the
          interaction on mobile.
        </p>
        {parent ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>Review composer behavior</div>
            <div>Verify mobile layout</div>
          </div>
        ) : null}
        {state === "paused" || cancelled ? (
          <TaskChatMarker
            item={{
              id: "stopped-run",
              kind: "marker",
              variant: "interrupted",
              tone: "neutral",
              label: "Run cancelled",
              detail: "The run was cancelled before returning an answer.",
              collapsible: true,
              runHref: "/agents/alex/runs/stopped-run",
            }}
          />
        ) : null}
        {messages.map((message, index) => (
          <div key={index} className="rounded-md bg-muted p-3 text-sm">
            <span className="text-xs text-muted-foreground">
              {state === "running" || state === "stopping" || state === "paused"
                ? "Queued"
                : "Sent"}
            </span>
            <p>{message}</p>
          </div>
        ))}
        <TaskChatComposer
          draftKey={draftKey}
          workMode="standard"
          mobile={mobile}
          onStop={
            state === "running" || state === "stopping" ? pause : undefined
          }
          stopPending={state === "stopping"}
          stopScope={scope}
          onAdd={async (body) => {
            setMessages((current) => [...current, body]);
          }}
          onAttachImage={async (file) => ({
            id: "attachment-story",
            companyId: "company-storybook",
            issueId: "issue-story",
            issueCommentId: null,
            assetId: "asset-story",
            provider: "local",
            objectKey: "storybook-attachment.txt",
            sha256: "storybook",
            createdByAgentId: null,
            createdByUserId: "board",
            updatedAt: new Date(),
            contentPath: "/storybook-attachment.txt",
            originalFilename: file.name,
            contentType: file.type,
            byteSize: file.size,
            createdAt: new Date(),
          })}
        />
        {error && !dialog ? (
          <p
            role="alert"
            className={
              wakeFails
                ? "text-sm text-muted-foreground"
                : "text-sm text-destructive"
            }
          >
            {error}
          </p>
        ) : null}
      </div>
      <ToastViewport />
      <TaskTreeControlDialog
        open={dialog}
        onOpenChange={setDialog}
        mode={mode}
        scope={scope}
        affectedCount={parent ? 3 : 1}
        affectedAgentCount={parent ? 2 : 1}
        loading={previewLoading}
        error={error}
        pending={pending}
        valid={!previewLoading}
        wakeAgents={wake}
        onWakeAgentsChange={(wake) => { setError(null); setWake(wake); }}
        onRetry={() => setError(null)}
        onApply={() => {
          void apply();
        }}
      />
    </div>
  );
}

const meta = {
  title: "Tasks/Execution Controls",
  component: TaskExecutionExample,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskExecutionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RunningEmpty: Story = {};
export const RunningDraft: Story = {
  args: { draft: "Please check the keyboard interaction too." },
};
export const Idle: Story = { args: { initialState: "idle" } };
export const Stopping: Story = { args: { initialState: "stopping" } };
export const Paused: Story = { args: { initialState: "paused" } };
export const StopFailure: Story = { args: { stopFails: true } };
export const LeafTask: Story = { args: { parent: false } };
export const KebabMenu: Story = { args: { menuOpen: true } };
export const CancelConfirmation: Story = { args: { confirmation: true } };
export const CancelLoading: Story = {
  args: { confirmation: true, previewLoading: true },
};
export const Cancelling: Story = {
  args: { confirmation: true, applying: true },
};
export const CancelFailure: Story = {
  args: { confirmation: true, cancelFails: true },
};
export const Mobile: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const Light: Story = { globals: { theme: "light" } };
export const AttachmentOnly: Story = {
  play: async ({ canvasElement }) => {
    const input =
      canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(
      input,
      new File(["Acceptance notes"], "notes.txt", { type: "text/plain" }),
    );
    await expect(
      within(canvasElement).getByRole("button", { name: "Send" }),
    ).toBeEnabled();
    await expect(
      within(canvasElement).queryByRole("button", { name: "Stop" }),
    ).toBeNull();
  },
};
export const TypeAndClear: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeEnabled();
    const editor = canvasElement.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    )!;
    await userEvent.type(editor, "Please check mobile too.");
    await expect(canvas.getByRole("button", { name: "Send" })).toBeEnabled();
    await userEvent.clear(editor);
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeEnabled();
  },
};

export const PausedLight: Story = {
  args: { initialState: "paused" },
  globals: { theme: "light" },
};
export const PausedMobile: Story = {
  args: { initialState: "paused", mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const CancelledRunExpanded: Story = {
  args: { initialState: "paused" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run cancelled" }),
    );
    await expect(
      within(canvasElement).getByText(
        "The run was cancelled before returning an answer.",
      ),
    ).toBeVisible();
  },
};
export const StopWithoutToasts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Stop" }));
    await expect(await canvas.findByText("Subtree is paused.")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Resume subtree" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Run cancelled" }),
    ).toHaveClass("text-muted-foreground");
    await expect(
      canvas.queryByRole("button", { name: "Dismiss notification" }),
    ).toBeNull();
  },
};

export const ResumeNeedsReview: Story = {
  args: { initialState: "paused", confirmation: true, resumeBlocked: true },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(
      within(page.getByRole("dialog")).getByRole("button", {
        name: "Resume subtree",
      }),
    );
    await expect(await page.findByRole("alert")).toHaveTextContent(
      "stopped execution is reconciled",
    );
  },
};
export const ResumeWakeFailure: Story = {
  args: { initialState: "paused", confirmation: true, wakeFails: true },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(
      within(page.getByRole("dialog")).getByRole("button", {
        name: "Resume subtree",
      }),
    );
    await expect(await page.findByRole("alert")).toHaveTextContent(
      "Pause released",
    );
  },
};
