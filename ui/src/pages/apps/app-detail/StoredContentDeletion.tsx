import { useEffect, useRef, useState } from "react";
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
  const { toolCalls, approvals, appViews, runs } = content.stored;
  const parts = [
    toolCalls > 0 ? plural(toolCalls, "tool call", "tool calls") : null,
    approvals > 0 ? plural(approvals, "approval request", "approval requests") : null,
    appViews > 0 ? plural(appViews, "app view", "app views") : null,
    runs > 0 ? `the full transcripts of ${plural(runs, "run", "runs")}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return `Paperclip found no saved data from ${appName}'s tool calls. You can still delete to check again.`;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Paperclip will delete what it saved from ${list} that used ${appName}${runs > 0 ? " or received its results" : ""}.`;
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
  const countsKey = queryKeys.tools.connectionStoredContent(connectionId);
  const statusKey = queryKeys.tools.connectionStoredContentDeletion(connectionId);
  const query = useQuery({
    queryKey: countsKey,
    queryFn: () => toolsApi.getStoredContent(connectionId),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const [tracking, setTracking] = useState(false);
  const watching = tracking || query.data?.deletion?.status === "pending";
  const statusQuery = useQuery({
    queryKey: statusKey,
    queryFn: () => toolsApi.getStoredContentDeletion(connectionId),
    enabled: watching,
    refetchInterval: (current) => current.state.data?.deletion?.status === "completed" ? false : 2_000,
  });
  const latest = statusQuery.data?.deletion ?? query.data?.deletion ?? null;
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!watching || latest?.status !== "completed" || refreshedFor.current === latest.id) return;
    refreshedFor.current = latest.id;
    setTracking(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionStoredContent(connectionId) });
  }, [watching, latest?.status, latest?.id, queryClient, connectionId]);
  const deletion = useMutation({
    mutationFn: () => toolsApi.deleteStoredContent(connectionId),
    onSuccess: (result) => {
      queryClient.setQueryData(statusKey, result);
      setTracking(true);
    },
    onError: (error) => pushToast({ title: "Couldn't delete the data", body: describeError(error).body, tone: "error" }),
  });
  const content = query.data ? { ...query.data, deletion: latest } : undefined;
  const pending = deletion.isPending || latest?.status === "pending";
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
        {content ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Whole transcripts are deleted, including other steps of those runs. Call times, sizes and outcomes stay in the activity history.</p>
            <p className="font-medium text-foreground">This does not remove anything your agents wrote into tasks, such as comments, documents and files. Delete or edit those yourself.</p>
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
          <AlertDialogCancel autoFocus>{pending ? "Close" : "Cancel"}</AlertDialogCancel>
          {content ? (
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={pending || !content || query.isFetching}
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
