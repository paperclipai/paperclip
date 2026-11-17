import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ToolConnectionStoredContent } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function storedContentSummary(content: ToolConnectionStoredContent, appName: string): string {
  const { toolCalls, runs } = content.stored;
  if (toolCalls === 0) return `Paperclip has no saved results from ${appName}'s tool calls.`;
  return runs > 0
    ? `Paperclip will delete what it saved from ${plural(toolCalls, "tool call", "tool calls")} and the full transcripts of ${plural(runs, "run", "runs")} that used ${appName}.`
    : `Paperclip will delete what it saved from ${plural(toolCalls, "tool call", "tool calls")} to ${appName}.`;
}

export function storedContentStatus(content: ToolConnectionStoredContent): string | null {
  const deletion = content.deletion;
  if (deletion?.status === "pending") {
    return deletion.retrying
      ? "Deleting was interrupted. Paperclip keeps trying until it finishes."
      : "Deleting now. You can close this window.";
  }
  if (deletion?.status === "completed" && deletion.completedAt) {
    const skipped = deletion.counts.runsInProgress;
    return skipped > 0
      ? `Last deleted ${relativeTime(deletion.completedAt)}. ${plural(skipped, "run was", "runs were")} still working and kept their data.`
      : `Last deleted ${relativeTime(deletion.completedAt)}.`;
  }
  return null;
}

export function StoredContentDeletionRow({ connectionId, appName }: { connectionId: string; appName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div>
        <p className="text-sm font-medium text-foreground">Delete data read through this app</p>
        <p className="text-xs text-muted-foreground">
          Permanently removes the results and run transcripts Paperclip saved from this app's tool calls.
        </p>
      </div>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete data
      </Button>
      {open ? (
        <StoredContentDeletionDialog connectionId={connectionId} appName={appName} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

export function StoredContentDeletionDialog({
  connectionId,
  appName,
  onClose,
}: {
  connectionId: string;
  appName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const query = useQuery({
    queryKey: queryKeys.tools.connectionStoredContent(connectionId),
    queryFn: () => toolsApi.getStoredContent(connectionId),
    refetchInterval: (current) => current.state.data?.deletion?.status === "pending" ? 2_000 : false,
  });
  const deletion = useMutation({
    mutationFn: () => toolsApi.deleteStoredContent(connectionId),
    onSuccess: (content) => {
      queryClient.setQueryData(queryKeys.tools.connectionStoredContent(connectionId), content);
    },
    onError: (error) => pushToast({ title: "Couldn't delete the data", body: describeError(error).body, tone: "error" }),
  });
  const content = query.data;
  const pending = deletion.isPending || content?.deletion?.status === "pending";
  const nothingStored = content ? content.stored.toolCalls === 0 : true;
  const inProgress = content?.stored.runsInProgress ?? 0;
  const status = content ? storedContentStatus(content) : null;

  return (
    <AlertDialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete data read through ${appName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {content ? storedContentSummary(content, appName) : "Counting saved data…"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {query.error ? (
          <p role="alert" className="text-sm text-destructive">{describeError(query.error).body}</p>
        ) : null}
        {content && !nothingStored ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Whole transcripts are deleted, including other steps of those runs. Tasks, comments and files your agents wrote are kept. Call times, sizes and outcomes stay in the activity history.</p>
            {inProgress > 0 ? (
              <p>{`${plural(inProgress, "run is", "runs are")} still working and will be skipped. Delete again after ${inProgress === 1 ? "it finishes" : "they finish"}.`}</p>
            ) : null}
            <p className="font-medium text-foreground">This cannot be undone.</p>
          </div>
        ) : null}
        {status ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {content?.deletion?.status === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {status}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{pending || nothingStored ? "Close" : "Cancel"}</AlertDialogCancel>
          {!nothingStored ? (
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={pending || !content}
              onClick={(event) => {
                event.preventDefault();
                deletion.mutate();
              }}
            >
              {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Delete data
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
