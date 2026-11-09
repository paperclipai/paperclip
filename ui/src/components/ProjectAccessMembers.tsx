import { AgentAvatar } from "./AgentAvatar";
import { Identity } from "./Identity";
import { renderAccessIdentity, type AccessSelectOption } from "./AccessSelectIdentity";
import { agentVisibilityFromPermissions, isSharedAgentVisibility } from "@/lib/issuePrivacy";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Trash2, UserPlus } from "lucide-react";
import type { Project } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { describeError } from "@/api/errors";
import { useQueryView } from "@/components/QueryView";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect, type SearchableSelectGroup } from "@/components/SearchableSelect";
import { useTranslation } from "@/i18n";

export function ProjectAccessMembers({ project, canManage }: { project: Project; canManage: boolean }) {
  const { t } = useTranslation();
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
  // Read all three through the shared view: cached data stays usable during a
  // transient refetch failure,and a no-data failure drops into readable copy.

  const membersView = useQueryView(membersQuery);
  const directoryView = useQueryView(directoryQuery);
  const agentsView = useQueryView(agentsQuery);
  const membersWaiting = ["loading", "reconnecting"].includes(membersView.kind);
  const activeKeys = useMemo(
    () => new Set((membersQuery.data ?? []).map((member) => `${member.subjectType}:${member.subjectId}`)),
    [membersQuery.data],
  );
  const groups = useMemo<SearchableSelectGroup<string, AccessSelectOption>[]>(() => {
    const people = (directoryQuery.data?.users ?? [])
      .filter((entry) => entry.user && !activeKeys.has(`user:${entry.user.id}`))
      .map((entry) => ({
        key: `user:${entry.user!.id}`,
        value: `user:${entry.user!.id}`,
        label: entry.user!.name ?? entry.user!.email ?? t("projects.ProjectAccessMembers.unknownUser"),
        searchText: entry.user!.email ?? "",
        identity: <Identity name={entry.user!.name ?? entry.user!.email ?? t("projects.ProjectAccessMembers.unknownUser")} avatarUrl={entry.user!.image} size="sm" />,
      }));
    const agentOptions = (agentsQuery.data ?? [])
      .filter((agent) => !activeKeys.has(`agent:${agent.id}`))
      .map((agent) => ({ key: `agent:${agent.id}`, value: `agent:${agent.id}`, label: agent.name, identity: <><AgentAvatar agent={agent} size={24} /><span className="truncate">{agent.name}</span></> }));
    return [
      ...(people.length ? [{ id: "people", label: t("projects.ProjectAccessMembers.peopleGroup"), options: people }] : []),
      ...(agentOptions.length ? [{ id: "agents", label: t("projects.ProjectAccessMembers.agentsGroup"), options: agentOptions }] : []),
    ];
  }, [activeKeys, agentsQuery.data, directoryQuery.data, t]);
  const selectedAgent = selection.startsWith("agent:")
    ? agentsQuery.data?.find(agent => agent.id === selection.slice("agent:".length)) : null;
  const sharingWithSharedAgent = selectedAgent
    && isSharedAgentVisibility(agentVisibilityFromPermissions(selectedAgent.permissions));
  const addMember = useMutation({
    mutationFn: async () => {
      const [subjectType, subjectId] = selection.split(/:(.+)/) as ["user" | "agent", string];
      return projectsApi.addAccessMember(project.id, { subjectType, subjectId }, project.companyId);
    },
    onSuccess: () => {
      setSelection("");
      queryClient.invalidateQueries({ queryKey: membersKey });
      // Project membership changes task access, descendants and cached discovery.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      pushToast({ title: t("projects.ProjectAccessMembers.accessAdded"), tone: "success" });
    },
    onError: (error) => pushToast({ title: t("projects.ProjectAccessMembers.addAccessFailed"), body: describeError(error).body, tone: "error" }),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => projectsApi.removeAccessMember(project.id, memberId, project.companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
      // Project membership changes task access, descendants and cached discovery.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      pushToast({ title: t("projects.ProjectAccessMembers.accessRemoved"), tone: "success" });
    },
    onError: (error) => pushToast({ title: t("projects.ProjectAccessMembers.removeAccessFailed"), body: describeError(error).body, tone: "error" }),
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-3.5 w-3.5" aria-hidden="true" /> {canManage ? t("projects.ProjectAccessMembers.manageAccess") : t("projects.ProjectAccessMembers.viewAccess")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("projects.ProjectAccessMembers.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("projects.ProjectAccessMembers.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {directoryView.kind === "error" || agentsView.kind === "error" ? (
              <p className="text-sm text-destructive">{t("projects.ProjectAccessMembers.directoryError")}</p>
            ) : null}
            <div className="flex items-end gap-2">
              <SearchableSelect
                value={selection}
                groups={groups}
                renderValue={(option) => option ? renderAccessIdentity(option) : t("projects.ProjectAccessMembers.addPersonOrAgent")}
                renderOption={renderAccessIdentity}
                onValueChange={(value) => setSelection(value)}
                placeholder={t("projects.ProjectAccessMembers.addPersonOrAgent")}
                searchPlaceholder={t("projects.ProjectAccessMembers.searchPeopleAndAgents")}
                emptyMessage={t("projects.ProjectAccessMembers.noMoreMembers")}
                loading={[directoryView.kind, agentsView.kind].some(kind => ["loading", "reconnecting"].includes(kind))}
                className="min-w-0 flex-1"
              />
              <Button size="sm" disabled={!canManage || !selection || addMember.isPending} onClick={() => addMember.mutate()}>
                <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> Add
              </Button>
            </div>
            {sharingWithSharedAgent ? (
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
                {t("projects.ProjectAccessMembers.sharedAgentWarning")}
              </p>
            ) : null}
            <div className="divide-y divide-border/60">
              {(membersQuery.data ?? []).map((member) => {
                const isPersonalOwner = member.subjectType === "user" && [project.personalOwnerUserId, project.privacyOwnerUserId].includes(member.subjectId);
                return (
                  <div key={member.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{member.subjectDisplayName ?? t("projects.ProjectAccessMembers.unknownMember")}</div>
                      <div className="text-xs text-muted-foreground">
                        {isPersonalOwner ? t("projects.ProjectAccessMembers.roleOwner") : member.subjectType === "agent" ? t("projects.ProjectAccessMembers.roleAgent") : t("projects.ProjectAccessMembers.rolePerson")}
                      </div>
                    </div>
                    {!isPersonalOwner ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("projects.ProjectAccessMembers.removeMember", { name: member.subjectDisplayName ?? t("projects.ProjectAccessMembers.memberFallback") })}
                        disabled={!canManage || removeMember.isPending}
                        onClick={() => removeMember.mutate(member.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {membersWaiting ? <p className="py-3 text-sm text-muted-foreground">{t("projects.ProjectAccessMembers.loadingAccess")}</p> : null}
              {membersView.kind === "error" ? (
                <p className="py-3 text-sm text-destructive">{t("projects.ProjectAccessMembers.membersError")}</p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
