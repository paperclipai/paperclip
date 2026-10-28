import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TaskChatComposerDockProps {
  children: ReactNode;
  mobile: boolean;
  streamlined: boolean;
  concealed?: boolean;
}

/** A normal flex footer beside the message scroller, on desktop and mobile. */
export function TaskChatComposerDock({ children, mobile, streamlined, concealed = false }: TaskChatComposerDockProps) {
  return <div
    data-testid="task-chat-composer-dock"
    data-conversation-typography=""
    inert={concealed}
    aria-hidden={concealed || undefined}
    className={cn(
      "flex max-w-(--tc-shell-max-w) shrink-0 flex-col gap-2",
      concealed && "invisible",
      mobile
        ? cn("w-auto px-1 pb-1", streamlined ? "-mx-2" : "mx-2")
        : "mx-auto w-full px-1 pb-1 md:px-4 md:pb-2",
      streamlined && "md:px-0 md:pb-0",
      (!streamlined || mobile) &&
        "bg-background/80 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 dark:bg-transparent dark:backdrop-blur-none dark:supports-[backdrop-filter]:bg-transparent",
    )}
  >
    {children}
  </div>;
}
