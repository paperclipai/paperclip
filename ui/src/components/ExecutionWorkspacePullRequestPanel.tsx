import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ExecutionWorkspace,
  ExecutionWorkspacePullRequestRecord,
  PullRequestPolicy,
} from "@paperclipai/shared";
import { AlertTriangle, Loader2, RefreshCcw, SkipForward } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";
import { Button } from "./ui/button";
import { ExecutionWorkspacePullRequestBadge } from "./ExecutionWorkspacePullRequestBadge";

export const UI_STUCK_THRESHOLD_MS = 30 * 60 * 1000;

function fieldRow(label: string, value: React.ReactNode) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs sm:text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs">{value}</span>
    </div>
  );
}

function formatMaybe(value: string | null | undefined, fallback = "—"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value;
}

export function ExecutionWorkspacePullRequestPanel({
  workspace,
  policy,
}: {
  workspace: ExecutionWorkspace;
  policy: PullRequestPolicy | null;
}) {
  const record = useMemo<ExecutionWorkspacePullRequestRecord | null>(() => {
    const metadata = workspace.metadata;
    const raw = metadata && typeof metadata === "object" && "pullRequest" in metadata
      ? (metadata as { pullRequest?: unknown }).pullRequest
      : null;
    if (!raw || typeof raw !== "object") return null;
    return raw as ExecutionWorkspacePullRequestRecord;
  }, [workspace.metadata]);

  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [markSkippedOpen, setMarkSkippedOpen] = useState(false);
  const [markSkippedNote, setMarkSkippedNote] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspace.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(workspace.id) });
  };

  const replayMutation = useMutation({
    mutationFn: () => executionWorkspacesApi.requestPullRequest(workspace.id),
    onSuccess: (response) => {
      invalidate();
      // The server only re-emits `pull_request_requested` when the
      // record is still in `requested`. Reflect what actually
      // happened so an operator pressing Replay on a record that has
      // already moved to `opened`/`merged` is not misled by a
      // misleading success toast.
      if (response.replayed) {
        pushToast({
          title: "Re-emitted pull-request request",
          body: "Subscribed consumers will be re-notified.",
          tone: "success",
        });
      } else {
        pushToast({
          title: "No re-emit needed",
          body: `Pull-request record is ${response.pullRequest.status}; no event sent.`,
          tone: "info",
        });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Replay failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const markSkippedMutation = useMutation({
    mutationFn: () =>
      executionWorkspacesApi.recordPullRequestResult(workspace.id, {
        status: "skipped",
        ...(markSkippedNote.trim() ? { error: markSkippedNote.trim() } : {}),
      }),
    onSuccess: () => {
      invalidate();
      setMarkSkippedOpen(false);
      setMarkSkippedNote("");
      pushToast({ title: "Pull-request record marked skipped", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Mark skipped failed",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!policy && !record) return null;

  const requestedAt = record?.requestedAt ? new Date(record.requestedAt) : null;
  const resolvedAt = record?.resolvedAt ? new Date(record.resolvedAt) : null;
  const deadlineMs =
    record && record.mode === "blocking" && requestedAt && typeof record.policy?.archiveTimeoutMs === "number"
      ? requestedAt.getTime() + record.policy.archiveTimeoutMs
      : null;
  const isStuck =
    record?.mode === "blocking" &&
    workspace.status === "in_review" &&
    requestedAt !== null &&
    Date.now() - requestedAt.getTime() >= UI_STUCK_THRESHOLD_MS;

  const canReplay = record?.status === "requested";
  const canMarkSkipped =
    record?.mode === "blocking" && (record.status === "requested" || record.status === "opened");

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-muted/20 px-3 py-3 sm:px-4 sm:py-4"
      data-testid="execution-workspace-pull-request-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Pull request</h3>
          {record ? <ExecutionWorkspacePullRequestBadge record={record} /> : null}
        </div>
        {policy?.draft ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            Draft
          </span>
        ) : null}
      </header>

      {!record && policy ? (
        <p className="text-xs text-muted-foreground sm:text-sm">
          Project policy requests a pull request when this workspace is archived
          {policy.requireResultBeforeArchive
            ? " and blocks archive on a terminal result."
            : "."}
        </p>
      ) : null}

      {record ? (
        <div className="space-y-2">
          {fieldRow("Mode", record.mode === "blocking" ? "Blocking" : "Fire-and-forget")}
          {fieldRow("Requested", requestedAt ? formatDateTime(requestedAt) : "—")}
          {fieldRow("Resolved", resolvedAt ? formatDateTime(resolvedAt) : "—")}
          {fieldRow("Target branch", formatMaybe(record.policy?.targetBranch ?? workspace.baseRef))}
          {fieldRow("Source branch", formatMaybe(workspace.branchName))}
          {record.url
            ? fieldRow(
                "URL",
                <a
                  href={record.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all underline"
                >
                  {record.url}
                </a>,
              )
            : null}
          {record.number !== null && record.number !== undefined
            ? fieldRow("Number", `#${record.number}`)
            : null}
          {record.sha ? fieldRow("Merge SHA", record.sha) : null}
          {record.error ? fieldRow("Error", record.error) : null}
          {deadlineMs ? fieldRow("Deadline", formatDateTime(new Date(deadlineMs))) : null}
        </div>
      ) : null}

      {isStuck && record ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 sm:text-sm"
          data-testid="execution-workspace-pull-request-stuck-banner"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            Waiting on external PR resolution since {requestedAt ? relativeTime(requestedAt) : "earlier"}.
            {record.url ? (
              <>
                {" "}
                <a href={record.url} target="_blank" rel="noreferrer noopener" className="underline">
                  Open PR
                </a>
                .
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {(canReplay || canMarkSkipped) && !markSkippedOpen ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {canReplay ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => replayMutation.mutate()}
              disabled={replayMutation.isPending}
              data-testid="execution-workspace-pull-request-replay"
            >
              {replayMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCcw className="mr-1.5 h-3 w-3" />
              )}
              Replay request
            </Button>
          ) : null}
          {canMarkSkipped ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMarkSkippedOpen(true)}
              data-testid="execution-workspace-pull-request-mark-skipped"
            >
              <SkipForward className="mr-1.5 h-3 w-3" />
              Mark skipped
            </Button>
          ) : null}
        </div>
      ) : null}

      {markSkippedOpen ? (
        <div className="space-y-2 rounded-lg border border-border bg-background px-3 py-2">
          <p className="text-xs text-muted-foreground sm:text-sm">
            Mark this pull-request record skipped. The workspace will transition to archived.
          </p>
          <textarea
            className="min-h-[64px] w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs sm:text-sm"
            placeholder="Optional operator note (stored on record.error)"
            value={markSkippedNote}
            onChange={(event) => setMarkSkippedNote(event.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setMarkSkippedOpen(false);
                setMarkSkippedNote("");
              }}
              disabled={markSkippedMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => markSkippedMutation.mutate()}
              disabled={markSkippedMutation.isPending}
            >
              {markSkippedMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : null}
              Confirm mark skipped
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
