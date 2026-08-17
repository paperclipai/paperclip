import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Folder,
  Lock,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import type { IssueAccessGrant, IssueAccessGrantSource } from "@paperclipai/shared";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { issuesApi } from "@/api/issues";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";
import {
  agentVisibilityFromPermissions,
  grantIsRevocable,
  isSharedAgentVisibility,
} from "@/lib/issuePrivacy";

/**
 * A role-based principal that can read the task by virtue of *who they are*
 * (responsible user, creator, current assignee) rather than an explicit grant.
 * Implicit principals are shown with a muted role badge and have NO revoke —
 * you change their access by changing the role, not from the share sheet.
 * The caller derives these (it holds the agent/user directories); the sheet
 * only renders them.
 */
export interface ShareSheetImplicitPrincipal {
  id: string;
  displayName: string;
  roleLabel: string;
  subtitle?: string | null;
  avatarUrl?: string | null;
  initials?: string | null;
}

interface SourceBadgeSpec {
  label: string;
  icon: typeof UserPlus;
  className: string;
}

// Source badges map 1:1 to `grant.source`. Colors mirror the approved
// wireframe: explicit = blue, assignment = green, project = violet.
const SOURCE_BADGES: Record<IssueAccessGrantSource, SourceBadgeSpec> = {
  explicit: {
    label: "shared directly",
    icon: UserPlus,
    className:
      "border-blue-300/70 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300",
  },
  assignment: {
    label: "via assignment",
    icon: Check,
    className:
      "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  project: {
    label: "via project",
    icon: Folder,
    className:
      "border-violet-300/70 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
  },
};

function SourceBadge({ source }: { source: IssueAccessGrantSource }) {
  const spec = SOURCE_BADGES[source];
  const Icon = spec.icon;
  return (
    <span
      data-testid={`grant-source-badge-${source}`}
      data-source={source}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-nano) font-medium leading-tight",
        spec.className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {spec.label}
    </span>
  );
}

