import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TaskChatComposerDock } from "./TaskChatComposerDock";
import { taskChatComposerSurfaceClasses } from "./composer-surface";

export function TaskChatLoadingShell({ mobile, streamlined, coordinator, composerConcealed = false }: {
  mobile: boolean;
  streamlined: boolean;
  coordinator: boolean;
  composerConcealed?: boolean;
}) {
  return <div
    data-testid="task-chat-loading-frame"
    role="status"
    aria-label="Loading conversation"
    className="task-chat-loading-shell relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
  >
    <div aria-hidden="true" className={cn(
      "mx-auto flex min-h-0 w-full max-w-(--tc-shell-max-w) flex-1 flex-col gap-6 overflow-hidden px-4 pt-3",
      streamlined && "md:px-0",
    )}>
      <div className="space-y-3">
        <div data-slot="task-loading-title" className={cn("space-y-3", coordinator ? "text-2xl font-normal" : "text-xl font-semibold", "leading-normal")}>
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-6 w-3/5" />
        </div>
        <div className="flex h-6 items-center gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-6 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-16 w-3/4 shrink-0" />
      <Skeleton className="h-24 w-4/5 shrink-0 self-end" />
      <Skeleton className="h-16 w-3/4 shrink-0" />
    </div>
    <TaskChatComposerDock mobile={mobile} streamlined={streamlined} concealed={composerConcealed} placeholder>
      <div aria-hidden="true" className={taskChatComposerSurfaceClasses(mobile, streamlined)}>
        <div className="flex min-h-(--sz-48px) items-start px-1 py-1">
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="mt-2 flex h-8 items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-8 w-8 rounded-md" />
        </div>
      </div>
    </TaskChatComposerDock>
  </div>;
}
