import { useEffect, useId, useState } from "react";
import { Bot, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { clearDraft, saveDraft } from "@/lib/composer-draft";
import { cn } from "@/lib/utils";

/** Design-only takeover. No task APIs or production composer behavior change. */
export function PausedTaskComposer({
  subtree = false,
  hasDraft = false,
  pending = false,
  error = false,
  onResume,
}: {
  subtree?: boolean;
  hasDraft?: boolean;
  pending?: boolean;
  error?: boolean;
  onResume: () => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={pending}
      data-testid="paused-composer-takeover"
      className="flex flex-col gap-4 rounded-(--radius-task-composer) border border-(--status-agent-paused)/40 bg-(--status-agent-paused)/10 p-(--sz-18px)"
    >
      <div className="flex items-start gap-3">
        <Pause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--status-task-icon-todo)" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            {subtree ? "Subtree is paused." : "Task is paused."}
          </h2>
          <p className="text-sm text-muted-foreground">
            {subtree
              ? "Resume this subtree to send a message."
              : "Resume this task to send a message."}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t resume. Your task is still paused. Try again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {hasDraft ? (
          <p className="mr-auto text-xs text-muted-foreground">Your draft is saved.</p>
        ) : null}
        <Button
          size="sm"
          disabled={pending}
          onClick={onResume}
          className="bg-(--status-agent-paused) text-foreground hover:bg-(--status-agent-paused)/80 dark:text-background"
        >
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
          {pending ? "Resuming…" : subtree ? "Resume subtree" : "Resume task"}
        </Button>
      </div>
    </section>
  );
}

export type PausedComposerPreviewProps = {
  subtree?: boolean;
  draft?: string;
  initialState?: "paused" | "resuming" | "error";
  composerOnly?: boolean;
  mobile?: boolean;
};

export function PausedComposerPreview({
  subtree = false,
  draft = "",
  initialState = "paused",
  composerOnly = false,
  mobile = false,
}: PausedComposerPreviewProps) {
  const [state, setState] = useState<string>(initialState);
  const [messages, setMessages] = useState<string[]>([]);
  const [draftKey] = useState(() => {
    const key = `paperclip:storybook:paused-takeover:${crypto.randomUUID()}`;
    if (draft) saveDraft(key, draft);
    return key;
  });
  useEffect(() => () => clearDraft(draftKey), [draftKey]);
  useEffect(() => {
    // The loading story stays pending. Interactive resumes complete locally.
    if (state !== "resuming" || initialState === "resuming") return;
    const timer = window.setTimeout(() => setState("ready"), 700);
    return () => window.clearTimeout(timer);
  }, [state, initialState]);

  return (
    <div className={cn("mx-auto flex w-full flex-col gap-8 p-6", mobile ? "max-w-sm" : "max-w-3xl")}>
      {!composerOnly ? (
        <>
          <div className="flex flex-col gap-3 border-b border-border pb-6">
            <span className="font-mono text-xs text-muted-foreground">PAP-204</span>
            <h1 className="text-xl font-semibold">Polish the task conversation</h1>
          </div>
          <div className="flex justify-end">
            <p className="max-w-sm rounded-xl bg-muted px-4 py-3 text-sm">
              Check the composer and make sure follow-ups work well on mobile.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm">
              <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="font-medium">Alex</span>
            </div>
            <p className="text-sm leading-relaxed">
              I’ve reviewed the composer layout. Next I’ll check the keyboard
              interaction and spacing on smaller screens.
            </p>
          </div>
        </>
      ) : null}
      {messages.map((message, index) => (
        <p key={index} className="self-end rounded-xl bg-muted px-4 py-3 text-sm">{message}</p>
      ))}
      {state === "ready" ? (
        <TaskChatComposer
          workMode="standard"
          draftKey={draftKey}
          mobile={mobile}
          placeholder="Send a message to Alex…"
          onAdd={(body) => setMessages((current) => [...current, body])}
        />
      ) : (
        <PausedTaskComposer
          subtree={subtree}
          hasDraft={Boolean(draft)}
          pending={state === "resuming"}
          error={state === "error"}
          onResume={() => setState("resuming")}
        />
      )}
    </div>
  );
}
