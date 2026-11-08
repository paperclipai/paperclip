import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { clearDraft, saveDraft } from "@/lib/composer-draft";
import { cn } from "@/lib/utils";

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
      <TaskChatComposer
        workMode="standard"
        draftKey={draftKey}
        mobile={mobile}
        placeholder="Send a message to Alex…"
        pause={state === "ready" ? null : {
          scope: subtree ? "subtree" : "leaf",
          pending: state === "resuming",
          error: state === "error" ? "Couldn’t resume. Your task is still paused. Try again." : null,
          onResume: () => setState("resuming"),
        }}
        onAdd={(body) => setMessages((current) => [...current, body])}
      />
    </div>
  );
}
