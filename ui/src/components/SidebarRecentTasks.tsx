import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, MoreHorizontal, Pencil, RefreshCw } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useSidebar } from "@/context/SidebarContext";
import { useOptionalToastActions } from "@/context/ToastContext";
import {
  updateRecentTaskSnapshots,
  type RecentTaskEntry,
} from "@/lib/recent-tasks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";

const RECENT_TASK_MENU_ITEM_CLASS =
  "h-(--profile-popover-row-height) gap-(--profile-popover-row-gap) rounded-lg px-2.5 py-0 text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) focus:bg-accent/50 focus:text-foreground";
const RESTART_WAKE_RETRY_STORAGE_SUFFIX = ":restart-wake-retry";

function restartWakeRetryStorageKey(storageKey: string | null) {
  return storageKey ? `${storageKey}${RESTART_WAKE_RETRY_STORAGE_SUFFIX}` : null;
}

function readRestartWakeRetryIssueIds(storageKey: string | null) {
  if (!storageKey) return new Set<string>();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function setRestartWakeRetryPending(storageKey: string | null, issueId: string, pending: boolean) {
  if (!storageKey) return;
  const issueIds = readRestartWakeRetryIssueIds(storageKey);
  if (pending) issueIds.add(issueId);
  else issueIds.delete(issueId);
  try {
    if (issueIds.size > 0) window.localStorage.setItem(storageKey, JSON.stringify([...issueIds]));
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Recent Tasks remains usable when browser storage is unavailable.
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function SidebarRecentTasks({
  companyId,
  liveIssueIds,
}: {
  companyId: string | null | undefined;
  liveIssueIds: ReadonlySet<string>;
}) {
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const { data: session, isPending } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  if (!companyId || isPending) return null;

  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  return (
    <RecentTasksList
      key={`${companyId}:${userId ?? "__local_board__"}`}
      companyId={companyId}
      userId={userId}
      liveIssueIds={liveIssueIds}
      rail={rail}
    />
  );
}

function RecentTasksList({
  companyId,
  userId,
  liveIssueIds,
  rail,
}: {
  companyId: string;
  userId: string | null;
  liveIssueIds: ReadonlySet<string>;
  rail: boolean;
}) {
  const { entries, storageKey } = useRecentTasks({ companyId, userId });
  const queryClient = useQueryClient();
  const toastActions = useOptionalToastActions();
  const [renameEntry, setRenameEntry] = useState<RecentTaskEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingAction, setPendingAction] = useState<"rename" | "archive" | "pause" | null>(null);
  const restartRetryStorageKey = restartWakeRetryStorageKey(storageKey);

  if (entries.length === 0) return null;

  const refreshIssueQueries = async (issueId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) }),
    ]);
  };

  const beginRename = (entry: RecentTaskEntry) => {
    setRenameEntry(entry);
    setRenameValue(entry.title);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = renameValue.trim();
    if (!renameEntry || !nextTitle || nextTitle === renameEntry.title) {
      setRenameEntry(null);
      return;
    }

    setPendingAction("rename");
    try {
      const updated = await issuesApi.update(renameEntry.id, { title: nextTitle });
      queryClient.setQueryData(queryKeys.issues.detail(renameEntry.id), updated);
      if (storageKey) updateRecentTaskSnapshots(storageKey, companyId, [updated]);
      await refreshIssueQueries(renameEntry.id);
      setRenameEntry(null);
      toastActions?.pushToast({ title: "Task renamed", tone: "success" });
    } catch (error) {
      toastActions?.pushToast({
        title: "Task rename failed",
        body: errorMessage(error, "Unable to rename this task."),
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const archiveTask = async (entry: RecentTaskEntry) => {
    setPendingAction("archive");
    try {
      await issuesApi.archiveFromInbox(entry.id);
      await refreshIssueQueries(entry.id);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
      toastActions?.pushToast({ title: "Task archived from inbox", tone: "success" });
    } catch (error) {
      toastActions?.pushToast({
        title: "Task archive failed",
        body: errorMessage(error, "Unable to archive this task from the inbox."),
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  };

  const toggleTaskPause = async (entry: RecentTaskEntry) => {
    setPendingAction("pause");
    try {
      const state = await issuesApi.getTreeControlState(entry.id);
      if (state.activePauseHold?.isRoot) {
        const restartIssue = await issuesApi.get(entry.id);
        setRestartWakeRetryPending(restartRetryStorageKey, entry.id, true);
        await issuesApi.releaseTreeHold(entry.id, state.activePauseHold.holdId, {
          reason: "Restarted from Recent Tasks.",
        });
        if (restartIssue.assigneeAgentId) {
          const wakeResult = await agentsApi.wakeup(
            restartIssue.assigneeAgentId,
            {
              source: "assignment",
              triggerDetail: "manual",
              reason: "recent_task_restart",
              payload: { issueId: restartIssue.id },
            },
            restartIssue.companyId,
          );
          if (!("id" in wakeResult)) {
            throw new Error(wakeResult.message ?? "The assignee wake was skipped.");
          }
        }
        setRestartWakeRetryPending(restartRetryStorageKey, entry.id, false);
        toastActions?.pushToast({ title: "Task restarted", tone: "success" });
      } else if (state.activePauseHold) {
        throw new Error("This task is paused by a parent task. Restart it from the pause root.");
      } else if (readRestartWakeRetryIssueIds(restartRetryStorageKey).has(entry.id)) {
        const restartIssue = await issuesApi.get(entry.id);
        if (restartIssue.assigneeAgentId) {
          const wakeResult = await agentsApi.wakeup(
            restartIssue.assigneeAgentId,
            {
              source: "assignment",
              triggerDetail: "manual",
              reason: "recent_task_restart_retry",
              payload: { issueId: restartIssue.id },
            },
            restartIssue.companyId,
          );
          if (!("id" in wakeResult)) {
            throw new Error(wakeResult.message ?? "The assignee wake was skipped.");
          }
        }
        setRestartWakeRetryPending(restartRetryStorageKey, entry.id, false);
        toastActions?.pushToast({ title: "Task restarted", tone: "success" });
      } else {
        await issuesApi.createTreeHold(entry.id, {
          mode: "pause",
          reason: "Paused from Recent Tasks.",
          releasePolicy: { strategy: "manual" },
        });
        toastActions?.pushToast({ title: "Task paused", tone: "success" });
      }
      await queryClient.invalidateQueries({
        queryKey: ["issues", "tree-control-state", entry.id],
      });
    } catch (error) {
      toastActions?.pushToast({
        title: "Task pause update failed",
        body: errorMessage(error, "Unable to pause or restart this task."),
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <>
      <SidebarSection label="Recent Tasks">
        {entries.map((entry) => (
          <div key={entry.id} className="group/recent-task relative">
            <SidebarNavItem
              to={`/issues/${entry.id}`}
              label={entry.title}
              className={rail ? undefined : "pr-10"}
              liveCount={liveIssueIds.has(entry.id) ? 1 : undefined}
            />
            {!rail ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`More actions for ${entry.title}`}
                    className="absolute right-2 top-(--pct-50) z-10 -translate-y-(--pct-50) text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100 group-hover/recent-task:opacity-100 group-focus-within/recent-task:opacity-100 data-[state=open]:bg-accent data-[state=open]:text-foreground data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="w-(--profile-popover-width) rounded-xl p-1.5 shadow-(--shadow-profile-popover)"
                >
                  <DropdownMenuItem
                    className={RECENT_TASK_MENU_ITEM_CLASS}
                    onSelect={() => beginRename(entry)}
                  >
                    <Pencil aria-hidden="true" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={RECENT_TASK_MENU_ITEM_CLASS}
                    disabled={pendingAction !== null}
                    onSelect={() => void archiveTask(entry)}
                  >
                    <Archive aria-hidden="true" />
                    Archive
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={RECENT_TASK_MENU_ITEM_CLASS}
                    disabled={pendingAction !== null}
                    onSelect={() => void toggleTaskPause(entry)}
                  >
                    <RefreshCw aria-hidden="true" />
                    Pause/Restart
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ))}
      </SidebarSection>

      <Dialog
        open={renameEntry !== null}
        onOpenChange={(open) => {
          if (!open && pendingAction !== "rename") setRenameEntry(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={(event) => void submitRename(event)}>
            <DialogHeader>
              <DialogTitle>Rename task</DialogTitle>
              <DialogDescription>Choose a short, clear name for this task.</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              aria-label="Task name"
              value={renameValue}
              disabled={pendingAction === "rename"}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pendingAction === "rename"}
                onClick={() => setRenameEntry(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pendingAction === "rename" || !renameValue.trim()}
              >
                {pendingAction === "rename" ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
