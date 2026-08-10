import { useMemo, useState, type ComponentProps } from "react";
import type { Issue, IssueCollaborator } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Globe, Lock, Plus, User, X } from "lucide-react";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { IssueProperties as TaskIssueProperties } from "./issue-properties";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type IssuePropertiesProps = ComponentProps<typeof TaskIssueProperties>;

type CollaboratorCandidate = {
  id: string;
  principalType: "agent" | "user";
  label: string;
};

function collaboratorLabel(args: {
  collaborator: IssueCollaborator;
  agents: Awaited<ReturnType<typeof agentsApi.list>> | undefined;
  users: Awaited<ReturnType<typeof accessApi.listUserDirectory>>["users"] | undefined;
}) {
  const { collaborator, agents, users } = args;
  if (collaborator.principalType === "agent") {
    return agents?.find((agent) => agent.id === collaborator.principalId)?.name
      ?? collaborator.displayName
      ?? collaborator.principalId.slice(0, 8);
  }
  const user = users?.find((entry) => (entry.user?.id ?? entry.principalId) === collaborator.principalId)?.user;
  return user?.name ?? user?.email ?? collaborator.displayName ?? collaborator.email ?? "User";
}

function IssueAccessControls({ issue, inline }: { issue: Issue; inline?: boolean }) {
  const queryClient = useQueryClient();
  const companyId = issue.companyId;
  const [confirmCompanyVisible, setConfirmCompanyVisible] = useState(false);
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: collaborators = [] } = useQuery({
    queryKey: queryKeys.issues.collaborators(issue.id),
    queryFn: () => issuesApi.listCollaborators(issue.id),
    enabled: Boolean(issue.id),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: Boolean(companyId),
  });

  const invalidateAccess = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.collaborators(issue.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    if (companyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
    }
  };

  const updateVisibility = useMutation({
    mutationFn: (input: { visibility: "private" | "company"; confirmed?: boolean }) =>
      issuesApi.updateVisibility(issue.id, input.visibility, input.confirmed),
    onSuccess: () => {
      invalidateAccess();
      setConfirmCompanyVisible(false);
    },
  });
  const addCollaborator = useMutation({
    mutationFn: (candidate: CollaboratorCandidate) =>
      issuesApi.addCollaborator(issue.id, candidate.principalType, candidate.id),
    onSuccess: () => {
      invalidateAccess();
      setCollaboratorsOpen(false);
      setSearch("");
    },
  });
  const removeCollaborator = useMutation({
    mutationFn: (collaborator: IssueCollaborator) =>
      issuesApi.removeCollaborator(issue.id, collaborator.principalType, collaborator.principalId),
    onSuccess: invalidateAccess,
  });

  const candidates = useMemo<CollaboratorCandidate[]>(() => {
    const existing = new Set(collaborators.map((collaborator) => `${collaborator.principalType}:${collaborator.principalId}`));
    const users = (directory?.users ?? [])
      .map((entry) => ({
        id: entry.user?.id ?? entry.principalId,
        principalType: "user" as const,
        label: entry.user?.name ?? entry.user?.email ?? entry.principalId,
      }))
      .filter((candidate) => !existing.has(`user:${candidate.id}`));
    const activeAgents = (agents ?? [])
      .filter((agent) => agent.status !== "terminated")
      .map((agent) => ({ id: agent.id, principalType: "agent" as const, label: agent.name }))
      .filter((candidate) => !existing.has(`agent:${candidate.id}`));
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return [...users, ...activeAgents].filter((candidate) =>
      !normalizedSearch || candidate.label.toLocaleLowerCase().includes(normalizedSearch),
    );
  }, [agents, collaborators, directory?.users, search]);

  return (
    <section
      className={cn(
        "space-y-2 border-t border-border pt-3",
        inline ? "mt-3" : "mt-4",
      )}
      aria-label="Issue access"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Visibility</div>
          <p className="text-xs text-muted-foreground">
            {issue.visibility === "private" ? "Only collaborators can access this task." : "Everyone in the company can access this task."}
          </p>
        </div>
        {issue.visibility === "private" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setConfirmCompanyVisible(true)}
            disabled={updateVisibility.isPending}
          >
            <Lock className="mr-1.5 h-3.5 w-3.5" />
            Private
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => updateVisibility.mutate({ visibility: "private" })}
            disabled={updateVisibility.isPending}
          >
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Company
          </Button>
        )}
      </div>

      {issue.visibility === "private" ? (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Collaborators</span>
            <Popover
              open={collaboratorsOpen}
              onOpenChange={(open) => {
                setCollaboratorsOpen(open);
                if (!open) setSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-2" align="end">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search users or agents..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="mt-2 max-h-56 overflow-auto">
                  {candidates.length === 0 ? (
                    <p className="px-2 py-3 text-sm text-muted-foreground">No available collaborators.</p>
                  ) : candidates.map((candidate) => (
                    <button
                      key={`${candidate.principalType}:${candidate.id}`}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => addCollaborator.mutate(candidate)}
                    >
                      {candidate.principalType === "agent" ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                      <span className="truncate">{candidate.label}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          {collaborators.length === 0 ? (
            <p className="text-sm text-muted-foreground">No collaborators yet.</p>
          ) : (
            <div className="space-y-1">
              {collaborators.map((collaborator) => (
                <div key={collaborator.id} className="group flex min-w-0 items-center gap-2 text-sm">
                  {collaborator.principalType === "agent" ? <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">
                    {collaboratorLabel({ collaborator, agents, users: directory?.users })}
                  </span>
                  <span className="text-xs text-muted-foreground">{collaborator.reason}</span>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 focus:opacity-100"
                    title="Remove collaborator"
                    aria-label={`Remove ${collaboratorLabel({ collaborator, agents, users: directory?.users })}`}
                    onClick={() => removeCollaborator.mutate(collaborator)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <Dialog open={confirmCompanyVisible} onOpenChange={setConfirmCompanyVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make this task visible to the whole company?</DialogTitle>
            <DialogDescription>
              Anyone in the company will be able to see this task, its comments, documents, and attachments. You can make it private again later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmCompanyVisible(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={updateVisibility.isPending}
              onClick={() => updateVisibility.mutate({ visibility: "company", confirmed: true })}
            >
              Make company-visible
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Keeps the fork's per-task privacy/collaboration controls alongside the
 * upstream task-properties surface (watchdogs, plans, artifacts, and durable
 * confirmation actions).
 */
export function IssueProperties(props: IssuePropertiesProps) {
  return (
    <>
      <TaskIssueProperties {...props} />
      <IssueAccessControls issue={props.issue} inline={props.inline} />
    </>
  );
}
