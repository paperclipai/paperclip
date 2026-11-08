import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** The inset strip shared by queued messages and new-task context. */
export function TaskChatComposerBar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative z-0 mx-3 -mb-px overflow-hidden rounded-t-xl rounded-b-none border border-b-0 border-border/75 bg-card shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
