import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TaskChatComposerDockProps {
  children: ReactNode;
  mobile: boolean;
  streamlined: boolean;
  concealed?: boolean;
}

/** The task thread and its Storybook phone previews share the same composer spacing. */
export function TaskChatComposerDock({ children, mobile, streamlined, concealed = false }: TaskChatComposerDockProps) {
  return <div
    data-testid="task-chat-composer-dock"
    inert={concealed}
    aria-hidden={concealed || undefined}
    className={cn(
      "sticky flex max-w-(--tc-shell-max-w) flex-col gap-2",
      concealed && "invisible",
      mobile
        ? cn(
            "mobile-nav-composer bottom-(--tc-composer-bottom) z-20 w-auto px-1 pb-1",
            streamlined ? "-mx-2" : "mx-2",
          )
        : "bottom-0 z-10 mx-auto w-full px-1 pb-1 md:px-4 md:pb-2",
      streamlined && "md:px-0 md:pb-0",
      (!streamlined || mobile) &&
        "bg-background/80 pt-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 dark:bg-transparent dark:backdrop-blur-none dark:supports-[backdrop-filter]:bg-transparent",
    )}
  >
    {children}
  </div>;
}