function PrincipalAvatar({
  displayName,
  avatarUrl,
  initials,
}: {
  displayName: string;
  avatarUrl?: string | null;
  initials?: string | null;
}) {
  return (
    <Avatar size="sm" className="mt-0.5">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
      <AvatarFallback>{initials ?? displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function RowShell({
  avatar,
  title,
  subtitle,
  badge,
  action,
}: {
  avatar: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge}
        </div>
        {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

export function IssueShareSheet({
  issueId,
  companyId,
  canManage,
  open,
  onOpenChange,
  aclDescription = "Controls who can read this task, its comments, documents, and run history.",
  implicitPrincipals = [],
  initialView = "list",
  initialAddSelection = "",
}: {
  issueId: string;
  companyId: string;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aclDescription?: string;
  implicitPrincipals?: ShareSheetImplicitPrincipal[];
  /** Initial panel — `add` opens straight into the add flow (stories/tests). */
  initialView?: "list" | "add";
  /** Pre-selected add subject (`type:id`), used by stories/tests to show the caution. */
  initialAddSelection?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [view, setView] = useState<"list" | "add">(initialView);
  const [addSelection, setAddSelection] = useState<string>(initialAddSelection);
  const [revokeTarget, setRevokeTarget] = useState<IssueAccessGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: queryKeys.issues.accessGrants(issueId),
    queryFn: () => issuesApi.listAccessGrants(issueId),
    enabled: open,
  });
  const directoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: open && view === "add" && canManage,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open && view === "add" && canManage,
  });

  const activeGrants = useMemo(
    () => (grantsQuery.data ?? []).filter((grant) => grant.revokedAt === null),
    [grantsQuery.data],
  );
  const grantedSubjectKeys = useMemo(
    () => new Set(activeGrants.map((grant) => `${grant.subjectType}:${grant.subjectId}`)),
    [activeGrants],
  );

  const addMutation = useMutation({
    mutationFn: (payload: { subjectType: "user" | "agent"; subjectId: string }) =>
      issuesApi.createAccessGrant(issueId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.accessGrants(issueId) });
      setAddSelection("");
      setView("list");
      pushToast({ title: "Access granted", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Couldn't add access", body: (error as Error).message, tone: "error" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (grant: IssueAccessGrant) => issuesApi.revokeAccessGrant(issueId, grant.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.accessGrants(issueId) });
      setRevokeTarget(null);
      pushToast({ title: "Access revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Couldn't revoke access", body: (error as Error).message, tone: "error" });
    },
  });

  // Candidate subjects for the "Add someone" combobox, minus anyone who already
  // holds an active grant. Value encodes both type and id: `type:id`.
  const addGroups = useMemo<SearchableSelectGroup[]>(() => {
    const users = (directoryQuery.data?.users ?? [])
      .filter((entry) => entry.user && !grantedSubjectKeys.has(`user:${entry.user.id}`))
      .map((entry) => ({
        key: `user:${entry.user!.id}`,
        value: `user:${entry.user!.id}`,
        label: entry.user!.name ?? entry.user!.email ?? "Unknown user",
        searchText: [entry.user!.name, entry.user!.email].filter(Boolean).join(" "),
      }));
    const agents = (agentsQuery.data ?? [])
      .filter((agent) => !grantedSubjectKeys.has(`agent:${agent.id}`))
      .map((agent) => ({
        key: `agent:${agent.id}`,
        value: `agent:${agent.id}`,
        label: agent.name,
        searchText: agent.name,
      }));
    const groups: SearchableSelectGroup[] = [];
    if (users.length > 0) groups.push({ id: "people", label: "People", options: users });
    if (agents.length > 0) groups.push({ id: "agents", label: "Agents", options: agents });
    return groups;
  }, [directoryQuery.data, agentsQuery.data, grantedSubjectKeys]);

  // Is the currently-selected add subject a *shared* agent? Drives the caution.
  const selectedSharedAgentName = useMemo(() => {
    if (!addSelection.startsWith("agent:")) return null;
    const agentId = addSelection.slice("agent:".length);
    const agent = (agentsQuery.data ?? []).find((candidate) => candidate.id === agentId);
    if (!agent) return null;
    return isSharedAgentVisibility(agentVisibilityFromPermissions(agent.permissions))
      ? agent.name
      : null;
  }, [addSelection, agentsQuery.data]);

  function resetAndClose(next: boolean) {
    if (!next) {
      setView("list");
      setAddSelection("");
      setRevokeTarget(null);
    }
    onOpenChange(next);
  }

  function submitAdd() {
    if (!addSelection) return;
    const [subjectType, subjectId] = addSelection.split(/:(.+)/) as ["user" | "agent", string];
    if (!subjectId) return;
    addMutation.mutate({ subjectType, subjectId });
  }

  const isLoading = grantsQuery.isLoading;
  const isError = grantsQuery.isError;
  const isEmpty = !isLoading && !isError && activeGrants.length === 0 && implicitPrincipals.length === 0;

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            Who can access this task
          </DialogTitle>
          <DialogDescription>{aclDescription}</DialogDescription>
        </DialogHeader>

        {view === "list" ? (
          <div className="space-y-1">
            {isLoading ? (
              <div className="space-y-2 py-1" data-testid="share-sheet-loading">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-2.5 py-1">
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-2.5 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : isError ? (
              <div
                className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                data-testid="share-sheet-error"
              >
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Couldn't load access.
                </span>
                <Button variant="ghost" size="sm" onClick={() => grantsQuery.refetch()}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                </Button>
              </div>
            ) : isEmpty ? (
              <p className="py-3 text-sm text-muted-foreground" data-testid="share-sheet-empty">
                Only you can see this task.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {implicitPrincipals.map((principal) => (
                  <RowShell
                    key={`implicit:${principal.id}`}
                    avatar={
                      <PrincipalAvatar
                        displayName={principal.displayName}
                        avatarUrl={principal.avatarUrl}
                        initials={principal.initials}
                      />
                    }
                    title={principal.displayName}
                    subtitle={principal.subtitle ?? undefined}
                    badge={
                      <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-(length:--text-nano) font-medium text-muted-foreground">
                        {principal.roleLabel}
                      </span>
                    }
                  />
                ))}
                {activeGrants.map((grant) => {
                  const displayName = grant.subjectDisplayName ?? "Unknown";
                  const revocable = canManage && grantIsRevocable(grant.source);
                  const granter = grant.source === "explicit" ? "Shared" : "Granted";
                  return (
                    <RowShell
                      key={grant.id}
                      avatar={
                        <PrincipalAvatar
                          displayName={displayName}
                          avatarUrl={grant.subjectAvatarUrl}
                          initials={grant.subjectInitials}
                        />
                      }
                      title={displayName}
                      subtitle={`${granter} ${timeAgo(grant.createdAt)}`}
                      badge={<SourceBadge source={grant.source} />}
                      action={
                        revocable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setRevokeTarget(grant)}
                          >
                            Revoke
                          </Button>
                        ) : grant.source === "project" ? (
                          <span className="text-(length:--text-nano) text-muted-foreground">
                            project-managed
                          </span>
                        ) : null
                      }
                    />
                  );
                })}
              </div>
            )}

            {canManage ? (
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setView("add")}
                  disabled={isLoading}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> Add someone
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <SearchableSelect
              value={addSelection}
              groups={addGroups}
              onValueChange={(value) => setAddSelection(value)}
              placeholder="Choose a person or agent…"
              searchPlaceholder="Search people and agents…"
              loading={directoryQuery.isLoading || agentsQuery.isLoading}
              loadingMessage="Loading directory…"
              emptyMessage="No one left to add."
              triggerClassName="w-full"
            />

            {selectedSharedAgentName ? (
              <div
                role="note"
                aria-label="Shared agent caution"
                data-testid="shared-agent-caution"
                className="flex items-start gap-2 rounded-md border border-amber-400/70 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-semibold">Shared agent.</span> {selectedSharedAgentName}'s
                  memory &amp; workspace may carry residual private context from this task into its
                  later runs for other people. Grant only if that's acceptable.
                </span>
              </div>
            ) : null}

            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium text-foreground">Access is sticky.</span> It lasts until
                you revoke it — unassignment or completion won't remove it.
              </span>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setView("list");
                  setAddSelection("");
                }}
              >
                Back
              </Button>
              <Button size="sm" onClick={submitAdd} disabled={!addSelection || addMutation.isPending}>
                {addMutation.isPending ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {revokeTarget?.subjectDisplayName ?? "this subject"}'s access?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes {revokeTarget?.subjectDisplayName ?? "them"}'s assignment and direct
              grants on this task and all its subtasks. They'll get a not-found error the next time
              they try to read it. This does <span className="font-semibold">not</span> erase context
              already in their memory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (revokeTarget) revokeMutation.mutate(revokeTarget);
              }}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
