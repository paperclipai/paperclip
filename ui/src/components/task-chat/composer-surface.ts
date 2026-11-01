import { cn } from "@/lib/utils";

export function taskChatComposerSurfaceClasses(mobile: boolean, streamlined: boolean) {
  return cn(
    streamlined
      ? "paperclip-task-chat-composer rounded-(--radius-task-composer) border border-border bg-card p-(--sz-18px) shadow-(--shadow-task-composer) dark:border-0 dark:bg-muted dark:shadow-none"
      : "paperclip-task-chat-composer rounded-xl bg-card p-(--sz-18px)",
    mobile && "p-3",
  );
}
