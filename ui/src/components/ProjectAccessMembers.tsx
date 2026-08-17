import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Trash2, UserPlus } from "lucide-react";
import type { Project } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";

export function ProjectAccessMembers({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const membersKey = queryKeys.projects.accessMembers(project.id);
  const membersQuery = useQuery({
    queryKey: membersKey,
    queryFn: () => projectsApi.listAccessMembers(project.id, project.companyId),
    enabled: open,
  });
  const directoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(project.companyId),
    queryFn: () => accessApi.listUserDirectory(project.companyId),
    enabled: open,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(project.companyId),
    queryFn: () => agentsApi.list(project.companyId),
    enabled: open,
  });
  const activeKeys = useMemo(
    () => new Set((membersQuery.data ?? []).map((member) => `${member.subjectType}:${member.subjectId}`)),
    [membersQuery.data],
  );
  const groups = useMemo<SearchableSelectGroup[]>(() => {
    const people = (directoryQuery.data?.users ?? [])
      .filter((entry) => entry.user && !activeKeys.has(`user:${entry.user.id}`))
      .map((entry) => ({
        key: `user:${entry.user!.id}`,
        value: `user:${entry.user!.id}`,
        label: entry.user!.name ?? entry.user!.email ?? "Unknown user",
        searchText: entry.user!.email ?? "",
      }));
    const agentOptions = (agentsQuery.data ?? [])
      .filter((agent) => !activeKeys.has(`agent:${agent.id}`))
      .map((agent) => ({ key: `agent:${agent.id}`, value: `agent:${agent.id}`, label: agent.name }));
    return [
      ...(people.length ? [{ id: "people", label: "People", options: people }] : []),
      ...(agentOptions.length ? [{ id: "agents", label: "Agents", options: agentOptions }] : []),
    ];
  }, [activeKeys, agentsQuery.data, directoryQuery.data]);
  const addMember = useMutation({
    mutationFn: async () => {
      const [subjectType, subjectId] = selection.split(/:(.+)/) as ["user" | "agent", string];
      return projectsApi.addAccessMember(project.id, { subjectType, subjectId }, project.companyId);
    },
    onSuccess: () => {
      setSelection("");
      queryClient.invalidateQueries({ queryKey: membersKey });
      pushToast({ title: "Project access added", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Couldn't add project access", body: (error as Error).message, tone: "error" }),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => projectsApi.removeAccessMember(project.id, memberId, project.companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
      pushToast({ title: "Project access removed", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Couldn't remove project access", body: (error as Error).message, tone: "error" }),
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Manage access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Private project access</DialogTitle>
            <DialogDescription>
              Members can discover this project and read every task in it. A task can still be shared directly.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {directoryQuery.isError || agentsQuery.isError ? (
              <p className="text-sm text-destructive">Couldn&apos;t load the company access directory.</p>
            ) : null}
            <div className="flex items-end gap-2">
              <SearchableSelect
                value={selection}
                groups={groups}
                onValueChange={(value) => setSelection(value)}
                placeholder="Add a person or agent"
                searchPlaceholder="Search people and agents"
                emptyMessage="No more company members to add"
                loading={directoryQuery.isLoading || agentsQuery.isLoading}
                className="min-w-0 flex-1"
              />
              <Button size="sm" disabled={!selection || addMember.isPending} onClick={() => addMember.mutate()}>
                <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> Add
              </Button>
            </div>
            <div className="divide-y divide-border/60">
              {(membersQuery.data ?? []).map((member) => {
                const isPersonalOwner = project.personalOwnerUserId === member.subjectId && member.subjectType === "user";
                return (
                  <div key={member.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{member.subjectDisplayName ?? "Unknown member"}</div>
                      <div className="text-xs text-muted-foreground">
                        {isPersonalOwner ? "Owner" : member.subjectType === "agent" ? "Agent" : "Person"}
                      </div>
                    </div>
                    {!isPersonalOwner ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${member.subjectDisplayName ?? "member"}`}
                        disabled={removeMember.isPending}
                        onClick={() => removeMember.mutate(member.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {membersQuery.isLoading ? <p className="py-3 text-sm text-muted-foreground">Loading access…</p> : null}
              {membersQuery.isError ? (
                <p className="py-3 text-sm text-destructive">Couldn&apos;t load project access members.</p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
