import { t, useTranslation, i18n } from "@/i18n";
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

export function ProjectAccessMembers({ project, canManage }: { project: Project; canManage: boolean }) {
  useTranslation("task-components");
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
        label: entry.user!.name ?? entry.user!.email ?? t("final-components-a:unknownUser_0bca6947"),
        searchText: entry.user!.email ?? "",
        identity: <Identity name={entry.user!.name ?? entry.user!.email ?? t("final-components-a:unknownUser_0bca6947")} avatarUrl={entry.user!.image} size="sm" />,
      }));
    const agentOptions = (agentsQuery.data ?? [])
      .filter((agent) => !activeKeys.has(`agent:${agent.id}`))
      .map((agent) => ({ key: `agent:${agent.id}`, value: `agent:${agent.id}`, label: agent.name, identity: <><AgentAvatar agent={agent} size={24} /><span className="truncate">{agent.name}</span></> }));
    return [
      ...(people.length ? [{ id: "people", label: t("task-components:people_7db20897"), options: people }] : []),
      ...(agentOptions.length ? [{ id: "agents", label: t("task-components:agents_279b44d2"), options: agentOptions }] : []),
    ];
  }, [activeKeys, agentsQuery.data, directoryQuery.data, i18n.language]);
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
      pushToast({ presentation: { title: { key: "task-components:projectAccessAdded_c956962c" } },  title: t("task-components:projectAccessAdded_c956962c"), tone: "success" });
    },
    onError: (error) => pushToast({ presentation: { title: { key: "task-components:couldnTAddProjectAccess_a70132bf" } },  title: t("task-components:couldnTAddProjectAccess_a70132bf"), body: describeError(error).body, tone: "error" }),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => projectsApi.removeAccessMember(project.id, memberId, project.companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
      // Project membership changes task access, descendants and cached discovery.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      pushToast({ presentation: { title: { key: "task-components:projectAccessRemoved_f5d408d6" } },  title: t("task-components:projectAccessRemoved_f5d408d6"), tone: "success" });
    },
    onError: (error) => pushToast({ presentation: { title: { key: "task-components:couldnTRemoveProjectAccess_91d62d34" } },  title: t("task-components:couldnTRemoveProjectAccess_91d62d34"), body: describeError(error).body, tone: "error" }),
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-3.5 w-3.5" aria-hidden="true" /> {canManage ? t("task-components:manageAccess_a90527b6") : t("task-components:viewAccess_f5462009")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("task-components:privateProjectAccess_ab9cb1a8")}</DialogTitle>
            <DialogDescription>{t("task-components:membersCanDiscoverThisProjectAndRead_9ed11996")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {directoryView.kind === "error" || agentsView.kind === "error" ? (
              <p className="text-sm text-destructive">{t("task-components:couldnTLoadTheCompanyAccessDirectory_3ee13571")}</p>
            ) : null}
            <div className="flex items-end gap-2">
              <SearchableSelect
                value={selection}
                groups={groups}
                renderValue={(option) => option ? renderAccessIdentity(option) : t("final-components-a:addAPersonOrAgent_1ac1ed51")}
                renderOption={renderAccessIdentity}
                onValueChange={(value) => setSelection(value)}
                placeholder={t("task-components:addAPersonOrAgent_1ac1ed51")}
                searchPlaceholder={t("final-components-a:searchPeopleAndAgents_cdc7a830")}
                emptyMessage={t("task-components:noMoreCompanyMembersToAdd_45d47fb9")}
                loading={[directoryView.kind, agentsView.kind].some(kind => ["loading", "reconnecting"].includes(kind))}
                className="min-w-0 flex-1"
              />
              <Button size="sm" disabled={!canManage || !selection || addMember.isPending} onClick={() => addMember.mutate()}>
                <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />{" "}{t("task-components:add_9fd728c6")}</Button>
            </div>
            {sharingWithSharedAgent ? (
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">{t("task-components:thisAgentCanRetainPrivateProjectContext_47560927")}</p>
            ) : null}
            <div className="divide-y divide-border/60">
              {(membersQuery.data ?? []).map((member) => {
                const isPersonalOwner = member.subjectType === "user" && [project.personalOwnerUserId, project.privacyOwnerUserId].includes(member.subjectId);
                return (
                  <div key={member.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{member.subjectDisplayName ?? t("task-components:unknownMember_29824c5a")}</div>
                      <div className="text-xs text-muted-foreground">
                        {isPersonalOwner ? t("task-components:owner_4b1b8aa3") : member.subjectType === "agent" ? t("task-components:agent_11b39c93") : t("task-components:person_6007db63")}
                      </div>
                    </div>
                    {!isPersonalOwner ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("task-components:remove_d2f6b9b7", { value1: member.subjectDisplayName ?? "member" })}
                        disabled={!canManage || removeMember.isPending}
                        onClick={() => removeMember.mutate(member.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {membersWaiting ? <p className="py-3 text-sm text-muted-foreground">{t("task-components:loadingAccess_a55b4d69")}</p> : null}
              {membersView.kind === "error" ? (
                <p className="py-3 text-sm text-destructive">{t("task-components:couldnTLoadProjectAccessMembers_9569287e")}</p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
